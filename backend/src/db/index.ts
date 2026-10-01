import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import { CONFIG } from '../config.ts';
import { createLogger } from '../lib/logger.ts';
import { metrics } from '../lib/metrics.ts';

const log = createLogger('db');

declare global {
  var _postgresPool: Pool | undefined;
}

/**
 * Vérification du certificat TLS du serveur PostgreSQL.
 *
 * La valeur par défaut est `true` : `rejectUnauthorized: false` désactive
 * complètement la validation du certificat et rend la connexion interceptable
 * (MITM). C'était le réglage précédent, en dur, sans possibilité de le changer.
 *
 * Neon et les hébergeurs gérés émettent un certificat valide : le mode strict
 * fonctionne. Le contournement n'est nécessaire que pour un PostgreSQL local
 * avec certificat auto-signé — dans ce cas, positionnez
 * `DB_SSL_REJECT_UNAUTHORIZED=0` de façon explicite et temporaire.
 *
 * Note : `drizzle.config.ts` (utilisé par `db:generate` / `db:migrate`) utilise
 * `ssl: true`, c'est-à-dire la validation déjà active. Les deux chemins
 * doivent être alignés.
 */
const rejectUnauthorized =
  process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' && process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

if (!rejectUnauthorized && databaseUrlConfigured()) {
  log.warn(
    'DB_SSL_REJECT_UNAUTHORIZED=0 : la validation du certificat PostgreSQL est DÉSACTIVÉE. ' +
      'À n\'utiliser que pour une base locale avec certificat auto-signé.'
  );
}

function databaseUrlConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export const createPool = () => {
  if (!global._postgresPool) {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      // Neon / PostgreSQL serverless : connexion via chaîne complète (SSL requis)
      global._postgresPool = new Pool({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized },
        max: CONFIG.DB_POOL_MAX,
        connectionTimeoutMillis: CONFIG.DB_CONNECT_TIMEOUT_MS,
      });
    } else {
      global._postgresPool = new Pool({
        host: process.env.SQL_HOST,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        database: process.env.SQL_DB_NAME,
        max: CONFIG.DB_POOL_MAX,
        connectionTimeoutMillis: CONFIG.DB_CONNECT_TIMEOUT_MS,
      });
    }

    // Une erreur « idle » du client PostgreSQL n'est pas une erreur de
    // requête : c'est le pool qui signale une connexion morte en cours de
    // réutilisation. `pg` la retire lui-même du pool ; on la journalise et on
    // la compte pour voir si la base coupe les connexions en cours de
    // compétition (fréquent chez les hébergeurs managés).
    global._postgresPool.on('error', (err) => {
      metrics.dbErrors.inc({ operation: 'pool-idle' });
      log.error('Erreur inattendue sur le pool SQL', { err });
    });

    // Connexions en attente : la file d'attente du pool est le premier signe
    // d'un `DB_POOL_MAX` trop bas pour la charge réelle. Sans cette jauge, un
    // pool saturé se manifeste seulement par une latence inexplicablement
    // haute sur les requetes deja acceptees.
    const timer = setInterval(() => {
      metrics.dbPoolWaiting.set(global._postgresPool?.waitingCount ?? 0);
    }, 5_000);
    timer.unref();
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = drizzle(pool, { schema });
export { schema };