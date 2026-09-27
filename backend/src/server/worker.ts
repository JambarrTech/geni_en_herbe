import 'dotenv/config';
import http from 'http';
import {
  startAuthoritativeTimerLoop,
  stopAuthoritativeTimerLoop,
} from './matchEngine.ts';
import { CONFIG } from '../config.ts';

/**
 * Worker de la boucle de chrono.
 *
 * C'est le seul travail du système qui ne doit jamais s'arrêter : il pilote le
 * décompte autoritaire affiché sur l'écran public et écrit chaque seconde en
 * base. L'isoler dans son propre process signifie qu'un traitement de requête
 * long ou bloquant côté API ne peut plus le figer.
 *
 * Conséquence de l'isolation : un seul worker doit tourner à la fois. Sur
 * plusieurs instances, un leader lock PostgreSQL est nécessaire — à installer
 * si le déploiement devient horizontal (cf. README § Architecture).
 */
const app = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      status: 'ok',
      service: 'AEERKS — worker chrono',
      pid: process.pid,
    })
  );
});

const PORT = Number(process.env.WORKER_PORT) || CONFIG.WORKER_PORT;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[AEERKS worker] Sonde de vivacité sur http://0.0.0.0:${PORT}`);
});

startAuthoritativeTimerLoop();
console.log('[AEERKS worker] Boucle de chrono started.');

const shutdown = (signal: string) => {
  console.log(`[AEERKS worker] Arrêt demandé (${signal}).`);
  stopAuthoritativeTimerLoop();
  app.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => console.error('Promesse non gérée:', reason));
process.on('uncaughtException', (err) => console.error('Exception non interceptée:', err));
