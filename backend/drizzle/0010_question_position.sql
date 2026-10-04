-- Ordre des questions dans leur catégorie.
--
-- Une catégorie regroupe plusieurs questions, et l'ordre dans lequel elles
-- se présentent (banque groupée, sélection d'un match) est un choix du
-- comité, pas un hasard d'identifiant : `position` vaut 1 pour la première
-- question de la catégorie, 2 pour la suivante, etc.
--
-- Les questions existantes sont initialisées dans l'ordre de création
-- (identifiant croissant), par catégorie, pour un état de départ stable.
ALTER TABLE "questions" ADD COLUMN "position" integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE "questions" SET "position" = sub.rn FROM (SELECT "id", ROW_NUMBER() OVER (PARTITION BY "category_id" ORDER BY "id")::int AS rn FROM "questions") AS sub WHERE "questions"."id" = sub."id";
