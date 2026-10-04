-- Ajout de la catégorie DUEL et de 4 questions pour le mode duel
-- ============================================================

-- 1. Ajout de la catégorie "DUEL"
INSERT INTO "categories" ("name", "description", "active")
VALUES ('DUEL', 'Questions thématiques pour le mode duel', true);

-- 2. Ajout de 4 questions pour le mode duel
-- Questions associées au premier événement (event_id = 1)
-- Format: question, answer (bonne réponse), type, difficulty, points, timeLimitSeconds, options (JSON pour QCM), explanation

-- Q1: Quelle est le nom de notre Galaxie ? - Réponse: la voie lactée
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "timeLimitSeconds", "options", "explanation")
VALUES ((SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'Quelle est le nom de notre Galaxie ?',
  'la voie lactée',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La réponse attendue est "la voie lactée"'

-- Q2: ما جمع كلمة سور?سور - C''est la forme plurielle de "sour"
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "timeLimitSeconds", "options", "explanation")
VALUES ((SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'ما جمع كلمة سور؟سور',
  'سور',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La réponse attendue est "سور" (pluriel de "sour")'

-- Q3: Quel est le deuxième pays le plus peuple? - Réponse: Inde
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "timeLimitSeconds", "options", "explanation")
VALUES ((SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'Quel est le deuxième pays le plus peuple?',
  'Inde',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La deuxième population mondiale après la Chine'

-- Q4: ما جمع تراب؟أتراب - C''est la forme plurielle de "trab"
INSERT INTO "questions" ("category_id", "event_id", "text", "answer", "type", "difficulty", "points", "timeLimitSeconds", "options", "explanation")
VALUES ((SELECT id FROM "categories" WHERE "name" = 'DUEL'), 1,
  'ما جمع تراب؟أتراب',
  'أتراب',
  'DIRECT',
  'MOYEN',
  10,
  15,
  NULL,
  'La réponse attendue est "أتراب" (pluriel de "trab")'

-- Note: Pour le mode duel, les règles sont :
-- - Questions collectives à 20s (voir config)
-- - Droit de répliquer du vis-à-vis à 10pts
-- - Le chrono débute lorsque l''étape QUESTION est atteinte