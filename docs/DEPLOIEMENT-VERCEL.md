# Déploiement : un projet Vercel pour les trois interfaces

Ce document décrit la mise en production retenue : **un seul projet Vercel** qui
sert les trois interfaces, le backend restant sur un hôte de processus
permanents.

```
geni_en_herbe.vercel.app/         → écran public (live)
geni_en_herbe.vercel.app/jury/    → écran jury
geni_en_herbe.vercel.app/admin/   → écran administration
                        /api/*    → relayé par Vercel vers le backend
```

## Pourquoi un seul projet

Les trois interfaces sont **déjà conçues** pour cette répartition. Ce n'est pas
une adaptation, c'est le fonctionnement actuel :

- `scripts/build.mjs` compile chaque app avec un `VITE_BASE_PATH` distinct :
  `/` pour `live`, `/jury/` pour `jury`, `/admin/` pour `admin`.
- Le processus `static` du backend sert `apps/*/dist` exactement sous ces
  trois préfixes, et relaie `/api` et `/ws`.

Il n'y a donc **aucun routage à inventer**. Le script
`scripts/assemble-vercel-dist.mjs` se contente de regrouper les trois
répertoires de sortie — Vercel n'acceptant qu'un seul `outputDirectory` :

```
dist/
├── index.html          ← apps/live/dist    (base "/")
├── assets/…
├── jury/
│   ├── index.html      ← apps/jury/dist    (base "/jury/")
│   └── assets/…
└── admin/
    ├── index.html      ← apps/admin/dist   (base "/admin/")
    └── assets/…
```

Les URL d'assets générées par Vite sont donc déjà correctes : aucune
réécriture de HTML n'est nécessaire.

### Vérification qui protège d'un échec silencieux

Un build Vite **réussit** même avec une base mal configurée : les fichiers sont
produits, mais le HTML référence des assets qui n'existent pas, et chaque page
affiche un écran blanc. Aucun bundler ne lève d'erreur dans ce cas.

Le script d'assemblage relit donc le HTML produit et vérifie que chaque
`src`/`href` existe réellement sur le disque. Un déploiement qui aboutirait à
trois pages blanches échoue **au build**, pas à l'usage.

## Ce que Vercel ne peut pas faire

Vercel ne relaie pas de WebSocket. L'écran public et l'écran jury reçoivent le
score et la progression du chronomètre par ce canal ; c'est le cœur du service.

Conséquence : le socket du navigateur doit viser directement l'hôte du backend,
et non le CDN. C'est le seul écart entre les deux origines, et il est traité
explicitement :

| Élément | Origine vue par le navigateur | Conséquence |
|---|---|---|
| Documents et assets | `geni_en_herbe.vercel.app` | — |
| `/api/*` | `geni_en_herbe.vercel.app` (relayé par Vercel) | **aucune** : le navigateur reste sur une seule origine, donc ni CORS ni cookie cross-origin |
| `/ws` | le backend, en `wss://` | origine tierce : exige `VITE_WS_URL` + `WS_ALLOWED_ORIGINS` + `connect-src` |

Le relais de `/api` par Vercel est volontaire : le navigateur ne voit qu'une
seule origine, donc le backend n'a besoin d'aucune configuration CORS.

## Étape 1 — Renseigner l'adresse du backend

Deux emplacements dans `vercel.json`, tous deux marqués
`REMPLACER_PAR_TON_API` :

1. la destination du relais `/api` ;
2. la directive `connect-src` de la CSP (le WebSocket).

```diff
- { "source": "/api/:path*", "destination": "https://REMPLACER_PAR_TON_API/api/:path*" },
+ { "source": "/api/:path*", "destination": "https://api.exemple.sn/api/:path*" },
```

```diff
- connect-src 'self' wss://REMPLACER_PAR_TON_API;
+ connect-src 'self' wss://api.exemple.sn;
```

