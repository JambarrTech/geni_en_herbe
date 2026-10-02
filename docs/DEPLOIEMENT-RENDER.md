# Déploiement sur Render

Le backend, les trois interfaces et le temps réel sur **un seul service**, une
seule origine, un seul domaine.

```
https://aeerks.onrender.com/         → écran public
https://aeerks.onrender.com/jury     → écran jury
https://aeerks.onrender.com/admin    → administration
https://aeerks.onrender.com/api/...  → API REST
wss://aeerks.onrender.com/ws         → diffusion temps réel
```

Aucune configuration de domaine supplémentaire, aucun CORS, aucun WebSocket
cross-origin. C'est ce que le code fait déjà : le processus `static` sert les
trois interfaces sous ces préfixes et relaie `/api` et `/ws`.

## Pourquoi une seule origine

C'est le choix qui décide de tout le reste, et il a été fait pour une raison
seule : **`WS_ALLOWED_ORIGINS`**.

Le serveur de diffusion refuse toute connexion dont l'origine n'est pas
autorisée. En mono-origine, cette liste est vide et la connexion passe
toujours — sans rien demander à personne.

Avec un CDN devant (Vercel), le navigateur annonce l'origine du CDN, absente de
la liste. La connexion est alors refusée **en code 1008** : le jury se connecte,
le chrono ne descend pas, et aucun journal, aucune console, aucun code HTTP ne
signale rien.

Une liste d'origines à maintenir, dont la seule erreur se révèle le jour de la
compétition, n'était pas un bon échange contre un cache de fichiers statiques.

Le trafic vivant — WebSocket et API — part de toute façon sur Render dans les
deux montages. Le CDN n'aurait amélioré que le chargement initial, et ajouté un
relais sur chaque appel API.

Voir `docs/adr/ADR-0006-topologie-deploiement.md`. `vercel.json` et
`scripts/assemble-vercel-dist.mjs` restent dans le dépôt sans être déployés : la
voie de retour demeure documentée, et la CI en vérifie encore l'assemblage.

## Ce qu'il reste à configurer

**Une seule variable**, dans le dashboard Render :

- `DATABASE_URL` — l'URL Neon complète, avec `?sslmode=require`.

> **Prenez la connexion directe, pas la « pooled ».** Le tableau de bord Neon
> propose les deux côte à côte. Elles ne se distinguent pas dans l'URL : seule la
> **directe** convient ici.
>
> La raison n'est pas le débit mais un verrou. `pg_try_advisory_lock` est
> attaché à une **session** PostgreSQL ; derrière un pooler en mode transaction,
> les sessions sont réassignées d'un client à l'autre. Le worker se croirait
> leader en ayant perdu le verrou — et deux workers se disputeraient la même
> ligne de match, l'un remettant le chrono à zéro pendant que l'autre avance.
>
> Le `worker` refuse donc de démarrer sur une URL de pooler, en journalisant
> l'hôte détecté. Si ce message apparaît, collez l'autre chaîne.

`WS_ALLOWED_ORIGINS` est écrite dans le blueprint (`value: ""`) : rien à saisir.

## Avant de commencer

**Changez le mot de passe de la base.** Il a été collé en clair dans une
conversation. Dans le tableau de bord Neon : *Connection* → réinitialiser le
mot de passe de `neondb_owner`, puis mettez à jour `DATABASE_URL` dans Render.

**Vérifiez que les tables existent.** Appliquez les migrations depuis votre
machine, une seule fois :

```bash
cd backend
$env:DATABASE_URL="postgresql://..."   # la NOUVELLE valeur
npm run db:migrate
```

Les migrations sont **idempotentes** : les relancer sur une base à jour n'écrit
rien. Inutile de les retirer du projet.

### `db:seed:admin` — à ne pas lancer sur un compte qui existe

Ce script crée un administrateur, mais sur une base **déjà peuplée** il fait
autre chose : le `UPDATE` de `src/db/seed-admin.ts` **écrase le mot de passe**
du compte dont l'adresse correspond à `SEED_ADMIN_EMAIL`. Le lancer alors que
votre compte existe revient à remplacer un mot de passe que vous connaissez par
un que vous venez de fournir — donc à vous verrouiller dehors si le second
vous échappe.

Avant de l'exécuter, vérifiez l'état de la base (lecture seule, sans mot de
passe) :

```bash
cd backend
npm run db:comptes
```

