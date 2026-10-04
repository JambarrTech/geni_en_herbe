-- Ajout de la catégorie DUEL et de 4 questions pour le mode duel
-- ============================================================
-- NOTE : cette migration n'est PAS journalisée (`meta/_journal.json`) : elle
-- n'est jouée qu'à la main, une seule fois, après vérification en lecture
-- seule (cf. docs/CHECKLIST-JOUR-J.md). Les gardes `NOT EXISTS` la rendent
-- rejouable sans doublon si elle a déjà été appliquée partiellement.
--
-- Noms de colonnes en snake_case (`time_limit_seconds`, …) : les identifiants
-- camelCase ne correspondent à aucune colonne et feraient échouer le script.

-- 1. Catégorie "DUEL" (une seule fois)
INSERT INTO "categories" ("name", "description", "active")
SELECT 'DUEL', 'Questions thématiques pour le mode duel', true
WHERE NOT EXISTS (SELECT 1 FROM "categories" WHERE "name" = 'DUEL');

-- 2. Quatre questions rattachées à la catégorie DUEL et au premier événement.
-- Chaque INSERT est gardé par l'existence du même énoncé : rejouer le fichier
-- ne duplique rien.
-- Q1: Quelle est le nom de notre Galaxie ? - Réponse: la voie lactée
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "time_limit_seconds", "options", "explanation")
SELECT (SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'Quelle est le nom de notre Galaxie ?',
  'la voie lactée',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La réponse attendue est "la voie lactée"'
WHERE EXISTS (SELECT 1 FROM "categories" WHERE "name" = 'DUEL')
  AND NOT EXISTS (SELECT 1 FROM "questions" WHERE "text" = 'Quelle est le nom de notre Galaxie ?');
-- Q2: ما جمع كلمة سور؟ - Réponse: سور (pluriel de "sour")
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "time_limit_seconds", "options", "explanation")
SELECT (SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'ما جمع كلمة سور؟سور',
  'سور',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La réponse attendue est "سور" (pluriel de "sour")'
WHERE EXISTS (SELECT 1 FROM "categories" WHERE "name" = 'DUEL')
  AND NOT EXISTS (SELECT 1 FROM "questions" WHERE "text" = 'ما جمع كلمة سور؟سور');
-- Q3: Quel est le deuxième pays le plus peuple? - Réponse: Inde
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "time_limit_seconds", "options", "explanation")
SELECT (SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'Quel est le deuxième pays le plus peuple?',
  'Inde',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La deuxième population mondiale après la Chine'
WHERE EXISTS (SELECT 1 FROM "categories" WHERE "name" = 'DUEL')
  AND NOT EXISTS (SELECT 1 FROM "questions" WHERE "text" = 'Quel est le deuxième pays le plus peuple?');
-- Q4: ما جمع تراب؟ - Réponse: أتراب (pluriel de "trab")
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "time_limit_seconds", "options", "explanation")
SELECT (SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'ما جمع تراب؟أتراب',
  'أتراب',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La réponse attendue est "أتراب" (pluriel de "trab")'
WHERE EXISTS (SELECT 1 FROM "categories" WHERE "name" = 'DUEL')
  AND NOT EXISTS (SELECT 1 FROM "questions" WHERE "text" = 'ما جمع تراب؟أتراب');
-- Note: Pour le mode duel, les règles sont :
-- - Questions collectives à 20s (voir config)
-- - Droit de répliquer du vis-à-vis à 10pts
-- - Le chrono débute lorsque l'étape QUESTION est atteinte
