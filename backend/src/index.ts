import 'dotenv/config';
import http from 'http';
import { randomUUID } from 'node:crypto';
import { createApiApp } from './server/api.ts';
import { CONFIG } from './config.ts';
import { createLogger } from './lib/logger.ts';
import { metrics } from './lib/metrics.ts';

/**
 * Processus API.
 *
 * Ne fait QUE du REST. La diffusion temps réel vit dans `server/ws.ts`, la
 * boucle de chrono dans `server/worker.ts`, les fichiers statiques dans
 * `server/static.ts`. Voir README § Architecture.
 */
const log = createLogger('api');
const instanceId = randomUUID().slice(0, 8);

const app = createApiApp();
const PORT = Number(process.env.API_PORT) || Number(process.env.PORT) || CONFIG.API_PORT;
const server = http.createServer(app);

async function checkDatabaseOnce() {
  const { db } = await import('./db/index.ts');
  const { sql } = await import('drizzle-orm');
  try {
    await db.execute(sql`SELECT 1`);
    log.info('Base de donnees : connexion OK');
  } catch (err: any) {
    const reason = err?.cause?.code || err?.code || (err instanceof Error ? err.message : String(err));
    log.error('ATTENTION — base de donnees injoignable', { raison: reason });
    metrics.dbErrors.inc({ operation: 'healthcheck' });
    return;
  }

  // Connexion établie, mais la base peut être en retard sur le code déployé.
  //
  // Ce second contrôle est celui qui compte pour un concours : une migration non
  // appliquée ne coupe rien à la connexion, et ne se révèle qu'à l'usage, par un
  // 500 sans cause apparente — au milieu d'une rencontre. Le dire ici, au
  // démarrage, transforme un incident en zouli prévisible.
  //
  // Il ne fait PAS arrêter le processus : la base reste utilisable pour tout ce
  // qui ne touche pas aux colonnes manquantes, et refuser de démarrer
  // échangerait une dégradation partielle contre une indisponibilité totale.
  try {
    const { findMissingColumns, describeMissingColumns } = await import('./lib/schemaCheck.ts');
    const manquantes = await findMissingColumns();
    const diagnostic = describeMissingColumns(manquantes);
    if (diagnostic) {
      log.error('ATTENTION — schema de base incomplet', { diagnostic, manquantes });
    } else {
      log.info('Schema de base : a jour');
    }
  } catch (err: any) {
    // Un échec du contrôle ne doit pas être confondu avec un schéma cassé : on
    // n'affirme ni l'un ni l'autre.
    log.warn('Verification du schema impossible', {
      raison: err?.cause?.code || err?.code || (err instanceof Error ? err.message : String(err)),
    });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  log.info(`API REST sur http://0.0.0.0:${PORT}/api`, { instance: instanceId });
  void checkDatabaseOnce();
});

const shutdown = (signal: string) => {
  log.info(`Arret demande (${signal}).`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => log.error('Promesse non geree', { err: reason }));
process.on('uncaughtException', (err) => log.error('Exception non interceptee', { err }));
