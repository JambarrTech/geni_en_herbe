import { randomUUID } from 'node:crypto';

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
 * connexion DIRECTE, sans parametre `pgbouncer=true`.
 *
 * Le worker ouvre sa propre connexion pour le verrou, hors du pool applicatif :
 * c'est deja le cas, et c'est ce qui rend cette contrainte respectee tant que
 * l'URL n'est pas un point d'entree de pooler.
 */

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
    console.error(
      "[AEERKS worker] Impossible de tester le verrou de leader :",
      err instanceof Error ? err.message : err
    );
    return { held: false, release: async () => {} };
  }
}

/**
 * Instance identifiante de ce worker, pour les journaux.
 * Le PID seul ne distingue pas deux conteneurs.
 */
export const workerInstanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
