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
- **Code mutualisé** : `shared/` (client HTTP, contexte auth, contexte live, composant `<Modal>`,
  types, config, logo, page de connexion).

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
   - Live : http://localhost:5173  Jury : http://localhost:5174  Admin : http://localhost:5175

   En dev, chaque app Vite proxie `/api` et `/ws` vers le backend (port 3000).

3. Build de production (les trois apps vers `apps/*/dist`) :

   ```bash
   npm run build
   ```

   `scripts/build.mjs` définit `VITE_BASE_PATH` par application (`/`, `/jury/`, `/admin/`)
   via `spawn`, et compile les trois apps **en parallèle** après avoir nettoyé `dist/`.
   Ne lancez pas `npm run build` directement dans `apps/jury` ou `apps/admin` : la
   variable `VITE_BASE_PATH` ne serait pas positionnée et le build serait faux.

## Vérification

```bash
npm run lint        # ESLint (flat config, plugin react-hooks)
npm run typecheck   # tsc --noEmit sur backend + les 3 apps
npm test            # tests des règles métier (node:test, aucune dépendance)
npm run build       # build de production
```

`noUnusedLocals` / `noUnusedParameters` sont activés dans les quatre `tsconfig.json` :
le code mort échoue à la compilation plutôt que de s'accumuler.

## Base de données

```bash
(cd backend && npm run db:migrate)   # applique backend/drizzle/*.sql
(cd backend && npm run db:generate)  # génère une migration depuis src/db/schema.ts
(cd backend && npm run db:studio)
```

> **Attention avant `db:generate`.** `src/db/schema.ts` est la source de vérité et
> doit décrire la base *avant* de générer. La table `schools` et les colonnes
> `school_id` (sur `participants` et `teams`) existent en base depuis la migration
> `0000` : elles sont déclarées dans le schéma precisely pour que `generate` n'émette
> pas de `DROP`. Si vous supprimez une entité du schéma, écrivez la migration
> `DROP` explicitement et relisez-la.

## Sécurité

- **Routes protégées** : `/api/participants`, `/api/teams`, `/api/matches`,
  `/api/events`, `/api/categories`, `/api/settings`, `/api/questions`,
  `/api/audit-logs`, `/api/users` exigent un jeton.
  Seules `/api/health`, `/api/live`, `/api/rankings` et `/api/auth/login` sont publiques
  (l'écran public en dépend).
- **Sessions** : la `active` et le rôle sont revalidés en base à **chaque** requête.
  Désactiver ou rétrograder un compte révoque immédiatement ses sessions ouvertes.
  Les sessions vivent en mémoire : un redémarrage du backend les invalide, et le
  déploiement ne doit pas être horizontal sans store partagé.
- **Réponse officielle** : `backend/src/lib/sanitize.ts` (`publicQuestion`) retire
  `answer` et `explanation` de tout payload public. Toute nouvelle diffusion doit
  passer par cette fonction.
- **En-têtes** : CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS en
  production. Derrière un reverse proxy, positionnez `TRUST_PROXY=1` sinon le
  rate-limit de connexion se bucketise sur l'IP du proxy.
- **Authentification** : la connexion se fait **exclusivement par email + mot de passe**.
  L'interface n'expose plus de connexion Google, et le SDK `firebase` a été retiré
  du front (dépendance, chunk de ~235 Ko, `shared/lib/firebase.ts`).

  Le **chemin serveur** reste en place : `backend/src/middleware/auth.ts` sait
  toujours valider un jeton Firebase ID et provisionner un compte
  (premier compte ou domaine `CONFIG.ORG_EMAIL_DOMAINS` ⇒ rôle `ADMIN`).
  Aucun client ne peut plus en produire un, donc ce chemin est inatteignable en
  l'état — c'est un point à trancher si vous voulez le retirer
  (voir § Points en suspens).

## Notes

- La page publique (live) est volontairement dépourvue de barre de navigation : c'est un
  écran de diffusion. L'accès Jury/Admin se fait via `/jury` et `/admin`, tous deux
  gardés par rôle (`isAdmin` pour `/admin`, `isJury` pour `/jury`).
- Les valeurs métier (chrono, points, bonus, ...) sont centralisées :
  `backend/src/config.ts` (côté serveur) et `shared/lib/config.ts` (côté client).
  Certaines règles restent surchargeables en base via `competition_settings`.
- `lucide-react` est isolé dans un chunk séparé, hors du HTML initial, donc hors
  du chemin critique de rendu.
- `metadata.json` est un artefact de l'outil qui a généré le projet et ne sert à rien
  en fonctionnement ; il peut être supprimé.
