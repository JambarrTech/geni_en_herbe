import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import { CONFIG } from '../config.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export const createPool = () => {
  if (!global._postgresPool) {
    const databaseUrl = process.env.DATABASE_URL;

    if (databaseUrl) {
      // Neon / PostgreSQL serverless : connexion via chaîne complète (SSL requis)
      global._postgresPool = new Pool({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false },
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

    global._postgresPool.on('error', (err) => {
      console.error('Erreur inattendue sur le pool SQL:', err);
    });
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = drizzle(pool, { schema });
export { schema };