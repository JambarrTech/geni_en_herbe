# ADR-0002 : Observabilité — Logger structuré sans dépendance, Metrics Prometheus

## Statut
Accepté

## Contexte
Le codebase privilégie les solutions « zéro dépendance » là où un besoin simple suffit (rate limiter maison, leader lock maison, vérificateur CSS maison). Il manque un socle d'observabilité cohérent :
- Logs structurés (JSON) en prod, lisibles en dev, avec redaction des secrets.
- Métriques (compteurs, jauges, histogrammes) exposées au format Prometheus, utilisables par un scrutateur sans import d'une bibliothèque externe.

## Décision
1. **Logger structuré** (`backend/src/lib/logger.ts`) sans dépendance externe.
   - Niveaux : ERROR, WARN, INFO, DEBUG, TRACE.
   - Format choisi par `NODE_ENV` (prod => JSON, dev => pretty). On évite de se baser sur `isTTY` (des logs pipés vers un agrégateur en dev doivent rester parsables).
   - Erreurs uniquement sur `stderr`, le reste sur `stdout`.
   - `LOG_LEVEL` relu à CHAQUE écriture (non figé au chargement du module) — permet d'ajuster le niveau à chaud sans redémarrer.
   - Redaction clé-valeur (noms sensibles : token, password, hash, secret, authorization, cookie, bearer, session...). Limite de profondeur/taille, protection contre les cycles (circular-safe).
   - Corrélation de requêtes : `AsyncLocalStorage` (`withRequestId` / `currentRequestId`), injecté via `instrumentRequests()` dans l'API Express.
2. **Métriques Prometheus** (`backend/src/lib/metrics.ts`) sans dépendance externe.
   - Types : `Counter` (inc/observe-by, refuse les valeurs négatives, retourne la valeur après incrément), `Gauge` (inc/dec/set), `Histogram` (buckets par défaut + cumulative `+Inf`).
   - Guard sur cardinalité des labels de route (`routeLabel()`) pour éviter une explosion de séries.
   - Échantillonneur lag event-loop (`eventLoopLagMonitor`, intervalle configurable).
   - Rendu texte Prometheus (`renderMetrics()`) avec en-têtes `# HELP`/`# TYPE`, familles `aeerks_*`, métrique `aeerks_leader`.
   - Exposition HTTP : `/api/metrics` (registrée AVANT `express.json()` et AVANT l'instrumentation des requêtes), `/metrics` (WS), `/metrics` (worker), `/__static_metrics` (static).

## Conséquences
- Tous les modules critiques (api, ws, worker, static, pubsub, leaderLock, matchEngine, db, rateLimit, routes) sont instrumentés et loggués.
- Les tests `backend/test/logger.test.mjs` (19) et `backend/test/metrics.test.mjs` (17) verrouillent les invariants (redaction, bornes, format, cardinalité).
- Observabilité découplée du runtime (pas de SDK propriétaire). Facile à agréger (Prometheus, Loki/ELK).

## Références
- `backend/src/lib/logger.ts`, `backend/src/lib/metrics.ts`
- `backend/src/server/api.ts` (`instrumentRequests`, exposition `/api/metrics`)
- `backend/src/config.ts` (nouvelles variables d'observabilité)
