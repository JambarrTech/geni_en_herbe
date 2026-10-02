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
contient plus de Dockerfile, et il ne voit que le dossier `backend/`.

1. *New* → *Blueprint* → sélectionnez le dépôt. Render lit `render.yaml`.
2. Renseignez les deux variables à `sync: false` :
   - `DATABASE_URL` — l'URL Neon complète, avec `?sslmode=require` ;
   - `WS_ALLOWED_ORIGINS` — l'origine de l'interface, voir ci-dessous.
3. *Apply*.

### `rootDir: backend` — Render ne voit que le backend

Le champ `rootDir` restreint le service à `backend/`. C'est ce qui rend le
découpage réel plutôt que déclaratif : **le dépôt est toujours cloné en entier**,
`rootDir` change seulement le dossier courant des commandes de build et de
démarrage — mais c'est suffisant pour que le service n'installe et ne serve que
le backend.

Conséquence directe sur le `buildCommand` :

```yaml
rootDir: backend
buildCommand: npm ci          # et NON plus `npm ci --include=dev && npm run build`
startCommand: npm run start:all
```

Les trois applications Vite ne sont **plus compilées sur Render** : elles sont
servies par le CDN Vercel (voir
[DEPLOIEMENT-VERCEL.md](DEPLOIEMENT-VERCEL.md)). Les compiler ici prenait une
minute et environ 200 Mo par déploiement pour produire des fichiers que ce
service ne sert pas.

`tsx` est pour cette raison une **dépendance de production** du backend
(`dependencies`, pas `devDependencies`) : c'est lui qui exécute le superviseur,
et une installation qui l'ometterrait laisserait le service incapable de
démarrer.

### Le processus `static`, en relais seul

Le processus `static` reste indispensable : c'est lui seul qui ouvre le port
public, et il relaie `/api` et `/ws`. Sur Render il ne sert plus de fichiers.

Son rôle est déduit de ce qu'il trouve sur le disque, et non d'une convention :

| `apps/*/dist` | `STATIC_SERVE_APPS` | Comportement |
|---|---|---|
| les trois présents | (absent ou `true`) | sert les écrans **et** relaie |
| aucun présent | (absent ou `false`) | **relais seul** — l'état normal sur Render |
| une partie seulement | — | **refuse de démarrer** |

Le refus du dernier cas est délibéré. Un build partiel produit un écran jury
blanc alors que l'écran public fonctionne — le symptôme le plus cher à
diagnostiquer de la plateforme, et le seul qui ne laisse rien dans les
journaux du navigateur. Le blueprint fixe `STATIC_SERVE_APPS=false` pour que
l'intention soit déclarative : un `dist/` résiduel (build manuel, cache) ne
pourrait pas faire servir un écran par ce service alors qu'il est sur le CDN.

Vérifiez ce que Render verra :

```bash
npm run render:check
```

Il contrôle notamment que `buildCommand` ne compile plus le frontend **et** que
le service ne prétend pas le servir — les deux erreurs étant aussi muettes
l'une que l'autre.

### `WS_ALLOWED_ORIGINS` : la variable qui décide du chrono

Le serveur de diffusion refuse toute connexion dont l'origine n'est pas
autorisée. La valeur par défaut (`""`) n'autorise **que la même origine** — ce
qui suffit quand l'interface est servie par Render lui-même.

Si l'interface est déployée sur **Vercel** (voir
[DEPLOIEMENT-VERCEL.md](DEPLOIEMENT-VERCEL.md)), le navigateur annonce
l'origine Vercel et non celle de Render. La liste doit donc contenir cette
origine, sans barre oblique finale :

```
WS_ALLOWED_ORIGINS=https://aeerks.vercel.app
```

Deux origines si l_screen public et le jury sont sur des domaines différents —
la liste est séparée par des virgules :

```
WS_ALLOWED_ORIGINS=https://aeerks.vercel.app,https://jury.aeerks.sn
```

> **Symptôme d'une valeur absente ou incorrecte :** le jury se connecte, le
> chrono ne descend pas, et l'écran public affiche « Direct » puis se fige.
> La connexion est refusée en code **1008**. Ce n'est ni un bug de build ni un
> problème de base : vérifiez cette variable en premier.
> `node scripts/check-render-blueprint.mjs` affiche sa valeur attendue.

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

Ce n'est **pas** une alternative : c'est l'autre moitié du déploiement retenu.

Ce service ne sert que `/api`, `/ws` et la boucle de chrono. Les trois écrans
sont sur le CDN Vercel, qui relaie `/api` vers Render. Voir
[DEPLOIEMENT-VERCEL.md](DEPLOIEMENT-VERCEL.md) et
`docs/adr/ADR-0006-topologie-deploiement.md`.

L'hôte du backend est saisi à **un seul endroit**, dans `vercel.json` :

```bash
npm run vercel:backend -- https://aeerks.onrender.com
```

Le relais `/api`, la directive `connect-src` de la CSP et le `VITE_WS_URL`
injecté au build en découlent. Il reste deux actions sur les plateformes, et
elles ne peuvent pas être automatisées depuis le dépôt :

1. `WS_ALLOWED_ORIGINS` dans le dashboard Render — l'origine Vercel ;
2. importer le dépôt dans Vercel, avec le dossier racine.

### Ce qui reste possible sans Vercel

Le mode auto-hébergé fonctionne toujours : `npm run build` à la racine produit
les trois `dist`, et le processus `static` les sert sur le port 4003 en
relaissant `/api` et `/ws`. Une seule origine, aucune variable à renseigner, et
le canal temps réel passe par le même hôte — ce qui reste le mode le plus
simple à exploiter le jour J, et probablement le bon pour une répétition.