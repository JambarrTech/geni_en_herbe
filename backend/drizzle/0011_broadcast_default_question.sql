-- Étape ROSTER supprimée : le scénario démarre à QUESTION.
--
-- 1. `SET DEFAULT 'QUESTION'` : tout match créé hors route (SQL, import)
--    affiche immédiatement la première question, comme ceux créés par
--    `POST /api/matches` (qui écrit explicitement QUESTION).
-- 2. Les lignes existantes restées sur 'ROSTER' sont basculées sur
--    'QUESTION' à index inchangé : c'est exactement ce que `normalizeCursor`
--    faisait déjà virtuellement à la lecture, la migration rend l'état durable
--    (le jury n'a plus besoin du bouton « recommencer » pour sortir de ROSTER).
-- 3. `broadcast_roster_until` est remis à NULL : aucune bascule automatique
--    n'est programmée (les routes écrivent déjà NULL à chaque pas).
ALTER TABLE "matches" ALTER COLUMN "broadcast_stage" SET DEFAULT 'QUESTION';--> statement-breakpoint
UPDATE "matches" SET "broadcast_stage" = 'QUESTION' WHERE "broadcast_stage" = 'ROSTER';--> statement-breakpoint
UPDATE "matches" SET "broadcast_roster_until" = NULL WHERE "broadcast_roster_until" IS NOT NULL;
