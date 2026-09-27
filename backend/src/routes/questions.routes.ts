import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { questions, categories } from '../db/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { CONFIG, FLOW } from '../config.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';
import { validateIds } from '../lib/validate.ts';

export const questionsRouter = Router();

// Valide :id et :memberId une seule fois pour toutes les routes de ce
// routeur : 400 explicite sur un identifiant malforme, au lieu d'un NaN
// qui partait en requete SQL et revenait en 404 trompeur ou en 500.
validateIds(questionsRouter);

const VALID_TYPES: readonly string[] = Object.values(FLOW.QUESTION_TYPE);
const VALID_DIFFICULTIES: readonly string[] = Object.values(FLOW.DIFFICULTY);

function parseOptions(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    console.error('options question mal formées (JSON invalide)');
    return null;
  }
}

function sanitizeOptions(options: unknown): string[] | null {
  if (options === undefined || options === null) return null;
  const list = Array.isArray(options)
    ? options
    : String(options)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  const cleaned = list
    .map((o) => String(o).trim())
    .filter((o) => o.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

function validateQuestionPayload(body: any, partial: boolean) {
  const errors: string[] = [];

  if (body.type !== undefined) {
    const t = String(body.type).toUpperCase();
    if (!VALID_TYPES.includes(t)) return { error: `Type de question invalide (valides : ${VALID_TYPES.join(', ')})` };
    body.type = t;
  }

  if (body.difficulty !== undefined) {
    const d = String(body.difficulty).toUpperCase();
    if (!VALID_DIFFICULTIES.includes(d)) {
      return { error: 'Difficulté invalide (valides : FACILE, MOYEN, DIFFICILE)' };
    }
    body.difficulty = d;
  }

  if (body.points !== undefined) {
    const p = parseInt(body.points, 10);
    if (Number.isNaN(p) || p < CONFIG.MIN_QUESTION_POINTS || p > CONFIG.MAX_QUESTION_POINTS) {
      return { error: `Points hors bornes (${CONFIG.MIN_QUESTION_POINTS} à ${CONFIG.MAX_QUESTION_POINTS} pts)` };
    }
    body.points = p;
  } else if (!partial) {
    body.points = CONFIG.DEFAULT_QUESTION_POINTS;
  }

  if (body.timeLimitSeconds !== undefined) {
    const t = parseInt(body.timeLimitSeconds, 10);
    if (Number.isNaN(t) || t < CONFIG.MIN_QUESTION_TIME_SECONDS || t > CONFIG.MAX_QUESTION_TIME_SECONDS) {
      return { error: `Temps hors bornes (${CONFIG.MIN_QUESTION_TIME_SECONDS} à ${CONFIG.MAX_QUESTION_TIME_SECONDS} secondes)` };
    }
    body.timeLimitSeconds = t;
  } else if (!partial) {
    body.timeLimitSeconds = CONFIG.DEFAULT_TIMER_SECONDS;
  }

  if (body.type === undefined && !partial) body.type = FLOW.QUESTION_TYPE.DIRECT;
  if (body.difficulty === undefined && !partial) body.difficulty = FLOW.DIFFICULTY.MOYEN;

  if (body.options !== undefined) {
    const opts = sanitizeOptions(body.options);
    if (body.type === FLOW.QUESTION_TYPE.QCM && (!opts || opts.length < 2)) {
      return { error: 'Une question QCM exige au moins 2 options' };
    }
    body.options = opts;
  }

  if (body.type === FLOW.QUESTION_TYPE.QCM && !partial) {
    const opts = sanitizeOptions(body.options);
    if (!opts || opts.length < 2) {
      return { error: 'Une question QCM exige au moins 2 options' };
    }
    body.options = opts;
  }

  return errors.length ? { error: errors.join('; ') } : null;
}

// La banque de questions contient les réponses officielles : accès ADMIN uniquement
questionsRouter.get('/', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const list = await db
      .select({
        id: questions.id,
        categoryId: questions.categoryId,
        categoryName: categories.name,
        eventId: questions.eventId,
        text: questions.text,
        answer: questions.answer,
        type: questions.type,
        difficulty: questions.difficulty,
        points: questions.points,
        timeLimitSeconds: questions.timeLimitSeconds,
        options: questions.options,
        explanation: questions.explanation,
        mediaUrl: questions.mediaUrl,
        active: questions.active,
        createdAt: questions.createdAt,
      })
      .from(questions)
      .innerJoin(categories, eq(questions.categoryId, categories.id))
      .orderBy(desc(questions.id));

    const parsed = list.map((q) => ({
      ...q,
      options: parseOptions(q.options),
    }));

    res.json(parsed);
  } catch (error: any) {
    console.error('Erreur chargement questions:', error);
    res.status(500).json({ error: 'Impossible de charger les questions' });
  }
});

questionsRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    // `type`, `difficulty`, `points`, `timeLimitSeconds` et `options` sont relus
    // depuis req.body après validateQuestionPayload(), qui les normalise et les
    // valide. Les déstructurer ici était redondant (et inutilisé).
    const { categoryId, eventId, text, answer, explanation } = req.body;

    if (!categoryId || !text || !answer) {
      return res.status(400).json({ error: 'Catégorie, texte et réponse officielle sont obligatoires' });
    }

    const validationError = validateQuestionPayload(req.body, false);
    if (validationError) {
      return res.status(400).json(validationError);
    }

    const [newQ] = await db
      .insert(questions)
      .values({
        categoryId: parseInt(categoryId, 10),
        eventId: eventId ? parseInt(eventId, 10) : null,
        text,
        answer,
        type: req.body.type,
        difficulty: req.body.difficulty,
        points: req.body.points,
        timeLimitSeconds: req.body.timeLimitSeconds,
        options: req.body.options ? JSON.stringify(req.body.options) : null,
        explanation,
        active: true,
      })
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'CREATE_QUESTION', 'question', String(newQ.id));
    res.status(201).json(newQ);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la création de la question' });
  }
});

questionsRouter.patch('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { categoryId, text, answer, explanation, active } = req.body;

    const validationError = validateQuestionPayload(req.body, true);
    if (validationError) {
      return res.status(400).json(validationError);
    }

    const [updated] = await db
      .update(questions)
      .set({
        ...(categoryId && { categoryId: parseInt(categoryId, 10) }),
        ...(text && { text }),
        ...(answer && { answer }),
        ...(req.body.type !== undefined && { type: req.body.type }),
        ...(req.body.difficulty !== undefined && { difficulty: req.body.difficulty }),
        ...(req.body.points !== undefined && { points: req.body.points }),
        ...(req.body.timeLimitSeconds !== undefined && { timeLimitSeconds: req.body.timeLimitSeconds }),
        ...(req.body.options !== undefined && { options: req.body.options ? JSON.stringify(req.body.options) : null }),
        ...(explanation !== undefined && { explanation }),
        ...(active !== undefined && { active }),
        updatedAt: new Date(),
      })
      .where(eq(questions.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Question non trouvée' });

    // La réponse officielle est la base du barème : sa modification doit être
    // tracée au même titre qu'une attribution de points.
    await logAudit(
      req.user?.uid,
      req.user?.email,
      'UPDATE_QUESTION',
      'question',
      String(id),
      `Question ${id} modifiée (${updated.type}/${updated.difficulty}, ${updated.points} pts, ${updated.timeLimitSeconds}s, active=${updated.active})`
    );
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise à jour' });
  }
});

questionsRouter.delete('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [target] = await db
      .select({ id: questions.id, text: questions.text, answer: questions.answer })
      .from(questions)
      .where(eq(questions.id, id));
    if (!target) return res.status(404).json({ error: 'Question non trouvée' });

    await db.delete(questions).where(eq(questions.id, id));

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'DELETE_QUESTION',
      'question',
      String(id),
      `Suppression de la question ${id} (« ${target.text.slice(0, 60)} », réponse : ${target.answer})`
    );
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

