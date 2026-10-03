-- Nettoyage du schéma : suppression colonne legacy + types de dates corrects
-- =========================================================================
-- 1. Suppression de `users.uid` (legacy Firebase Auth, plus utilisé depuis
--    la migration vers l'authentification email/mot de passe pure).
--    La colonne était `NOT NULL UNIQUE` : on la rend nullable d'abord,
--    puis on la supprime pour éviter les erreurs sur les lignes existantes.
-- 2. Conversion `events.start_date`, `events.end_date` de `text` vers `date`.
--    Les valeurs existantes sont au format ISO 'YYYY-MM-DD' : cast direct.
-- 3. Conversion `participants.date_of_birth` de `text` vers `date`.
--    Même format ISO : cast direct. Les valeurs NULL restent NULL.

BEGIN;

-- 1. users.uid : legacy Firebase
ALTER TABLE "users" ALTER COLUMN "uid" DROP NOT NULL;
ALTER TABLE "users" DROP COLUMN "uid";

-- 2. events.start_date -> date
ALTER TABLE "events" ALTER COLUMN "start_date" TYPE date USING "start_date"::date;
ALTER TABLE "events" ALTER COLUMN "end_date" TYPE date USING "end_date"::date;

-- 3. participants.date_of_birth -> date
ALTER TABLE "participants" ALTER COLUMN "date_of_birth" TYPE date USING "date_of_birth"::date;

COMMIT;