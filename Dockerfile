# syntax=docker/dockerfile:1
#
# AEERKS — image de production
#
# UNE image, QUATRE points d'entrée : les quatre processus de l'backend
# (api / ws / worker / static) partagent le même code, ils ne diffèrent que par
# la commande de démarrage. L'image est donc construite une fois.
#
#   docker run --rm -p 4000:4000 IMAGE  npm run start:api      # un processus
#   docker run --rm -p 8080:8080 -e PORT=8080 IMAGE  npm run start:all  # les quatre
#
# `start:all` lance le superviseur (`backend/src/supervisor.ts`), qui démarre et
# surveille les quatre processus dans un seul conteneur. C'est le mode utilisé
# sur Render, dont les heures gratuites sont partagées à l'échelle du workspace.
# `start:api` et consorts restent utilisables individuellement — c'est ce que
# fait `docker-compose.yml`.
#
# Pourquoi le backend est-il exécuté via `tsx` et non compilé en JavaScript ?
# Le code importe ses modules avec l'extension explicite (`./config.ts`), ce que
# `tsc` ne réécrit pas et que Node ne sait pas résoudre sans chargeur. Plutôt
# que de modifier 40 imports, on embarque `tsx`. Contrepartie assumée : une
# dépendance de plus dans l'image de production (~15 Mo). Le hot reload n'est
# active qu'a la construction, pas a l'execution.


# ---------------------------------------------------------------------------
# Étape 1 — construction des trois applications Vite
# ---------------------------------------------------------------------------
FROM node:24-alpine AS apps-build

WORKDIR /repo

# Le cache Docker est invalidé par les manifestes, pas par le code : on copie
# d'abord les package.json + lock, on installe, puis on copie les sources.
#
# `shared/` n'est PAS un workspace npm et ne possède pas de package.json : il
# n'y a donc rien à y copier. Seuls le manifeste racine et ceux des trois apps
# sont nécessaires à l'installation.
COPY package.json package-lock.json ./
COPY apps/live/package.json  apps/live/
COPY apps/jury/package.json  apps/jury/
COPY apps/admin/package.json apps/admin/

# `npm ci` installe la racine ET les workspaces `apps/*` (déclarés dans
# package.json). Le backend a son propre arbre : traité plus bas.
RUN npm ci

COPY shared/ ./shared/
COPY apps/    ./apps/

RUN npm run build


# ---------------------------------------------------------------------------
# Étape 2 — dépendances de production du backend
# ---------------------------------------------------------------------------
FROM node:24-alpine AS backend-deps

WORKDIR /repo/backend

COPY backend/package.json backend/package-lock.json ./

# --omit=dev exclut tsx, or on en a besoin à l'exécution (cf. en-tête) : on le
# réinstalle explicitement. drizzle-kit reste exclu : il ne sert qu'en local.
RUN npm ci --omit=dev \
 && npm install --no-save tsx@^4.21.0


# ---------------------------------------------------------------------------
# Étape 2bis — image des migrations
#
# Cible séparée car `drizzle-kit` est une devDependency : l'image de production
# l'exclut volontairement, donc `npm run db:migrate` y échouerait. Plutôt que
# de réinstaller drizzle-kit à chaque exécution de migration (ralentit chaque
# déploiement, et dépend du réseau au runtime), on construit une image dédiée,
# légère, qui n'est démarrée qu'une fois puis s'arrête.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS migrate

ENV NODE_ENV=production
WORKDIR /repo/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./

# Pas de tini ici : ce service exécute une tâche unique puis s'arrête. La
# gestion des signaux n'a de sens que pour les processus de longue durée, et
# ajouter tini coûterait une couche pour rien.
ENTRYPOINT ["npm", "run"]
CMD ["db:migrate"]


# ---------------------------------------------------------------------------
# Étape 3 — image finale
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

# tini assure la transmission correcte de SIGTERM : sans lui, Node ne reçoit pas
# l'arrêt et le conteneur finit en SIGKILL après le délai de grâce, coupant une
# transaction PostgreSQL en cours. curl sert aux sondes de santé.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=4000 \
    API_PORT=4000 \
    WS_PORT=4001 \
    WORKER_PORT=4002 \
    STATIC_PORT=4003

WORKDIR /repo

# Le serveur statique cherche les builds à `apps/*/dist` : ils sont donc copiés
# à leur emplacement définitif, pas dans un dossier d'artefacts.
COPY --from=backend-deps /repo/backend/node_modules ./backend/node_modules
COPY backend/                          ./backend/
COPY --from=apps-build  /repo/apps/live/dist  ./apps/live/dist
COPY --from=apps-build  /repo/apps/jury/dist  ./apps/jury/dist
COPY --from=apps-build  /repo/apps/admin/dist ./apps/admin/dist

# Le conteneur ne doit ni écrire dans l'image, ni tourner en root.
RUN addgroup -S aeerks \
 && adduser -S -G aeerks -H -s /sbin/nologin aeerks \
 && chown -R aeerks:aeerks /repo
USER aeerks

WORKDIR /repo/backend

# Point d'entrée par défaut : le superviseur.
#
# Pourquoi le superviseur et non l'API ? Les quatre processus restent des
# processus de l'OS distincts (l'isolation est réelle), mais ils partagent un
# conteneur. C'est ce que permet l'hébergeur retenu : Render accorde 750 heures
# gratuites PAR WORKSPACE ET PAR MOIS, partagées entre les services — quatre
# services demanderaient 3000 heures, soit quatre fois le plafond. Un service
# unique consomme exactement 750 heures.
#
# `docker-compose.yml` garde ses quatre services : en développement, la
# séparation visible et le redémarrage indépendant valent mieux que l'économie
# d'heures, qui n'a de sens que sur une offre gratuite.
#
# Voir `backend/src/supervisor.ts` et docs/DEPLOIEMENT-RENDER.md.
ENTRYPOINT ["/sbin/tini", "--", "npm", "run"]
CMD ["start:all"]

# Sonde cohérente avec CMD : le superviseur expose l'état des quatre processus.
# `HEALTHCHECK` n'est pas utilisé par Render (qui interroge lui-même
# `healthCheckPath`), mais il reste utile en local et sur une VM.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${STATIC_PORT}/__static_health" >/dev/null 2>&1 || exit 1
