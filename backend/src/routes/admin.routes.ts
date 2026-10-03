import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { auditLogs, competitionSettings } from '../db/schema.ts';
import { desc, sql } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireJuryOrAdmin, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';

export const adminRouter = Router();

// Journal d'audit — pagination : ?page=1&limit=50 (défaut 50, max 200)
adminRouter.get('/api/audit-logs', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const offset = (page - 1) * limit;

    const [logs, [{ total }]] = await Promise.all([
      db
        .select()
        .from(auditLogs)
        .orderBy(desc(auditLogs.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(auditLogs),
    ]);

    res.json({
      data: logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger le journal d\'audit' });
  }
});

// Les réglages de compétition décrivent les règles officielles : accès staff.
adminRouter.get('/api/settings', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const settings = await db.select().from(competitionSettings);
    res.json(settings);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger les réglages' });
  }
});

adminRouter.patch('/api/settings', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { settings } = req.body; // Array of { key, value }
    if (!Array.isArray(settings)) {
      return res.status(400).json({ error: 'Format de réglages invalide' });
    }

    for (const s of settings) {
      await db
        .insert(competitionSettings)
        .values({ key: s.key, value: String(s.value), description: s.description || '' })
        .onConflictDoUpdate({
          target: competitionSettings.key,
          set: { value: String(s.value) },
        });
    }

    await logAudit(req.user?.uid, req.user?.email, 'UPDATE_SETTINGS', 'settings', 'all');
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur mise à jour réglages' });
  }
});
