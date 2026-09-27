import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config();

// Neon / PostgreSQL : la chaîne complète DATABASE_URL est prioritaire
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  const sqlHost = process.env.SQL_HOST;
  const sqlDbName = process.env.SQL_DB_NAME;
  const user = process.env.SQL_ADMIN_USER;
  const password = process.env.SQL_ADMIN_PASSWORD;

  if (!sqlHost) {
    throw new Error("SQL_HOST must be set in environment variables.");
  }
  if (!sqlDbName) {
    throw new Error("SQL_DB_NAME must be set in environment variables.");
  }
  if (!user) {
    throw new Error("SQL_ADMIN_USER must be set in environment variables.");
  }
  if (!password) {
    throw new Error("SQL_ADMIN_PASSWORD must be set in environment variables.");
  }
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: databaseUrl
    ? { url: databaseUrl, ssl: true }
    : {
        host: process.env.SQL_HOST!,
        user: process.env.SQL_ADMIN_USER!,
        password: process.env.SQL_ADMIN_PASSWORD!,
        database: process.env.SQL_DB_NAME!,
        ssl: false,
      },
  verbose: true,
});