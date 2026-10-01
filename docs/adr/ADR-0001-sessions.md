# ADR-0001 : Choix du stockage des sessions (PostgreSQL, hash SHA-256, cache en mémoire)

## Statut
Accepté

## Contexte
L'application a évolué d'un stockage volatile à la nécessité d'avoir une session persistance correcte dans un déploiement multi-processus (worker, API, etc.). Les sessions Firebase, supprimées par le nettoyage du code mort (#7), ne correspondaient pas à l'architecture « hand-rolled » choisie (limite volontaire : pas de dépendance externe lourde pour un usage simple).

Le problème central : dans un déploiement derrière plusieurs instances, une session stockée uniquement en mémoire est perdue à chaque redémarrage d'une instance et ne peut pas être invalidée depuis une autre. Le cache mémoire reste utile pour réduire la charge DB, mais ne peut pas porter à lui seul l'intégrité.

## Décision
1. **Table `sessions` dans PostgreSQL** (migration `0003_sessions_table.sql`, schéma Drizzle). Colonnes : `id` UUID, `token_hash` CHAR(64) UNIQUE, `user_id` FK CASCADE, `expires_at` TIMESTAMP NOT NULL, `last_seen_at` TIMESTAMP, `ip` TEXT, `user_agent` TEXT, `created_at` TIMESTAMP.
2. **Hashage SHA-256 uniquement du jeton**. Le jeton brut n'est JAMAIS écrit en base, seulement son empreinte. À l'authentification, on calcule `sha256(token)` et on cherche par `token_hash`. Cela limite l'exposition en cas de fuite de logs ou de dump DB.
3. **Cache double bornes en mémoire** (`Map<string, CachedSession>`) avec :
- `SESSION_CACHE_TTL_MS = 30s` (très court). Jamais d'extension du TTL à la lecture (ceci aurait recréé la fuite que la table corrige : garder indéfiniment des sessions en mémoire).
- Lecture cache => on revalide TOUJOURS contre l'état utilisateur (actif/désactivé) à chaque vérification de session (même sur hit). Ce choix préserve le « hard cut » à la désactivation d'un compte.
4. **Nettoyage asynchrone** au démarrage (`startSessionPurge()`) avec `pg_try_advisory_lock(0x41454552)` — le worker reste single-instance. Intervalle lié à `SESSION_PURGE_IDLE_MS`.
5. **Pas de `timingSafeEqual` sur le jeton**. La comparaison est une recherche exacte par hash ; un second test d'égalité bit-à-bit sur une chaîne arbitraire après lookup n'apporte aucun gain de sécurité mesurable ici (et peut introduire un faux sentiment de sécurité). Le vecteur critique est la non-exposition du token brut et la rotation/expiration.

## Conséquences
- Auth devient asynchrone (toutes les fonctions de session passent à `async`) — impact maîtrisé (middleware/auth, routes).
- DB requise pour toutes les écritures de session (login/logout/revoke). Lectures souvent servies par cache (30s) pour limiter la pression.
- Invalidation immédiate possible depuis n'importe quelle instance (suppression par hash ou par `user_id`).
- Migration appliquée sur l'environnement réel (Neon).

## Références
- `backend/src/lib/sessions.ts`
- `backend/src/middleware/auth.ts`
- `backend/src/db/schema.ts` (table 13)
- `backend/drizzle/0003_sessions_table.sql`
