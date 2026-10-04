import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { categories, questions } from '../db/schema.ts';
import { asc, eq, sql } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireJuryOrAdmin, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { isForeignKeyViolation, FK_DELETE_MESSAGES } from '../lib/dbErrors.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';
import { validateIds } from '../lib/validate.ts';
import { createLogger } from '../lib/logger.ts';

const log = createLogger('api');

export const categoriesRouter = Router();

// Valide :id et :memberId une seule fois pour toutes les routes de ce
// routeur : 400 explicite sur un identifiant malforme, au lieu d'un NaN
// qui partait en requete SQL et revenait en 404 trompeur ou en 500.
validateIds(categoriesRouter);

categoriesRouter.get('/', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    // Ordre d'affichage décidé par l'admin (`position`), puis nom pour les
    // ex aequo : c'est cet ordre qui groupe la banque et ouvre l'écran public.
    const allCats = await db
      .select({
        id: categories.id,
        name: categories.name,
        description: categories.description,
        position: categories.position,
        active: categories.active,
        createdAt: categories.createdAt,
        questionsCount: sql<number>`count(${questions.id})::int`,
      })
      .from(categories)
      .leftJoin(questions, eq(questions.categoryId, categories.id))
      .groupBy(categories.id)
      .orderBy(asc(categories.position), asc(categories.name));
    res.json(allCats);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger les catégories' });
  }
});

// Réorganisation complète : l'admin envoie les identifiants dans l'ordre
// d'affichage voulu, la première position ouvre l'écran public.
// Déclarée AVANT `/:id` : sans paramètre, `validateIds` ne s'applique pas.
categoriesRouter.post('/reorder', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'La liste ordonnée des identifiants est obligatoire' });
    }
    const ordered = [...new Set(ids.map((id) => parseInt(id, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (ordered.length === 0) {
      return res.status(400).json({ error: 'Aucun identifiant de catégorie valide' });
    }

    const existing = await db.select({ id: categories.id }).from(categories);
    const known = new Set(existing.map((c) => c.id));
    const unknown = ordered.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return res.status(404).json({ error: `Catégories introuvables : ${unknown.join(', ')}` });
    }

    await db.transaction(async (tx) => {
      let position = 1;
      for (const id of ordered) {
        await tx.update(categories).set({ position }).where(eq(categories.id, id));
        position += 1;
      }
      // Les catégories absentes de la liste gardent l'ordre relatif et passent
      // après : aucune ne disparaît de l'affichage par accident.
      const rest = existing
        .map((c) => c.id)
        .filter((id) => !ordered.includes(id))
        .sort((a, b) => a - b);
      for (const id of rest) {
        await tx.update(categories).set({ position }).where(eq(categories.id, id));
        position += 1;
      }
    });

    await logAudit(req.user?.uid, req.user?.email, 'REORDER_CATEGORIES', 'category', ordered.join(','));
    const reordered = await db
      .select()
      .from(categories)
      .orderBy(asc(categories.position), asc(categories.name));
    res.json(reordered);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de réorganisation des catégories' });
  }
});

categoriesRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom de catégorie requis' });
    // Une nouvelle catégorie passe en DERNIER : elle ne doit pas voler la
    // première place — donc l'ouverture de l'écran public — par surprise.
    const [{ max }] = await db
      .select({ max: sql<number | null>`max(${categories.position})` })
      .from(categories);
    const [newCat] = await db
      .insert(categories)
      .values({ name, description, position: (max ?? 0) + 1, active: true })
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'CREATE_CATEGORY', 'category', String(newCat.id));
    res.status(201).json(newCat);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur création catégorie' });
  }
});

categoriesRouter.patch('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, active, position } = req.body;
    let parsedPosition: number | undefined;
    if (position !== undefined) {
      parsedPosition = parseInt(position, 10);
      if (!Number.isInteger(parsedPosition) || parsedPosition < 0) {
        return res.status(400).json({ error: 'Position invalide : un entier positif ou nul est attendu' });
      }
    }
    const [updated] = await db
      .update(categories)
      .set({
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(active !== undefined && { active }),
        ...(parsedPosition !== undefined && { position: parsedPosition }),
      })
      .where(eq(categories.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Catégorie non trouvée' });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise à jour de la catégorie' });
  }
});

categoriesRouter.delete('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Même raison que pour les équipes et les membres : `DELETE` sur un
    // identifiant inconnu renvoyait `success`, et l'appelant croyait avoir
    // supprimé quelque chose.
    const [cible] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, id));
    if (!cible) return res.status(404).json({ error: 'Catégorie introuvable' });

    await db.delete(categories).where(eq(categories.id, id));
    await logAudit(req.user?.uid, req.user?.email, 'DELETE_CATEGORY', 'category', String(id));
    res.json({ success: true });
  } catch (error: any) {
    log.error('DELETE category error', { err: error });
    if (isForeignKeyViolation(error)) {
      return res.status(400).json({ error: FK_DELETE_MESSAGES.category });
    }
    res.status(500).json({ error: 'Erreur lors de la suppression de la catégorie' });
  }
});

