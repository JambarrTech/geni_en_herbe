import { db } from '../db/index.ts';
import { competitionSettings } from '../db/schema.ts';

// Read competition_settings with a short in-memory cache (30s) to avoid
// hitting the DB on every match action while still picking up admin edits.
let cache: Map<string, string> | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000;

export async function getSetting(key: string, fallback: string): Promise<string> {
  const now = Date.now();
  if (!cache || now - cacheTime > CACHE_TTL_MS) {
    const rows = await db.select().from(competitionSettings);
    cache = new Map(rows.map((r) => [r.key, r.value]));
    cacheTime = now;
  }
  return cache.get(key) ?? fallback;
}