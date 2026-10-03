/**
 * Stockage des sessions, externalise dans PostgreSQL.
 *
 * POURQUOI CE CHANGEMENT
 * ----------------------
 * Les sessions vivaient dans un `Map` du processus API. Ce choix avait deux
 * conséquences concrètes, subies en competition :
 *
 *  1. Un redemarrage de l'API — deploiement, plantage du processus, bascule de
 *     version — invalidait TOUTES les sessions. Le jury devait se reconnecter
 *     en meme temps, sur plusieurs dizaines de postes, au pire moment de la
 *     journee. Tout deploiement devenait un risque de service.
 *
 *  2. L'etat n'etait partage par rien. Deux instances d'API ne se connaissaient
 *     pas : mettre l'API a l'echelle derriere un repartiteur de charge
 *     imposait des « sticky sessions », donc l'impossibilite de remplacer un
 *     processus sans couper l'acces de ses clients. Le point de passage unique
 *     etait structurel, pas accidentel.
 *
 * Le bus LISTEN/NOTIFY avait deja resolu le meme probleme pour la diffusion
 * evenementielle. Les sessions relevent de la meme contrainte : un etat qui
 * doit survivre au processus et etre partage entre instances.
 *
 * CE QUE LA BASE NE DOIT PAS CONTENIR
 * ----------------------------------
 * Le jeton, en clair, n'est PAS stocke. Seul `sha256(jeton)` l'est.
 *
 * Le raisonnement : une session volee ne se vole pas seulement pendant sa
 * duree de vie. Une lecture de la table — une sauvegarde, un dump, le journal
 * des requetes, un attaquant ayant obtenu un acces en lecture, ou le snapshot
 * de sauvegarde de l'hebergeur — se transformerait sinon en une collection de
 * jetons directement reutilisables pendant 12 heures. En ne stockant que
 * l'empreinte, une telle lecture ne donne rien d'exploitable : retraverser
 * sha256 n'est pas realisable.
 *
 * Ce n'est qu'une defense en profondeur, pas une garantie suffisante. La table
 * est protegee par les memes droits que le reste de la base, et une empreinte
 * reste un oracle de verification. Le gain est neanmoins net : la fuite la
 * plus banale — un backup entre de bonnes mains — devient inoffensive.
 *
 * LE CACHE MEMOIRE
 * ----------------
 * `verifySession` est sur le chemin chaud : chaque requete authentifiee, et
 * chaque message WebSocket. Une lecture de table a chaque passage serait
 * s'ajoutee a une requete qui relit DEJA `users` pour revalider l'activation et
 * le role — comportement existant et volontairement conserve. Le cache evite la
 * lecture supplementaire, pas la revalidation.
 *
 * Le cache ne doit jamais servir une decision de revocation : voir
 * `revokeAllSessionsForUser`, qui l'invalide explicitement.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { sessions, users } from '../db/schema.ts';
import { CONFIG } from '../config.ts';
import { metrics } from './metrics.ts';
import { createLogger } from './logger.ts';
import type { AuthenticatedUser, UserRole } from '../types.ts';

const log = createLogger('sessions');

/** Empreinte stockee : hex(sha256(jeton)). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Genere un jeton de session : 32 octets aleatoires (256 bits) en base64url.
 *
 * Un jeton devinable n'est pas un scenario d'ecoute reseau — `/api/auth/login`
 * est en HTTPS, et le jeton ne transite que dans l'en-tete `Authorization`
 * chiffre — mais un scenario d'injection SQL ou de fuite de journal. 256 bits
 * rendent l'un et l'autre hors de portee sans surcout notable.
 */
