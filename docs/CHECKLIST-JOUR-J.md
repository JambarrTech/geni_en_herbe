# Checklist jour de match — AEERKS Génie en Herbe

À exécuter dans l'ordre, **2 h avant la salle**. Chaque étape a un critère
d'arrêt : si elle échoue, on ne passe pas à la suivante.

## 1. Réveiller le service (plan gratuit = mise en veille)
- Ouvrir l'URL publique Render et l'écran `/health` : attendre un `200`.
- Critère : la page d'accueil charge en moins de ~30 s (cold start normal).

## 2. Vérifier le dernier déploiement
- Dashboard Render → onglet **Logs** du dernier déploiement :
  - `[migrate] migrations enregistrées dans la base` sans `ECHEC`.
  - `Build de apps/live : OK`, `apps/jury : OK`, `apps/admin : OK`.
- Critère : statut **Live** sur le commit attendu. Un build en échec laisse
  l'ancienne version en ligne : ne jamais « forcer » un déploiement douteux.

## 3. Vérifier l'état réel de la base (décision migrations — ne pas changer)
- `0006_cleanup_schema.sql` et `0007_add_duel_category_and_questions.sql`
  existent dans le dépôt mais ne sont **pas** journalisés : le migrateur ne
  les joue pas (les rejouer casserait le déploiement si déjà appliqués).
- Requêtes de constat (console SQL Neon ou `psql`), **lecture seule** :
  ```sql
  SELECT tag FROM drizzle.__drizzle_migrations ORDER BY created_at;
  SELECT column_name FROM information_schema.columns
    WHERE table_name = 'categories' AND column_name = 'position';
  SELECT id, name, position FROM categories ORDER BY position, name;
  SELECT count(*) FROM questions;
  ```
- Critère : `0008_category_position` est enregistrée, `categories.position`
  existe, les catégories et questions attendues sont présentes.

## 4. Sauvegarde avant la compétition
- Neon : créer un point de restauration / une branche de la base, ou à défaut
  `pg_dump` local horodaté.
- Critère : sauvegarde nommée `avant-match-YYYY-MM-DD` confirmée.

## 5. Match test de bout en bout (jury → public → podium)
1. Compte jury : connexion OK, table du jury accessible.
2. Programmer un match test (2 équipes), le lancer : **la 1re question de la
   catégorie placée en premier** s'affiche sur l'écran public.
3. Attribuer des points : vérifier que l'écran public ne montre ni totaux
   ni annonce — seule la diapositive de la question reste affichée.
4. Avancer/reculer avec « Étape suivante » : la diapositive change sur
   l'écran public (question suivante/précédente).
5. Révéler une réponse, passer à l'étape FINAL : les scores finaux
   apparaissent. Clôturer le match.
4. Vérifier le podium général ET le podium par catégorie (onglet Résultats).
5. Publier puis masquer les résultats (bouton officiel).
6. Supprimer ou annuler le match test (ne pas fausser le classement du soir).
- Critère : chaque écran montre la même chose au même moment (jury = public).

## 6. Pendant la compétition
- Un seul match `LIVE` à la fois (l'API le refuse sinon).
- Règle d'arbitrage : **le podium par catégorie est indicatif, seul le total
  du match fait foi** (pénalités non planchées par catégorie).
- En cas de doute sur un score : ne pas supprimer, **annuler** le résultat
  (l'audit est conservé, le rétablissement reste possible).

## 7. En cas de panne
- Écran figé : vérifier `/health`, puis les logs Render (`api`, `worker`).
- Ne jamais éditer le schéma à la main pendant la compétition : toute
  correction de données passe par l'interface admin (traçée en audit).
