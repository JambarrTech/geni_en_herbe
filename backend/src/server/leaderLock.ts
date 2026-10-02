import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger.ts';

const log = createLogger('worker');

/**
 * Verrou de leader pour le worker de chrono.
 *
 * Le problème
 * -----------
 * La boucle de chrono décompte le temps et écrit en base chaque seconde. Deux
 * workers qui tournent en parallèle ne se contentent pas de doubler le travail :
 * ils se disputent la même ligne de match. Le second peut remettre a zero le
 * décompte, avancer la question courante, ou clôturer un match — pendant que le
 * premier fait l'inverse. Le résultat est un état incohérent, difficile à
 * diagnostiquer parce qu'il est intermittent.
 *
 * Pourquoi un verrou PostgreSQL
 * -----------------------------
 * La base est la seule ressource partagée entre les instances, et elle est déjà
 * là : aucune infrastructure supplémentaire, pas de service de coordination à
 * exploiter. `pg_try_advisory_lock` est conçu pour exactement cela.
 *
 * Deux propriétés utilisées :
 *  - le verrou est lié à la CONNEXION, pas au process. Si le worker meurt, la
 *    connexion se ferme et PostgreSQL libère le verrou : pas de verrou orphelin
 *    à nettoyer à la main après un `kill -9` ;
 *  - `pg_try_advisory_lock` ne bloque pas. Un worker qui n'obtient pas le verrou
 *    le Signale et attend, au lieu de geler au démarrage : l'orchestrateur voit
 *    un processus vivant mais inactif, ce qui vaut mieux qu'un démarrage
 *    silencieux.
 *
 * Le client est donc DEDIE et doit etre maintenu ouvert. On ne recycle pas le
 * pool : le verrou lui serait retiré.
 */
export interface LeaderLock {
  /** Vrai tant que ce process détient le verrou. */
  readonly held: boolean;
  /** Relâche le verrou et ferme la connexion dédiée. */
  release: () => Promise<void>;
}

/**
 * Clé de verrou. Le nombre est arbitraire mais DOIT rester stable : changer la
 * clé fait coexistir deux workers estimant leaders de verrouctions différentes.
 */
const LOCK_KEY = 0x41454552; // « AEER » en ASCII

/**
 * CONTRAINTE DE DEPLOIEMENT — A NE PAS IGNORER
 * ---------------------------------------------
 * Un verrou consultatif est attache a une SESSION PostgreSQL, pas a une requete
 * ni a une connexion logique du client. Il faut donc une connexion DIRECTE, ou
 * un pooler en mode SESSION.
 *
 * Derriere un pooler en mode TRANSACTION (PgBouncer `pool_mode=transaction`,
 * qui est le defaut de Neon, Supabase, RDS Proxy…), les sessions serveur sont
 * reassignees d'un client a l'autre : le verrou peut etre libere par un client
 * qui n'en est pas proprietaire, ou rester acquis a une session qui ne sert plus
 * personne. Le worker semblerait leader tout en ayant perdu le verrou — c'est-a-
 * dire exactement l'etat dangereux qu'on voulait empecher.
 *
 * Verification a faire au deploiement : `DATABASE_URL` doit pointer vers la
 * connexion DIRECTE. Les deux formes de pooler se reconnaisent, et il faut les
 * deux (cf. `estConnexionDirecte`) :
 *  - par option d'URL : `pgbouncer=true`, `pool_mode=transaction` ;
 *  - par NOM D'HOTE : l'endpoint pooler de Neon s'appelle `...-pooler....`
 *    ou `....pooler....`, et son URL ne porte AUCUNE de ces options.
 *
 * Le second cas est celui qui compte en pratique : le tableau de bord Neon
 * propose la chaine poolee juste a cote de la directe, sans la moindre option
 * d'URL pour la distinguer. Un garde-fou qui ne reconnait que les options la
 * laisse passer, et l'echec qu'il devait empecher se produit quand meme — mais
 * sans le message qui aurait Explique pourquoi.
 *
 * Le worker ouvre sa propre connexion pour le verrou, hors du pool applicatif :
 * c'est deja le cas, et c'est ce qui rend cette contrainte respectee tant que
 * l'URL n'est pas un point d'entree de pooler.
 */

/**
 * Vrai si l'URL designe la connexion DIRECTE, et non un pooler en mode
 * transaction.
 *
 * Les deux signatures sont reconnues :
 *  - `pgbouncer=true` / `pool_mode=transaction` dans la chaine de requete ;
 *  - un hote contenant le marqueur `pooler` (`ep-xxx-pooler...`,
 *    `....us-east-2.pooler.neon.tech`), que Neon et Supabase emploient.
 *
 * Une URL illisible ne vaut pas rejet : on retombe alors sur la detection des
 * options, qui est celle qui existait. Refuser ici empecherait le worker de
 * demarrer sur une URL correcte mais atypique — un echec bruyant pour un
 * probleme qui n'en est pas un.
 *
 * @param url la valeur de `DATABASE_URL`.
 */
export function estConnexionDirecte(url: string | undefined | null): boolean {
  const valeur = url ?? '';
  if (!valeur) return true;

  // Les options d'URL, y compris sur une URL que `URL` ne sait pas parser.
  if (/[?&]pgbouncer=true/i.test(valeur) || /[?&]pool_mode=transaction/i.test(valeur)) {
    return false;
  }

  try {
    // Le marqueur est recherche dans le HOTE seul, et delimite : un hote qui
    // contiendrait « pooler » au milieu d'un mot ne doit pas declencher le
    // refus. `ep-aaa-pooler.` et `.pooler.` sont les deux formes constatees.
    const { hostname } = new URL(valeur);
    return !/(^|[.-])pooler([.-]|$)/i.test(hostname);
  } catch {
    return true;
  }
}

/**
 * Tente d'obtenir le verrou de leader.
 *
 * @param dbClient  un client `pg` DÉDIÉ, pas celui du pool : le verrou est
 *                  attaché à la connexion, un client du pool pourrait être
 *                  rendu au pool pendant que le verrou reste ailleurs.
 * @returns l'etat du verrou, meme en cas d'echec (fail-closed).
 */
export async function tryAcquireLeaderLock(dbClient: {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<LeaderLock> {
  try {
    const result = await dbClient.query('SELECT pg_try_advisory_lock($1) AS obtenu', [
      LOCK_KEY,
    ]);
    const obtenu = result.rows[0]?.obtenu === true;

    return {
      held: obtenu,
      release: async () => {
        try {
          await dbClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
        } catch {
          // La connexion est probablement déjà morte : PostgreSQL a alors
          // libéré le verrou tout seul. Rien à corriger.
        }
      },
    };
  } catch (err) {
    // Échec d'acquisition = échec du leadership. On ne suppose pas le
    // contraire : démarrer la boucle sans être leader produirait exactement la
    // corruption décrite plus haut.
    log.error('Impossible de tester le verrou de leader', {
      err: err instanceof Error ? err.message : err,
    });
    return { held: false, release: async () => {} };
  }
}

/**
 * Instance identifiante de ce worker, pour les journaux.
 * Le PID seul ne distingue pas deux conteneurs.
 */
export const workerInstanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
