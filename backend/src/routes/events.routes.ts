import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { events } from '../db/schema.ts';
import { eq, desc, and, not } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireJuryOrAdmin, type AuthRequest } from '../middleware/auth.ts';
import {
  calculateRankings,
  getLiveState,
  broadcast,
  logAudit,
} from '../server/matchEngine.ts';
import { isForeignKeyViolation, FK_DELETE_MESSAGES } from '../lib/dbErrors.ts';
import { FLOW } from '../config.ts';
import { matches } from '../db/schema.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';
import { validateIds } from '../lib/validate.ts';
import { createLogger } from '../lib/logger.ts';

const log = createLogger('api');

export const eventsRouter = Router();

// Valide :id et :memberId une seule fois pour toutes les routes de ce
// routeur : 400 explicite sur un identifiant malforme, au lieu d'un NaN
// qui partait en requete SQL et revenait en 404 trompeur ou en 500.
validateIds(eventsRouter);

const VALID_EVENT_STATUS: readonly string[] = Object.values(FLOW.EVENT_STATUS);

eventsRouter.get('/', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const allEvents = await db.select().from(events).orderBy(desc(events.id));
    res.json(allEvents);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de récupérer les événements' });
  }
});

eventsRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { name, edition, description, startDate, endDate, location } = req.body;
    if (!name || !edition) {
      return res.status(400).json({ error: 'Le nom et l\'édition de l\'événement sont requis' });
    }

    const [newEvent] = await db
      .insert(events)
      .values({
        name,
        edition,
        description,
        startDate,
        endDate,
        location,
        status: 'READY',
        resultsPublished: false,
      })
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'CREATE_EVENT', 'event', String(newEvent.id));
    res.status(201).json(newEvent);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la création de l\'événement' });
  }
});

eventsRouter.patch('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, edition, description, startDate, endDate, location, status } = req.body;

    // Le statut est une enum métier (FLOW.EVENT_STATUS) : sans validation,
    // ce PATCH acceptait `status: "BANANA"` et la colonne text libre stockait
    // une valeur que plus aucun code ne sait interpréter.
    if (status !== undefined && !VALID_EVENT_STATUS.includes(status)) {
      return res.status(400).json({
        error: `Statut invalide (valides : ${VALID_EVENT_STATUS.join(', ')})`,
      });
    }

    const [updated] = await db
      .update(events)
      .set({
        ...(name && { name }),
        ...(edition && { edition }),
        ...(description !== undefined && { description }),
        ...(startDate !== undefined && { startDate }),
        ...(endDate !== undefined && { endDate }),
        ...(location && { location }),
        ...(status && { status }),
        updatedAt: new Date(),
      })
      .where(eq(events.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Événement introuvable' });

    await logAudit(req.user?.uid, req.user?.email, 'UPDATE_EVENT', 'event', String(id));
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise à jour' });
  }
});

// Manual Results Publication
eventsRouter.post('/:id/publish-results', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const eventId = parseInt(req.params.id, 10);

    // Préconditions serveur. Sans elles, un simple clic en plein tournoi
    // basculait l'écran public en mode « résultats officiels » et figeait
    // l'affichage du match en cours. La publication est un acte terminal :
    // on refuse si l'événement n'est pas terminé ou s'il reste des matchs
    // SCHEDULED / READY / LIVE / PAUSED.
    const [event] = await db.select().from(events).where(eq(events.id, eventId));
    if (!event) return res.status(404).json({ error: 'Événement introuvable' });

    const unfinished = await db
      .select({
        id: matches.id,
        status: matches.status,
        phase: matches.phase,
        matchNumber: matches.matchNumber,
      })
      .from(matches)
      .where(
        and(
          eq(matches.eventId, eventId),
          not(eq(matches.status, FLOW.MATCH_STATUS.FINISHED)),
          not(eq(matches.status, FLOW.MATCH_STATUS.CANCELLED))
        )
      )
      .limit(10);

    if (unfinished.length > 0) {
      return res.status(409).json({
        error:
          `Publication impossible : ${unfinished.length} match(s) non clôturé(s) sur cet événement ` +
          `(ex. #${unfinished[0].matchNumber} — ${unfinished[0].phase} : ${unfinished[0].status}). ` +
          `Terminez ou annulez-les d'abord.`,
        pendingMatches: unfinished,
      });
    }

    const [updatedEvent] = await db
      .update(events)
      .set({
        resultsPublished: true,
        status: FLOW.EVENT_STATUS.RESULTS_PUBLISHED,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();

    const rankings = await calculateRankings(eventId);

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'PUBLISH_RESULTS',
      'event',
      String(eventId),
      'Publication manuelle officielle des résultats finaux'
    );

    // WebSocket broadcast via the shared hook (no overwrite of the callback)
    const liveState = await getLiveState(eventId, true);
    broadcast('results_published', { eventId, rankings, liveState });

    res.json({
      success: true,
      message: 'Résultats officiels publiés avec succès.',
      event: updatedEvent,
      rankings,
    });
  } catch (error: any) {
    log.error('Erreur publication résultats', { err: error });
    res.status(500).json({ error: 'Erreur lors de la publication des résultats' });
  }
});

eventsRouter.post('/:id/unpublish-results', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const eventId = parseInt(req.params.id, 10);
    const [event] = await db
      .update(events)
      .set({
        resultsPublished: false,
        status: FLOW.EVENT_STATUS.FINISHED,
        updatedAt: new Date(),
      })
      .where(eq(events.id, eventId))
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'UNPUBLISH_RESULTS', 'event', String(eventId));

    broadcast('results_unpublished', { eventId });

    res.json({ success: true, event });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de l\'annulation de publication' });
  }
});

eventsRouter.delete('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.delete(events).where(eq(events.id, id));
    await logAudit(req.user?.uid, req.user?.email, 'DELETE_EVENT', 'event', String(id));
    res.json({ success: true });
  } catch (error: any) {
    log.error('DELETE event error', { err: error });
    if (isForeignKeyViolation(error)) {
      return res.status(400).json({ error: FK_DELETE_MESSAGES.event });
    }
    res.status(500).json({ error: 'Erreur lors de la suppression de l\'événement' });
  }
});

