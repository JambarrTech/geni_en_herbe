import 'dotenv/config';
import http from 'http';
import { createApiApp } from './server/api.ts';
import { CONFIG } from './config.ts';

/**
 * Processus API.
 *
 * Ne fait QUE du REST. La diffusion temps réel vit dans `server/ws.ts`, la
 * boucle de chrono dans `server/worker.ts`, les fichiers statiques dans
 * `server/static.ts`. Voir README § Architecture.
 */
const app = createApiApp();
const PORT = Number(process.env.API_PORT) || Number(process.env.PORT) || CONFIG.API_PORT;
const server = http.createServer(app);

async function checkDatabaseOnce() {
  const { db } = await import('./db/index.ts');
  const { sql } = await import('drizzle-orm');
  try {
    await db.execute(sql`SELECT 1`);
    console.log('[AEERKS api] Base de données : connexion OK');
  } catch (err: any) {
    const reason = err?.cause?.code || err?.code || (err instanceof Error ? err.message : String(err));
    console.error('[AEERKS api] ATTENTION — base de données injoignable :');
    console.error(`  raison : ${reason}`);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[AEERKS api] API REST sur http://0.0.0.0:${PORT}/api`);
  void checkDatabaseOnce();
});

const shutdown = (signal: string) => {
  console.log(`[AEERKS api] Arrêt demandé (${signal}).`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => console.error('Promesse non gérée:', reason));
process.on('uncaughtException', (err) => console.error('Exception non interceptée:', err));
