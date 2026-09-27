import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { events } from '../db/schema.ts';
import { desc, eq } from 'drizzle-orm';
import { calculateRankings, getLiveState } from '../server/matchEngine.ts';

export const liveRouter = Router();

/**
 * Résout l'événement « courant » : le plus récent par id.
 * Centralisé ici pour que /api/rankings et /api/live désignent toujours le MÊME
 * événement. Avant, /api/rankings faisait `.limit(1)` sans ORDER BY : avec
 * plusieurs éditions, PostgreSQL pouvait renvoyer n'importe quelle ligne et les
 * deux endpoints publics affichaient des classements d'événements différents.
 */
async function resolveCurrentEventId(explicit?: string | undefined): Promise<number | null> {
  if (explicit) {
    const parsed = parseInt(explicit, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const [ev] = await db
    .select({ id: events.id })
    .from(events)
    .orderBy(desc(events.id))
    .limit(1);
  return ev?.id ?? null;
}

liveRouter.get('/api/rankings', async (_req, res: Response) => {
  try {
    const eventId = await resolveCurrentEventId(_req.query.eventId as string | undefined);
    if (eventId == null) return res.json([]);
    const rankings = await calculateRankings(eventId);
    res.json(rankings);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de calculer le classement' });
  }
});

liveRouter.get('/api/live', async (_req, res: Response) => {
  try {
    const raw = _req.query.eventId as string | undefined;
    const parsed = raw ? parseInt(raw, 10) : NaN;
    const eventId = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    // Requête explicite : inclure le classement dans l'état live
    const liveState = await getLiveState(eventId, true);
    res.json(liveState);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors du chargement du flux Live' });
  }
});

liveRouter.get('/api/events/:id/live', async (req, res: Response) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ error: 'Identifiant d\'événement invalide' });
    }
    const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId));
    if (!ev) return res.status(404).json({ error: 'Événement introuvable' });
    const liveState = await getLiveState(eventId, true);
    res.json(liveState);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors du chargement du flux Live' });
  }
});