Le build **échoue** tant que le marqueur est présent, et vérifie en plus que
les deux emplacements nomment le même hôte. C'est volontaire : si le relais et
le socket visent des hôtes différents, le jeton de session est émis pour l'un et
refusé par l'autre, et l'utilisateur voit une déconnexion inexplicable — sans
le moindre message d'erreur.

## Étape 2 — Déployer le backend

Sur un hôte de processus permanents (Railway, Render, Fly.io, un VPS). Les
processus `api`, `ws` et `worker` sont de longue durée ; ils ne peuvent pas
tourner sur une fonction serverless.

Variables d'environnement :

| Variable | Valeur |
|---|---|
| `DATABASE_URL` | connexion Neon existante |
| `NODE_ENV` | `production` |
| `PORT` | fourni par l'hébergeur |
| `TRUST_PROXY` | `true` (l'hôte est derrière un proxy) |
| `LOG_LEVEL` | `info` |
| `WS_ALLOWED_ORIGINS` | `https://geni_en_herbe.vercel.app` |

`WS_ALLOWED_ORIGINS` n'est nécessaire que dans cette configuration. Tant que
l'interface et l'API partagent une origine, elle doit rester **vide** : ce
contrôle est une liste blanche stricte, et la remplir à tort ferme l'accès aux
clients légitimes.

Sur place (Réseau local du tournament), laissez `WS_ALLOWED_ORIGINS` vide :
tous les écrans partagent une seule origine, et le contrôle se fait sur cette
base — c'est le comportement par défaut, inchangé.

## Étape 3 — Déployer le frontend sur Vercel

1. Importer le dépôt Git, **racine du dépôt** (`apps/*` n'est pas le répertoire
   racine d'un projet ici).
2. Vercel détecte `vercel.json` : commande de build, répertoire de sortie et
   réécritures en sont déjà définis. Framework : laisser vide (`framework: null`).
3. Définir `VITE_WS_URL` :
   - **Production** : `wss://api.exemple.sn`
   - **Prévisualisation** : l'URL de la prévisualisation est un sous-domaine
     variable. Ajoutez-la à `WS_ALLOWED_ORIGINS` côté backend, ou laissez
     `VITE_WS_URL` vide en prévisualisation (le socket suit alors le CDN, qui
     ne le relaie pas : le temps réel ne fonctionnera pas — c'est le prix d'une
     prévisualisation sur un CDN).

### À propos de `outputDirectory`

Vercel n'exécute pas le build en local : le répertoire de sortie doit donc
exister dans le dépôt au moment de la construction. La commande de build est
`npm run build && node scripts/assemble-vercel-dist.mjs`, qui produit `dist/`
à la racine. `dist/` est ignoré par git, ce qui est correct : c'est un artefact
de construction, pas une source.

## Étape 4 — Vérifier

```bash
curl -I https://geni_en_herbe.vercel.app/          # 200, index.html
curl -I https://geni_en_herbe.vercel.app/jury/     # 200
curl -I https://geni_en_herbe.vercel.app/admin/    # 200
curl -s https://geni_en_herbe.vercel.app/api/health | head -c 200
```

Puis, dans le navigateur : ouvrir l'écran jury, se connecter, lancer un match, et
vérifier que le chronomètre descend sur l'écran public. Un chronomètre figé
signale un `connect-src` ou un `WS_ALLOWED_ORIGINS` incomplet.

## Annexe — l'option qui demande zéro code

Si le CDN n'apporte rien à votre usage, déploiement unifié possible : héberger le
processus `static` du backend (qui sert déjà les trois apps sous `/`, `/jury`,
`/admin` et relaie `/api` et `/ws`) sur l'hôte de processus permanents, sans
Vercel.

Une seule origine, aucune réécriture, WebSocket compris, et le code reste
strictement celui d'aujourd'hui. C'est l'état actuel du dépôt : le déploiement
Vercel est un **choix**, pas une étape de migration.