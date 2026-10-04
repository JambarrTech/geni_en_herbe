# Success Summary - AEERKS Platform Updates

## Travaux terminés

### 1. Migration 0007 - Catégorie DUEL et questions (corrigée)
`backend/drizzle/0007_add_duel_category_and_questions.sql` :
- Catégorie "DUEL" + 4 questions.
- **Correction** : noms de colonnes `timeLimitSeconds` (camelCase, colonne
  inexistante) → `time_limit_seconds` (snake_case, cf. `0000`). Sans cela,
  toute application manuelle du fichier échouait.
- **Idempotence** : gardes `NOT EXISTS` sur la catégorie et chaque énoncé —
  rejouer le fichier ne duplique rien. Le fichier reste hors journal
  (`meta/_journal.json`), application manuelle unique (cf. CHECKLIST-JOUR-J).

### 2. Flux de diffusion - étape ROSTER supprimée (soldé)
`backend/src/lib/broadcastFlow.ts` :
- `broadcastSequence()` démarre à QUESTION, `firstCursor()` = QUESTION,
  `normalizeCursor()` → QUESTION par défaut.
- **Correction du trou restant** : `normalizeCursor()` convertit désormais
  explicitement `ROSTER` (valeur historique, toujours valide au sens
  `isBroadcastStage`) vers `QUESTION` à index borné. Avant, une ligne restée
  sur `ROSTER` rendait `nextCursor`/`previousCursor` nuls (curseur hors
  séquence) et bloquait le jury sur « diffusion à son terme ».
- **Code mort supprimé** : `ROSTER_STAGE_SECONDS`, `rosterShouldAutoAdvance()`,
  `rosterDeadline()` (étaient `@deprecated` et sans appelant).
- `BROADCAST_STAGE.ROSTER` et `showsRoster` conservés en lecture seule pour
  les lignes existantes ; plus aucune écriture n'en produit.

### 3. Schéma et migration 0011
- `backend/src/db/schema.ts` : défaut `broadcast_stage` `'ROSTER'` →
  `'QUESTION'`, commentaires réécrits (porte de sécurité REVEAL, colonne
  `broadcast_roster_until` marquée historique).
- Nouvelle migration journalisée `0011_broadcast_default_question`
  (`SET DEFAULT`, bascule des lignes `ROSTER` → `QUESTION`, `roster_until` →
  `NULL`) : sûre à appliquer, aucun changement de rendu (c'est ce que
  `normalizeCursor` faisait déjà virtuellement).
- `backend/src/server/matchEngine.ts` : commentaire fantôme
  (« Quitte l'étape ROSTER… » accolé à `recalculateMatchScore`) supprimé.

### 4. Processus `static` : commentaires mono-origine
`backend/src/server/static.ts` : les commentaires décrivant Render comme
« écrans sur le CDN Vercel » (époque `rootDir: backend`) contredisaient le
déploiement mono-origine actuel (`render.yaml`). Messages et logs alignés ;
les deux sondes coexistent : `/health` (globale, utilisée par Render) et
`/​__static_health` (légère). `README.md` corrigé en conséquence.

### 5. Admin : bouton « Modifier » des questions — LIVRÉ
Contrairement au précédent résumé : `QuestionsBank.tsx` expose déjà
« Modifier » (aria-label `Modifier la question …`), `AdminDashboard.tsx`
gère `editingQuestion` + `PATCH /api/questions/:id` + modale
« Modifier la Question ». Endpoint `PATCH` tracé en audit côté serveur.

### 6. Vérifications
- `node scripts/typecheck.mjs` : backend + les 3 apps passent.
- `npm run test:back` : 259 tests, 0 échec (à relancer après ces changements).
- `npm run render:check` : blueprint cohérent (aucune modification `render.yaml`).

## Fichiers touchés (cette passe)
- `backend/src/lib/broadcastFlow.ts`
- `backend/src/db/schema.ts`
- `backend/src/server/matchEngine.ts`
- `backend/src/server/static.ts`
- `backend/drizzle/0007_add_duel_category_and_questions.sql` (correction + idempotence)
- `backend/drizzle/0011_broadcast_default_question.sql` (nouveau)
- `backend/drizzle/meta/_journal.json` (entrée idx 9)
- `README.md` (sondes `static`)

## Reste volontairement inchangé
- `meta/_journal.json` pour `0006`/`0007` : toujours hors journal (destructif /
  données). Ne pas les y ajouter sans reconciler la prod au préalable.
- `render.yaml` : aucune modification (vérifié par `render:check`).
- Découpage `AdminDashboard.tsx` (2473 lignes) : chantier de refactor, pas un
  correctif — à planifier hors urgence.
