import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { categories } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireJuryOrAdmin, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { isForeignKeyViolation, FK_DELETE_MESSAGES } from '../lib/dbErrors.ts';

export const categoriesRouter = Router();

categoriesRouter.get('/', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const allCats = await db.select().from(categories).orderBy(categories.name);
    res.json(allCats);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger les catégories' });
  }
});

categoriesRouter.post('/', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom de catégorie requis' });
    const [newCat] = await db
      .insert(categories)
      .values({ name, description, active: true })
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'CREATE_CATEGORY', 'category', String(newCat.id));
    res.status(201).json(newCat);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur création catégorie' });
  }
});

categoriesRouter.patch('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, active } = req.body;
    const [updated] = await db
      .update(categories)
      .set({
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(active !== undefined && { active }),
      })
      .where(eq(categories.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Catégorie non trouvée' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise à jour de la catégorie' });
  }
});

categoriesRouter.delete('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.delete(categories).where(eq(categories.id, id));
    await logAudit(req.user?.uid, req.user?.email, 'DELETE_CATEGORY', 'category', String(id));
    res.json({ success: true });
  } catch (error: any) {
    console.error('DELETE category error:', error);
    if (isForeignKeyViolation(error)) {
      return res.status(400).json({ error: FK_DELETE_MESSAGES.category });
    }
    res.status(500).json({ error: 'Erreur lors de la suppression de la catégorie' });
  }
});