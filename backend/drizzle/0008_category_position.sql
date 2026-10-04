-- Ordre d'affichage des catégories.
--
-- Une catégorie regroupe plusieurs questions, et l'ordre dans lequel les
-- catégories passent à l'écran public est un choix du comité, pas un hasard
-- d'insertion : la catégorie en première position est celle dont les questions
-- ouvrent le match et s'affichent en premier sur l'écran public.
--
-- `position` vaut 1 pour la première catégorie affichée, 2 pour la suivante,
-- etc. Les catégories existantes sont initialisées dans l'ordre
-- alphabétique, pour un état de départ déterministe.
--
-- NULLABLE à l'ajout puis rempli aussitôt : `ADD COLUMN ... NOT NULL DEFAULT 0`
-- suffit, le backfill écrase le 0 dans la foulée.
ALTER TABLE "categories" ADD COLUMN "position" integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE "categories" SET "position" = sub.rn FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "name", "id")::int AS rn FROM "categories") AS sub WHERE "categories"."id" = sub."id";