S'il affiche `Compte trouvé`, **n'utilisez pas le seed**. Connectez-vous avec
votre mot de passe actuel et changez-le depuis l'interface si vous voulez le
renouveler. Le seed n'a de sens que sur une base vide ; il lit
`SEED_ADMIN_PASSWORD` et échoue sans elle, volontairement — aucun compte
administrateur ne doit pouvoir être créé par défaut.

## Pourquoi un seul service

L'offre gratuite de Render accorde **750 heures par workspace et par mois**,
partagées entre tous les services. Quatre services — un par processus —
demanderaient 3000 heures, soit quatre fois le plafond. Un service unique
consomme exactement 750 heures.

Les quatre processus restent des **processus de l'OS distincts**, lancés et
surveillés par `backend/src/supervisor.ts`. L'isolation est donc préservée : un
traitement de requête long côté API ne peut pas figer la boucle de chrono.

## Création du service

Le service tourne sur le **runtime Node natif** de Render : le dépôt ne
contient plus de Dockerfile, et Render clone le dépôt **en entier**.

1. *New* → *Blueprint* → sélectionnez le dépôt. Render lit `render.yaml`.
2. Renseignez `DATABASE_URL` (la seule variable à `sync: false`).
3. *Apply*. Le premier déploiement compile les trois applications Vite, ce qui
   prend quelques minutes.

### Le `buildCommand` compile tout

Le service doit produire ce qu'il sert : les trois interfaces **et** les
dépendances du backend. Deux `npm ci`, parce que le dépôt a deux verrous.

```yaml
buildCommand: npm ci --include=dev && npm run build && npm ci --prefix backend
startCommand: cd backend && npm run start:all
```

`--include=dev` n'est pas une coquetterie : Render définit `NODE_ENV=production`,
ce qui ferait omettre les dépendances de développement — dont `vite`, sans
lequel aucune interface ne se compile.

Le `cd backend` de `startCommand` est obligatoire : le superviseur résout `tsx`
à partir du dossier courant pour ses processus enfants. `tsx` est en
`dependencies` du backend, pas en `devDependencies`, parce que c'est lui qui
exécute ce superviseur — un `--omit=dev` à l'étape suivante le retirerait et le
service ne démarrerait pas.

Il n'y a **pas** de `rootDir`. Le service doit compiler les interfaces, qui
vivent à la racine du dépôt : restreint à `backend/`, il ne pourrait plus ni les
produire, ni les servir.

### Le processus `static` : deux rôles selon l'installation

`static` est indispensable — c'est lui seul qui ouvre le port public, et il
relaie `/api` et `/ws`. Son rôle se déduit des fichiers qu'il trouve :

| `apps/*/dist` | Comportement |
|---|---|
| les trois présents | sert les écrans **et** relaie — le cas de Render |
| aucun présent | relais seul (`/api`, `/ws`, sonde) |
| une partie seulement | **refuse de démarrer** |

`STATIC_SERVE_APPS` permet de figer ce rôle à titre exceptionnel ; elle n'est pas
dans le blueprint, la déduction étant le comportement correct.

Le refus du dernier cas est délibéré : un build partiel produit un écran jury
blanc alors que l'écran public fonctionne — le symptôme le plus cher à
diagnostiquer de la plateforme, et le seul qui ne laisse rien dans les journaux
du navigateur.

Vérifiez ce que Render verra :

```bash
npm run render:check
```

Il lit la topologie depuis `buildCommand` et en déduit la valeur **correcte** de
`WS_ALLOWED_ORIGINS` : vide en mono-origine, l'origine du CDN si un CDN revient.
Il signale aussi un `rootDir` réapparu, qui empêcherait le service de produire ce
qu'il doit servir.

### `WS_ALLOWED_ORIGINS` : vide, et c'est correct

Le serveur de diffusion refuse toute connexion dont l'origine n'est pas
autorisée. La valeur `""` n'autorise **que la même origine** — donc exactement
celle de Render, puisque les écrans y sont aussi. Rien à saisir, rien à
maintenir.

Elle est écrite dans le blueprint (`value: ""`) plutôt que laissée à définir dans
le dashboard, pour que la décision soit dans le dépôt et pas dans une interface
web.

> **Si un jour l'interface part sur un CDN**, remplacez `""` par l'origine du
> CDN, sans barre oblique finale :
> ```
> WS_ALLOWED_ORIGINS=https://aeerks.vercel.app
> ```
> Renseigner la variable ne suffira pas : `connect-src` de la CSP devra aussi
> l'autoriser, sinon c'est le navigateur qui bloque. Les deux se vérifient avec
> `npm run render:check`.

Deux origines si l'écran public et le jury sont sur des domaines différents —
la liste est séparée par des virgules :