export function generateToken(): string {
  return `${CONFIG.TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Cache de premier niveau
// ---------------------------------------------------------------------------

interface CacheEntry {
  user: AuthenticatedUser;
  /** Fin de validite du CACHE — sans rapport avec la duree de vie de la session. */
  cacheUntil: number;
  /** Expiration REELLE de la session, lue en base. */
  sessionExpiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function readCache(tokenHash: string): AuthenticatedUser | null {
  const hit = cache.get(tokenHash);
  if (!hit) return null;

  // Les DEUX bornes sont verifiees. Ne tester que `cacheUntil` laisserait
  // accepter un jeton echue pendant toute la fenetre de cache : une session
  // dont l'expiration tombe alors qu'elle est en cache resterait valable
  // jusqu'a 30 s de trop. C'est la meme raison qui impose de tester
  // l'expiration en base, appliquee au cache.
  const now = Date.now();
  if (hit.cacheUntil <= now || hit.sessionExpiresAt <= now) {
    // On NE prolonge PAS `cacheUntil` a chaque lecture : sans cela, une
    // session utilisee en permanence ne quitterait jamais le cache, et le
    // processus garderait en memoire ce que la table est venue lui retirer.
    cache.delete(tokenHash);
    return null;
  }
  return hit.user;
}

function writeCache(
  tokenHash: string,
  user: AuthenticatedUser,
  sessionExpiresAt: number
): void {
  cache.set(tokenHash, {
    user,
    cacheUntil: Date.now() + CONFIG.SESSION_CACHE_TTL_MS,
    sessionExpiresAt,
  });
}

/** Vide le cache. Utilise a la revocation, et par les tests. */
export function clearSessionCache(): void {
  cache.clear();
}

/** Nombre d'entrees en cache — pour le diagnostic. */
export function cachedSessionCount(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Ouvre une session. Le jeton en clair ne quitte jamais ce processus. */
export async function createSession(
  user: AuthenticatedUser,
  context: { ip?: string | null; userAgent?: string | null } = {}
): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = Date.now() + CONFIG.SESSION_TTL_MS;

  await db.insert(sessions).values({
    tokenHash,
    userId: user.id,
    expiresAt: new Date(expiresAt),
    ip: context.ip ?? null,
    // Borne a 256 caracteres : le user-agent est une donnee tierce de longueur
    // libre, et la colonne ne sert qu'a l'affichage. Sans borne, un client
    // pourrait ecrire plusieurs dizaines de kilo-octets par session — une
    // amplification de la base sans aucun interet.
    userAgent: context.userAgent ? context.userAgent.slice(0, 256) : null,
  });

  writeCache(tokenHash, user, expiresAt);
  metrics.sessionsCreated.inc();
  return token;
}

/** Recharge un compte actif par identifiant interne. */
async function loadActiveUser(id: number): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  if (!row || !row.active) return null;
  return {
    id: row.id,
    uid: '', // Legacy Firebase UID - plus utilisé
    name: row.name,
    email: row.email,
    role: row.role as UserRole,
    active: row.active,
  };
}

/**
 * Resout une session et revalide le compte.
 *
 * La relecture de `users` n'est pas une precaution excessive : la session ne
 * porte QUE l'identifiant du compte. Sans elle, un compte desactive ou
 * retrograde conserverait ses droits jusqu'a l'expiration du jeton — 12 heures
 * durant lesquelles un administrateur ne peut pas faire respecter sa decision.
 * C'est le comportement deja en place avant le passage en base, conserve a
 * l'identique.
 *
 * Note sur la comparaison : la recherche se fait par egalite exacte sur
 * l'empreinte, pas par `timingSafeEqual`. Une verification supplementaire a
 * temps constant n'apporterait rien — la ligne est deja selectionnee par
 * egalite sur le hachage, et retoucher le jeton apres coup comparerait une
 * valeur a elle-meme. Ce serait de la securite de theatre : le cout resterait
 * et le garantie, elle, serait deja la plus faible possible — l'egalite sur
 * une empreinte n'est pas une comparaison constante.
 *
 * @returns l'utilisateur authentifie, ou null si la session est absente,
 *          echue, ou le compte invalide.
 */
export async function verifySession(token: string): Promise<AuthenticatedUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const cached = readCache(tokenHash);
  if (cached) {
    // La revalidation en base reste obligatoire meme sur un cache valide :
    // c'est elle qui fait respecter une desactivation ou un changement de role.
    // Le cache n'evite que la lecture de la table `sessions`.
    const fresh = await loadActiveUser(cached.id);
    if (!fresh) {
      await revokeSession(token);
      return null;
    }
    return fresh;
  }

  const [row] = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    // Session echue : on la supprime maintenant plutot que d'attendre la purge.
    // Sans cela, une session echue resterait jusqu'au balayage suivant, et la
    // ligne occuperait de l'espace pour rien.
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    cache.delete(tokenHash);
    return null;
  }

  const fresh = await loadActiveUser(row.userId);
  if (!fresh) {
    // Le compte a disparu ou est desactive : la session ne peut plus servir.
    await revokeSession(token);
    return null;
  }

  writeCache(tokenHash, fresh, row.expiresAt.getTime());
  return fresh;
}

/** Revoque une session. Silence si elle n'existe pas. */
export async function revokeSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .returning({ userId: sessions.userId });

  cache.delete(tokenHash);
  if (deleted.length > 0) metrics.sessionsRevoked.inc();
}

/**
 * Revoque TOUTES les sessions d'un compte.
 *
 * A appeler des qu'un compte est desactive, retrograde ou supprime.
 *
 * L'invalidation du cache n'est pas optionnelle. Le cache vit 30 s : sans
 * cette suppression explicite, l'acces d'un compte desactive survivrait
 * jusqu'a 30 s — exactement la fenetre que la revalidation en base ne resorbe
 * pas, puisque la presence en cache court-circuite la lecture de session.
 *
 * @returns le nombre de sessions revoquees.
 */
export async function revokeAllSessionsForUser(userId: number): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ tokenHash: sessions.tokenHash });

  for (const { tokenHash } of deleted) cache.delete(tokenHash);

  if (deleted.length > 0) {
    metrics.sessionsRevoked.inc({}, deleted.length);
    log.info('Sessions révoquées', { utilisateur: userId, sessions: deleted.length });
  }
  return deleted.length;
}

/** Nombre de sessions ouvertes — alimente `aeerks_sessions_active`. */
export async function countActiveSessions(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sessions)
    .where(sql`${sessions.expiresAt} > now()`);
  return row?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

/**
 * Purge les sessions echues, par tranches.
 *
 * Le `LIMIT` interne n'est pas decoratif : sans lui, une base ayant accumule
 * des dizaines de milliers de sessions echues (arrêt de plusieurs jours) ferait
 * tenir le DELETE assez longtemps pour retenir des verrous et ralentir les
 * requetes legitimement en cours. La purge rend la main regulierement.
 */
export async function purgeExpiredSessions(batchSize = 5_000): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(
      sql`ctid IN (
             SELECT ctid FROM sessions
             WHERE expires_at < now()
             LIMIT ${batchSize}
           )`
    )
    .returning({ tokenHash: sessions.tokenHash });

  for (const { tokenHash } of deleted) cache.delete(tokenHash);
  return deleted.length;
}

let purgeTimer: NodeJS.Timeout | null = null;

/**
 * Demarre la purge periodique.
 *
 * L'echec est absorbe : une purge qui ne reussit pas (base indisponible) ne
 * doit pas crasher le processus, et la boucle reste a sa periode normale — pas
 * de rejeu serré qui martelerait une base deja en difficulty. Une purge qui
 * echoue laisse des lignes echues ; elles sont ecartees a la verification par
 * le test d'expiration, donc l'absence de purge degrade l'espace occupe, pas
 * la securite.
 */
export function startSessionPurge(): void {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => {
    void purgeExpiredSessions()
      .then((n) => {
        if (n > 0) log.debug('Sessions expirées purgées', { nombre: n });
      })
      .catch((err) => {
        metrics.dbErrors.inc({ operation: 'session-purge' });
        log.warn('Purge des sessions échouée', { err });
      });
  }, CONFIG.SESSION_SWEEP_INTERVAL_MS);
  purgeTimer.unref();
}

/** Arrete la purge (tests, arret du processus). */
export function stopSessionPurge(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}

/** Sessions echues dont la ligne peut etre supprimee — pour le diagnostic. */
export async function countExpiredSessions(): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sessions)
    .where(lt(sessions.expiresAt, new Date()));
  return row?.total ?? 0;
}