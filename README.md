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

- **Backend** : `backend/` (Express + WebSocket + PostgreSQL/Drizzle).
- **Code mutualisé** : `shared/` (client HTTP, contexte auth, contexte live, `<Modal>`,
  primitives d'interface, types, config, logo, page de connexion).

### Les quatre processus de l'backend

L'API, la diffusion temps réel, la boucle de chrono et les fichiers statiques
sont **quatre processus séparés**, chacun sur son port. Un blocage, un crash ou
un redéploiement de l'un n'affecte pas les autres.

| Processus   | Port  | Rôle                                          | Sonde                    |
| ----------- | ----- | --------------------------------------------- | ------------------------ |
| `api`       | 4000  | Routes REST `/api`                            | `GET /api/health`        |
| `ws`        | 4001  | Diffusion temps réel `/ws`                    | `GET /`                  |
| `worker`    | 4002  | Boucle de chrono (tâche de fond, ~1 s)         | `GET /`                  |
| `static`    | 4003  | Sert `apps/*/dist` **+ reverse proxy**        | `GET /__static_health`   |

Chaque port est surchargeable (`API_PORT`, `WS_PORT`, `WORKER_PORT`,
`STATIC_PORT`), avec les valeurs par défaut dans `backend/src/config.ts`.

**Le reverse proxy est indispensable.** Les trois apps sont servies sur
l'origine 4003 et appellent `/api/...` et `wss://<hôte>/ws`. Le processus
`static` relaie donc :

```
/api  ->  API_PORT      /ws  ->  WS_PORT
```

C'est le rôle que joue Vite en développement, et que joue nginx en
production. Sans cela, la page servie par `static` ne trouverait ni son API ni
son WebSocket. Le code client reste inchangé : pas de CORS, pas de cookie
inter-origines, pas de modification de la CSP.

**Diffusion inter-processus.** L'API ne rappelle plus le serveur WebSocket en
mémoire : elle publie sur un canal PostgreSQL `LISTEN/NOTIFY`
(`backend/src/server/pubsub.ts`), que le processus `ws` consomme. La
notification n'est délivrée qu'au commit de la transaction émettrice, donc un
score n'est jamais diffusé avant d'être validé. Si `ws` tombe, l'API continue
de fonctionner et les clients se resynchronisent à la reconnexion.

> **Attention au déploiement horizontal.** Un seul worker doit tourner à la
> fois : deux boucles de chrono se disputeraient la même ligne. Les sessions
> sont aussi en mémoire et ne sont pas partagées entre instances. Ces deux
> points doivent être réglés avant de passer à plusieurs instances.

### Démarrage

```bash
npm run serve              # les 4 processus
npm run serve -- api ws    # une sélection
cd backend && npm run start:worker   # ou un seul, dans un autre terminal
```

En développement avec rechargement à chaud :

```bash
npm run dev                 # API + les trois apps Vite (proxy Vite vers l'API)
cd backend && npm run dev:worker   # boucle de chrono, terminal séparé
```

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

   - API : http://localhost:4000
   - Live : http://localhost:5173  Jury : http://localhost:5174  Admin : http://localhost:5175

   En dev, chaque app Vite proxie `/api` et `/ws` vers le backend (port 4000).
   Le port du backend se surcharge par `PORT` (ou `BACKEND_PORT` pour `npm run dev`) ;
   en modifier la valeur par défaut demande de mettre à jour **ensemble**
   `backend/src/config.ts` (`PORT_DEFAULT`), `scripts/dev.mjs` et les trois
   `apps/*/vite.config.ts`, sinon le proxy et le backend ne se retrouvent plus.

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
npm run lint        # ESLint (flat config, plugin react-hooks, y compris backend/)
npm run typecheck   # tsc --noEmit sur backend + les 3 apps
npm test            # tests des règles métier (node:test, aucune dépendance)
npm run build       # build de production
```

Tests d'intégration exigeant les 4 processus démarrés (`npm run serve`) :

```bash
cd backend
node --import tsx test/bus-cross-process.mjs   # la diffusion franchit-elle la frontière de processus ?
node --import tsx test/prod-chain.mjs          # statique -> proxy -> API et WS
node --import tsx test/static-traversal.mjs    # traversée de répertoire (HTTP brut)
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
  Firebase a été retiré des deux côtés : le SDK client (dépendance, chunk de
  ~235 Ko, `shared/lib/firebase.ts`) comme le SDK serveur (`firebase-admin`).

  Le chemin serveur supprimé n'était pas seulement mort, il était **faux** :
  `verifyIdToken` ne valide que les jetons émis par *ce* projet Firebase, alors
  que l'initialisation ne passait que `projectId`. Les deux paramètres n'ont
  aucun sens sans fichier de comptes de service : aucun jeton externe n'aurait
  jamais été accepté, et le code de provisionnement automatique des comptes
  Google n'aurait jamais pu s'exécuter. C'était du code qui avait l'air de
  fonctionner — le pire état possible pour une garde d'accès.

  Le contrôle d'accès aux écrans (`/`, `/jury`, `/admin`) repose donc
  uniquement sur le jeton de session émis par `POST /api/auth/login`
  (voir [ADR-0004](docs/adr/0004-sessions-externalisees.md)).
- **Sessions** : stockées en table `sessions`, pas en mémoire du processus.
  Le jeton n'est jamais stocké en clair — seule son empreinte SHA-256 l'est.
  Conséquences directes : un redémarrage ou un déploiement ne déconnecte plus
  le jury, et l'API peut être déployée à l'échelle sans sessions collantes.

## Notes

- La page publique (live) est volontairement dépourvue de barre de navigation : c'est un
  écran de diffusion. L'accès Jury/Admin se fait via `/jury` et `/admin`, tous deux
  gardés par rôle (`isAdmin` pour `/admin`, `isJury` pour `/jury`).
- Les valeurs métier (chrono, points, bonus, ...) sont centralisées :
  `backend/src/config.ts` (côté serveur) et `shared/lib/config.ts` (côté client).
  Certaines règles restent surchargeables en base via `competition_settings`.
- `lucide-react` est isolé dans un chunk séparé, hors du HTML initial, donc hors
  du chemin critique de rendu.
