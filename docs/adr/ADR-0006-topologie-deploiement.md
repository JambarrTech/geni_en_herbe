# ADR-0006 — Topologie de déploiement : un projet Vercel, backend sur processus permanent

- **Statut** : Accepté
- **Date** : 2026-10-01

## Contexte

Le dépôt produit trois applications distinctes (`live`, `jury`, `admin`) et un
backend composé de trois processus (`api`, `ws`, `worker`).

Deux contraintes matérialisent le problème :

1. **Le canal temps réel est un WebSocket.** Les écrans public et jury reçoivent
   le score et la progression du chronomètre par ce canal. Une fonction
   serverless ne peut pas maintenir une connexion WebSocket ouverte ; le
   processus `worker` doit, lui, dormir entre deux publications.
2. **Le CDN visé ne relaie pas de WebSocket.** C'est la limite structurelle de
   l'hébergeur envisagé pour les interfaces.

Il faut donc répartir trois applications et trois processus de longue durée
entre deux types d'hébergement qui ne se ressemblent pas.

## Décision

**Un seul projet Vercel pour les trois interfaces**, servies par chemin :

| URL | Application | `VITE_BASE_PATH` |
| --- | --- | --- |
| `/` | `live` (public) | `/` |
| `/jury/` | `jury` | `/jury/` |
| `/admin/` | `admin` | `/admin/` |

Le **backend** reste sur un hôte de processus permanents, avec la base
PostgreSQL existante.

L'API est exposée au navigateur **par relais** : Vercel réécrit `/api/*` vers le
backend. Le navigateur ne voit donc qu'une seule origine.

## Pourquoi un seul projet, et non trois

Trois projets Vercel auraient exigé trois domaines, trois déploiements et trois
copies de configuration — alors que les applications sont **déjà** conçues pour
cette répartition par chemin :

- `scripts/build.mjs` compile chaque app avec un `VITE_BASE_PATH` distinct ;
- le processus `static` du backend sert `apps/*/dist` exactement sous ces trois
  préfixes, et relaie `/api` et `/ws`.

Il n'y a donc aucun routage à concevoir : `scripts/assemble-vercel-dist.mjs` se
limite à regrouper les trois répertoires de sortie, Vercel n'acceptant qu'un seul
`outputDirectory`.

## Conséquences

**Le WebSocket traverse deux origines.** C'est le seul écart, et il est traité
explicitement plutôt que laissé à l'état :

- `VITE_WS_URL` permet au navigateur de viser l'hôte du backend. Sans cette
  variable, le calcul produit **exactement** la chaîne d'avant
  (`shared/lib/wsUrl.ts`) : l'auto-hébergement est inchangé.
- `connect-src` de la CSP doit autoriser cette origine. Une omission est
  silencieuse : la page s'affiche, puis le chronomètre ne descend plus.
- `WS_ALLOWED_ORIGINS` referme le contrôle côté serveur. Ce contrôle n'existait
  pas : il était tenu par la CSP et par l'absence de cookie, garanties qui
  disparaissent dès que le socket devient cross-origin.

**Le relais de `/api` est volontaire.** Il garde le navigateur sur une seule
origine, donc le backend n'a besoin d'aucune configuration CORS. Il n'y a donc
aucune occurrence de `Access-Control-Allow-Origin` dans tout le dépôt, et c'est
un choix : cela tient à la co-location, pas à un oubli.

**Le build échoue si l'adresse du backend n'est pas renseignée.** L'adresse
apparaît à deux endroits dans `vercel.json` (relais et CSP) ; le build refuse de
produire une sortie tant que le marqueur est présent, et vérifie que les deux
emplacements nomment le même hôte. Une divergence y produit une déconnexion
sans message d'erreur.

**L'assemblage vérifie les assets produits.** Un build Vite réussit avec une
base mal configurée — fichiers produits, HTML référençant l'inexistant, trois
écrans blancs. Aucun bundler ne lève d'erreur. Le script relit le HTML et
vérifie que chaque `src`/`href` existe sur le disque.

**Un coût de build supplémentaire.** Les trois applications sont compilées à
chaque déploiement, là où trois projets en compileraient une seule. Le volume est
faible (Vite, sans dépendance lourde) et le bénéfice — un seul domaine, un
déploiement atomique pour les trois écrans — balance largement ce surcoût.

## Alternatives écartées

| Alternative | Pourquoi écartée |
| --- | --- |
| **Tout auto-hébergé**, sans CDN | Retenu comme option de repli, pas comme décision : le CDN apporte la mise en cache des bundles, le certificat et le déploiement atomique. Le code n'a pas besoin d'être modifié pour ce chemin. |
| **Trois projets Vercel** | Trois domaines et trois configurations pour une répartition par chemin que le code produit déjà. |
| **Le backend sur Vercel** | Impossible : `ws` et `worker` sont des processus de longue durée. |
| **API cross-origin + CORS** | Le relais `/api` atteint le même résultat sans introduire de surface d'attaque cross-origin côté serveur. |

## Renvoi

Mise en œuvre pas à pas : `docs/DEPLOIEMENT-VERCEL.md`.