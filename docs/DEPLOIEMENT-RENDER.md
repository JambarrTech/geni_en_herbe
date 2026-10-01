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
npm run db:seed:admin                 # crée le compte ADMIN
```

`db:seed:admin` lit `SEED_ADMIN_PASSWORD` — il échoue s'il est absent. C'est
volontaire : aucun compte administrateur ne doit pouvoir être créé par défaut.

## Pourquoi un seul service

L'offre gratuite de Render accorde **750 heures par workspace et par mois**,
partagées entre tous les services. Quatre services — un par processus, comme
dans `docker-compose.yml` — demanderaient 3000 heures, soit quatre fois le
plafond. Un service unique consomme exactement 750 heures.

Les quatre processus restent des **processus de l'OS distincts**, lancés et
surveillés par `backend/src/supervisor.ts`. L'isolation est donc préservée : un
traitement de requête long côté API ne peut pas figer la boucle de chrono.

## Création du service

1. *New* → *Blueprint* → sélectionnez le dépôt. Render lit `render.yaml`.
2. Renseignez `DATABASE_URL` (la nouvelle). Les autres variables sont déjà
   définies dans le blueprint.
3. *Apply*. Le premier déploiement prend quelques minutes (image Docker complète).

Aucun *Build Command* supplémentaire n'est nécessaire : le `Dockerfile` compile
les trois applications Vite et installe les dépendances de production du
backend. `start:all` est la seule commande nécessaire.

## Les trois-plusieurs-à-une disposition des ports

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

Une fois que tout fonctionne et que le compte admin existe, vous pouvez
décommenter le job de migration dans `render.yaml` (il est fourni mais
désactivé). **Attention** : `db:migrate` ne réinitialise pas de mot de passe,
mais un job mal séquencé qui s'exécute à chaque déploiement allongerait chaque
déploiement. Déclarez-le avant `aeerks` — Render exécute les services dans
l'ordre déclaré.

## Et Vercel ?

Le dépôt contient toujours `vercel.json`, `scripts/assemble-vercel-dist.mjs` et
`docs/DEPLOIEMENT-VERCEL.md`. Ce chemin est **documenté mais non déployé** : il
supposerait le worker de chrono ailleurs, ce que le choix Render évite. Voir
`docs/adr/ADR-0006-topologie-deploiement.md`.

Si vous préférez ne garder qu'un seul chemin de déploiement, ces trois fichiers
peuvent être supprimés : le dépôt fonctionne sans eux, et `npm run build`
produit toujours les trois `dist` separately.