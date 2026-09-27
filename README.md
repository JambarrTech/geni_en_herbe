# AEERKS — Journée d'Excellence : Génie en Herbe

Plateforme de gestion et de diffusion en direct de la compétition **Génie en Herbe** (AEERKS).

## Architecture

Le frontend est découpé en **trois apps Vite indépendantes** (dossiers distincts `apps/*`),
qui partagent du code commun dans `shared/` (alias `@shared` dans chaque app).

| App        | Chemin       | Rôle                                        | Port dev |
| ---------- | ------------ | ------------------------------------------- | -------- |
| `apps/live`  | `/`          | Écran public de diffusion (grand écran)     | 5173     |
| `apps/jury`  | `/jury`      | Table d'arbitrage : lancement, chrono, score | 5174     |
| `apps/admin` | `/admin`     | Comité : événements, équipes, questions, ... | 5175     |

- **Backend** : `backend/` (Express + WebSocket + PostgreSQL/Drizzle), API REST sous `/api`,
  diffusion temps réel sur `/ws`, sert les trois builds en production (`NODE_ENV=production`).
- **Code mutualisé** : `shared/` (types, contexte auth, contexte live, config, logo, login).

## Démarrage

1. Installation des dépendances :

   ```bash
   npm install                 # racine (workspaces apps/*)
   (cd backend && npm install)
   ```

2. Lancer tout (backend + les trois apps Vite) :

   ```bash
   npm run dev
   ```

   - API : http://localhost:3000
   - Live : http://localhost:5173   Jury : http://localhost:5174   Admin : http://localhost:5175

   En dev, chaque app Vite proxie `/api` et `/ws` vers le backend (port 3000).

3. Build de production (les trois apps vers `apps/*/dist`) :

   ```bash
   npm run build
   ```

4. Vérification type TypeScript (backend + apps) :

   ```bash
   npm run typecheck
   ```

## Notes

- La page publique (live) est volontairement dépourvue de barre de navigation : c'est un
  écran de diffusion. L'accès Jury/Admin se fait via `/jury` et `/admin`.
- Les valeurs métier (chrono, points, bonus, ...) sont centralisées :
  `backend/src/config.ts` (côté serveur) et `shared/lib/config.ts` (côté client).