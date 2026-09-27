import 'dotenv/config';
import http from 'http';
import { Client } from 'pg';
import {
  startAuthoritativeTimerLoop,
  stopAuthoritativeTimerLoop,
} from './matchEngine.ts';
import { tryAcquireLeaderLock, workerInstanceId, type LeaderLock } from './leaderLock.ts';
import { CONFIG } from '../config.ts';

/**
 * Worker de la boucle de chrono.
 *
 * C'est le seul travail du système qui ne doit jamais s'arrêter : il pilote le
 * décompte autoritaire affiché sur l'écran public et écrit chaque seconde en
 * base. L'isoler dans son propre process signifie qu'un traitement de requête
 * long ou bloquant côté API ne peut plus le figer.
 *
 * UN SEUL WORKER À LA FOIS
 * ------------------------
 * Deux boucles ne se contenteraient pas de doubler le travail : elles se
 * disputeraient la même ligne de match. L'une peut remettre le chrono à zéro,
 * avancer la question courante ou clôturer un match pendant que l'autre fait
 * l'inverse. Le résultat est un état incohérent, et intermitent — donc difficile
 * à reproduire après coup.
 *
 * Le process tente donc d'obtenir un verrou de leader PostgreSQL avant de
 * démarrer la boucle. En cas d'échec, il ne démarre PAS : il le dit et attend.
 * Démarrer sans être leader produirait précisément la corruption décrite
 * ci-dessus, en silence.
 */
const app = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      status: 'ok',
      service: 'AEERKS — worker chrono',
      pid: process.pid,
      instance: workerInstanceId,
    })
  );
});

const PORT = Number(process.env.WORKER_PORT) || CONFIG.WORKER_PORT;

/** Verrou détenu, pour le relâcher à l'arrêt. */
let leader: LeaderLock = { held: false, release: async () => {} };
/** Tente de devenir leader toutes les 10 s tant qu'on ne l'a pas. */
let retryTimer: NodeJS.Timeout | null = null;

/**
 * Démarre la boucle, une seule fois, et seulement en tant que leader.
 *
 * Le client de verrou doit être dédié : `pg_try_advisory_lock` attache le
 * verrou à la CONNEXION, pas au process. Un client emprunté au pool pourrait
 * être rendu pendant que ce worker croit encore détenir le verrou.
 *
 * On refuse explicitement une URL de pooler en mode transaction : le verrou
 * y est attaché à une session serveur réassignable, donc le worker pourrait
 * croire être leader sans l'être. Mieux vaut un worker qui refuse de démarrer
 * qu'un worker qui corrompt l'état en silence (cf. leaderLock.ts).
 */
function assertDirectConnection(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  const pooled = /[?&]pgbouncer=true/i.test(url) || /[?&]pool_mode=transaction/i.test(url);
  if (pooled) {
    console.error(
      '[AEERKS worker] DATABASE_URL pointe vers un pooler en mode transaction. ' +
        'Les verrous consultatifs y sont attachés à une session serveur réassignable : ' +
        'le worker perdrait le verrou sans le savoir. Utilisez la connexion directe.'
    );
    return false;
  }
  return true;
}

async function tryBecomeLeader(): Promise<boolean> {
  if (leader.held) return true;
  if (!assertDirectConnection()) return false;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
  });

  try {
    await client.connect();
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err);
    console.error(`[AEERKS worker] Connexion impossible pour le verrou de leader : ${raison}`);
    return false;
  }

  leader = await tryAcquireLeaderLock(client);

  if (!leader.held) {
    // La connexion est lâchée sans verrou : rien à تنظيف côté PostgreSQL.
    void client.end().catch(() => {});
    return false;
  }

  startAuthoritativeTimerLoop();
  console.log(
    `[AEERKS worker] Verrou de leader obtenu (instance ${workerInstanceId}). Boucle de chrono démarrée.`
  );
  return true;
}

function planRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void tryBecomeLeader().then((obtenu) => {
      if (!obtenu) planRetry();
    });
  }, CONFIG.LEADER_RETRY_MS);
  retryTimer.unref();
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[AEERKS worker] Sonde de vivacité sur http://0.0.0.0:${PORT}`);
  console.log(`[AEERKS worker] Instance ${workerInstanceId} (pid ${process.pid})`);

  const obtenu = await tryBecomeLeader();
  if (!obtenu) {
    console.warn(
      '[AEERKS worker] Un autre worker détient déjà la boucle de chrono. ' +
        'Ce process reste en veille et la prendra s\'il s\'arrête.'
    );
    planRetry();
  }
});

const shutdown = async (signal: string) => {
  console.log(`[AEERKS worker] Arrêt demandé (${signal}).`);
  if (retryTimer) clearTimeout(retryTimer);
  if (leader.held) {
    stopAuthoritativeTimerLoop();
    await leader.release();
    console.log('[AEERKS worker] Verrou de leader relâché.');
  }
  app.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => console.error('Promise non gérée:', reason));
process.on('uncaughtException', (err) => console.error('Exception non interceptée:', err));