```
WS_ALLOWED_ORIGINS=https://aeerks.onrender.com,https://jury.aeerks.sn
```

Pour vérifier que le canal fonctionne réellement :

```bash
npx tsx backend/scripts/ws-smoke.mjs wss://aeerks.onrender.com/ws
```

## La disposition des ports : un seul point d'entrée

| Processus | Port | Accessible de l'extérieur |
| --- | --- | --- |
| `static` | `PORT` (10000, imposé par Render) | **oui** — l'unique entrée |
| `api` | 4000 | non |
| `ws` | 4001 | non |
| `worker` | 4002 | non |

`static` relaie `/api` vers 4000 et `/ws` vers 4001. Exposer les trois autres
n'ajouterait qu'une surface d'attaque.

> **Détail qui a coûté un cycle de test.** Render injecte `PORT` pour le service
> qu'il expose. Cet héritage atteint les quatre processus, et l'API lit
> `API_PORT || PORT` : elle tentait donc d'écouter sur le port public, déjà pris
> par `static`, et mourait sur `EADDRINUSE` — **après** une construction
> réussie. Le superviseur supprime `PORT` de l'environnement des processus
> privés. Si vous ajoutez un cinquième processus, déclarez-le dans le
> superviseur : un port hérité est une collision silencieuse jusqu'au déploiement.

## Vérifier

```bash
curl -I https://aeerks.onrender.com/          # 200
curl -I https://aeerks.onrender.com/jury     # 200
curl -I https://aeerks.onrender.com/admin    # 200
curl -s https://aeerks.onrender.com/api/health
```

Puis, dans le navigateur : `/jury`, connexion, lancement d'un match, et
**vérifiez que le chronomètre descend sur l'écran public**. C'est le seul test
qui valide la boucle de chrono.

Pour le canal temps réel, sans navigateur :

```bash
cd backend && npx tsx scripts/ws-smoke.mjs wss://aeerks.onrender.com/ws
```

Un chronomètre figé, ou `aeerks_leader 0` sur `/metrics` du worker, indique que
le verrou de leader n'a pas été obtenu — le worker refuse alors volontairement de
démarrer plutôt que de corrompre l'état.

## La mise en veille de l'offre gratuite

Render endort un service gratuit après **15 minutes sans trafic entrant** (les
messages WebSocket d'une connexion ouverte comptent). Le premier réveil prend
**environ une minute**, pendant laquelle Render affiche une page de chargement.

C'est le principal défaut de l'offre gratuite, et il est assumé : pendant un
tournoi, le jury et le public génèrent du trafic en continu, donc le service
reste éveillé. Le risque réel est **avant** et **après** la session.

Si un service doit rester éveillé en permanence, un ping toutes les 10 minutes
depuis un cron externe (cron-job.org, UptimeRobot — gratuits) suffit. Faites-le
sur `/__static_health`, qui répond sans toucher à la base.

## Après le premier déploiement

Le job de migration de `render.yaml` est fourni mais **désactivé** (commenté).
C'est volontaire : les migrations sont appliquées à la main depuis votre machine
une fois pour toutes, et un job qui s'exécute à chaque déploiement allonge
chaque déploiement sans rien apporter. Si vous préférez l'automatiser,
décommentez-le et **déclarez-le avant `aeerks`** : Render exécute les services
dans l'ordre déclaré, donc le schéma sera prêt quand l'API recevra sa première
requête.

## Et Vercel ?

Le chemin Vercel reste **documenté et vérifié par la CI**, mais il n'est pas
déployé. Ce document décrit donc l'état retenu ; [DEPLOIEMENT-VERCEL.md](DEPLOIEMENT-VERCEL.md)
décrit l'autre, et ADR-0006 argumente le choix.

Y revenir demande trois choses, toutes explicites — c'est le prix d'une voie de
sortie, et la raison pour laquelle on l'a conservée plutôt que supprimée :

1. `render.yaml` : retirer le build des interfaces et remettre
   `WS_ALLOWED_ORIGINS` à définir dans le dashboard, avec l'origine Vercel ;
2. `vercel.json` : renseigner l'hôte du backend ;
3. importer le dépôt dans Vercel, dossier racine.

`npm run render:check` signale chacune de ces divergences au lieu de les laisser
apparaître en production.

### Le mode auto-hébergé, lui, fonctionne toujours

`npm run build` à la racine produit les trois `dist`, et `static` les sert sur
4003 en relaissant `/api` et `/ws`. Une seule origine, aucune variable, aucun
déploiement : le mode le plus simple à exploiter le jour J, et probablement le
bon pour une répétition.