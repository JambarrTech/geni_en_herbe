import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { participants } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireJuryOrAdmin, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { isForeignKeyViolation, FK_DELETE_MESSAGES } from '../lib/dbErrors.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';
import { validateIds } from '../lib/validate.ts';
import { createLogger } from '../lib/logger.ts';

const log = createLogger('api');

export const participantsRouter = Router();

// Valide :id et :memberId une seule fois pour toutes les routes de ce
// routeur : 400 explicite sur un identifiant malforme, au lieu d'un NaN
// qui partait en requete SQL et revenait en 404 trompeur ou en 500.
validateIds(participantsRouter);

// Données personnelles de participants (date de naissance, téléphone, email,
// photo) : lection et pour des mineurs. Accès restreint au staff connecté —
// cette route était ouverte à tous, sans aucun jeton.
participantsRouter.get('/', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const list = await db
      .select({
        id: participants.id,
        firstName: participants.firstName,
        lastName: participants.lastName,
        gender: participants.gender,
        dateOfBirth: participants.dateOfBirth,
        phone: participants.phone,
        email: participants.email,
        photo: participants.photo,
        active: participants.active,
        createdAt: participants.createdAt,
      })
      .from(participants)
      .orderBy(participants.lastName, participants.firstName);

    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger les participants' });
  }
});

participantsRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { firstName, lastName, gender, dateOfBirth, phone, email, photo } = req.body;
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Prénom et nom sont obligatoires' });
    }

    const [newParticipant] = await db
      .insert(participants)
      .values({
        firstName,
        lastName,
        gender: gender || 'M',
        dateOfBirth,
        phone,
        email,
        photo,
        active: true,
      })
      .returning();

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'CREATE_PARTICIPANT',
      'participant',
      String(newParticipant.id)
    );
    res.status(201).json(newParticipant);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de l\'enregistrement' });
  }
});

participantsRouter.patch('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { firstName, lastName, gender, dateOfBirth, phone, email, active } = req.body;
    const [updated] = await db
      .update(participants)
      .set({
        ...(firstName && { firstName }),
        ...(lastName && { lastName }),
        ...(gender && { gender }),
        ...(dateOfBirth !== undefined && { dateOfBirth }),
        ...(phone !== undefined && { phone }),
        ...(email !== undefined && { email }),
        ...(active !== undefined && { active }),
      })
      .where(eq(participants.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Participant non trouvé' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise à jour' });
  }
});

participantsRouter.delete('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.delete(participants).where(eq(participants.id, id));
    await logAudit(
      req.user?.uid,
      req.user?.email,
      'DELETE_PARTICIPANT',
      'participant',
      String(id)
    );
    res.json({ success: true });
  } catch (error: any) {
    log.error('DELETE participant error', { err: error });
    if (isForeignKeyViolation(error)) {
      return res.status(400).json({ error: FK_DELETE_MESSAGES.participant });
    }
    res.status(500).json({ error: 'Erreur lors de la suppression du participant' });
  }
});

