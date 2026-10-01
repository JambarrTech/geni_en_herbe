# ADR-0005 : Décomposition ciblée des gros fichiers (extraction, pas réécriture)

## Statut
Accepté

## Contexte
Trois fichiers concentraient l'essentiel de la complexité du dépôt :

| Fichier | Rôle | Lignes |
| ------- | ---- | ------ |
| `apps/admin/src/pages/AdminDashboard.tsx` | écran d'administration | ~1 770 |
| `apps/jury/src/pages/JuryDashboard.tsx` | poste de jury | ~1 310 |
| `backend/src/routes/matches.routes.ts` | API des matchs | ~1 060 |

Le problème n'était pas le nombre de lignes en lui-même — du code de vue est
naturellement long — mais le fait que des **règles métier pures** y étaient
enfermées, donc invérifiables sans monter un serveur, une base, une session, un
contexte React et une connexion WebSocket. Trois exemples concrets :

- « qui a gagné ce match ? » (comparaison des scores, égalité, pénalités) ;
- « quelle touche attribue quel point, à quelle équipe, avec quel motif ? » ;
- « quel événement est l'événement courant sur lequel on publie un podium ? ».

Une règle qu'on ne peut pas éprouver seule est une règle dont on ne connaît pas
les cas limites. Le classement général, le motif d'audit et l'événement ciblé
par une publication de résultats en dépendent tous.

## Décision
**Extraire uniquement des zones clairement délimitées, sans réécrire la
logique.** Concrètement : déplacer des fonctions pures (aucun accès à `req`,
`res`, au DOM, au state React ou à la base) vers des modules dédiés, et écrire
leurs tests au moment de l'extraction.

### Ce qui a été extrait

1. **`backend/src/lib/matchList.ts`** (depuis `matches.routes.ts`)
   `winnerTeamIdOf`, `parseOptions`, `buildMatchList`.
   L'égalité renvoie `null` — jamais l'équipe A, jamais `0` : c'est la seule
   valeur qui ne peut pas être confondue avec un identifiant d'équipe valide.
   `parseOptions` ne laisse jamais remonter l'exception de `JSON.parse` : un
   seul enregistrement corrompu aurait fait échouer tout l'écran jury.

2. **`apps/jury/src/lib/juryShortcuts.ts`** (depuis `JuryDashboard.tsx`)
   `SCORE_SHORTCUTS`, `resolveScoreShortcut`, `resolveNavShortcut`,
   `isTypingTarget`, `hasModifier`, et surtout `SCORE_REASONS`.
   Les motifs d'attribution (« Bonne réponse directe (10 pts) ») étaient écrits
   **deux fois** — une fois dans le `onClick` de chaque bouton, une fois dans le
   `switch` du clavier. Ils sont enregistrés en base comme motif d'audit : les
   faire diverger aurait donné deux libellés pour la même action selon son mode
   de déclenchement. Ils ont désormais une source unique, utilisée par les deux
   chemins.

3. **`apps/admin/src/lib/currentEvent.ts`** (depuis `AdminDashboard.tsx`)
   `pickCurrentEvent`, `isEventInProgress`.
   La politique implicite est rendue explicite : un événement en cours d'usage
   (READY, RUNNING, PAUSED, REGISTRATION) est préféré ; sinon le plus récent par
   identifiant (et non le dernier de la liste, qui peut arriver dans n'importe
   quel ordre).

### Ce qui n'a PAS été fait
- **Pas de réécriture** : aucun changement de comportement, aucune nouvelle
  abstraction, aucun framework. Les modifications sont uniquement des
  déplacements de code.
- **Pas de découpage de composants** : le JSX reste où il est. Le déplacer
  n'aurait fait que répartir le même couplage sur plus de fichiers.
- **Pas d'extraction des blocs d'effets** (`useEffect`, `useCallback`) qui
  dépendent du state, du routeur ou de l'API : les sortir aurait exigé de
  passer une dizaine de paramètres, ce qui déplace la complexité sans la
  réduire.
- **Aucune modification des fichiers `routes/*.routes.ts` au-delà de
  `matches.routes.ts`** : les autres sont restés sous un seuil où la lecture
  d'un seul tenant reste possible.

### La règle appliquée
Une zone n'est extraite que si toutes ces conditions sont réunies :
1. elle ne touche ni `req`/`res`, ni le DOM, ni le state React, ni la base ;
2. son contrat est exprimable par une signature simple ;
3. elle porte une décision dont les cas limites comptent.

## Conséquences
- **Le nombre de lignes des pages n'a pas beaucoup baissé** — il a même
  légèrement augmenté, parce que documenter le *pourquoi* fait partie du
  travail. L'objectif n'a jamais été la ligne courte mais la règle vérifiable.
- 60 tests supplémentaires portent désormais directement sur ces règles
  (`backend/test/matchList.test.mjs`, `tests/apps/juryShortcuts.test.ts`,
  `tests/apps/currentEvent.test.ts`, plus les tests d'intégration
  `tests/apps/JuryDashboard.test.tsx`).
- Le test le plus utile de l'extraction jury compare le corps envoyé par un
  **clic** et par un **raccourci** et exige qu'ils soient identiques. C'est la
  garantie qui manquait : les deux chemins pouvaient diverger en silence.
- Un futur découpage suivra la même règle : extraire la décision pure, laisser
  le câblage. Un ADR ultérieur documentera tout passage à une décomposition plus
  profonde.

## Références
- `backend/src/lib/matchList.ts`, `backend/test/matchList.test.mjs`
- `apps/jury/src/lib/juryShortcuts.ts`, `tests/apps/juryShortcuts.test.ts`
- `apps/admin/src/lib/currentEvent.ts`, `tests/apps/currentEvent.test.ts`
- ADR-0003 (le harnais de tests qui rend ces extractions vérifiables)
