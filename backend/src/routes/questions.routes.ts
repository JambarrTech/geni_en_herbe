import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import { questions, categories } from '../db/schema.ts';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { CONFIG, FLOW } from '../config.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';
import { validateIds } from '../lib/validate.ts';
import { isForeignKeyViolation, FK_DELETE_MESSAGES, isMissingSchemaError, missingSchemaMessage } from '../lib/dbErrors.ts';
import { createLogger } from '../lib/logger.ts';

const log = createLogger('api');

/**
 * Prochaine position libre dans une catégorie (fin du groupe).
 * Regroupé ici pour que création et réorganisation partagent la même règle :
 * une question neuve ne passe jamais devant celles que l'admin a ordonnées.
 */
async function nextQuestionPosition(categoryId: number): Promise<number> {
  const [{ max }] = await db
    .select({ max: sql<number | null>`max(${questions.position})` })
    .from(questions)
    .where(eq(questions.categoryId, categoryId));
  return (max ?? 0) + 1;
}

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
// Pagination : ?page=1&limit=50 (défaut 50, max 200)
questionsRouter.get('/', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const offset = (page - 1) * limit;

    const [list, [{ total }]] = await Promise.all([
      db
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
          position: questions.position,
          timeLimitSeconds: questions.timeLimitSeconds,
          options: questions.options,
          explanation: questions.explanation,
          mediaUrl: questions.mediaUrl,
          active: questions.active,
          createdAt: questions.createdAt,
        })
        .from(questions)
        .innerJoin(categories, eq(questions.categoryId, categories.id))
        // Même ordre que la banque groupée et la sélection d'un match :
        // catégorie d'abord (position décidée par l'admin), puis question
        // dans sa catégorie, puis identifiant (déterministe).
        .orderBy(asc(categories.position), asc(questions.position), asc(questions.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(questions),
    ]);

    const parsed = list.map((q) => ({
      ...q,
      options: parseOptions(q.options),
    }));

    res.json({
      data: parsed,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    log.error('Erreur chargement questions', { err: error });
    if (isMissingSchemaError(error)) {
      return res.status(503).json({ error: missingSchemaMessage() });
    }
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
        // Une nouvelle question passe en DERNIER de sa catégorie : elle ne
        // doit pas voler la première place — donc l'ouverture de la banque
        // et de l'écran public — par surprise.
        position: await nextQuestionPosition(parseInt(categoryId, 10)),
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

// Réorganisation des questions D'UNE catégorie : l'admin envoie les
// identifiants dans l'ordre voulu, la première ouvre le groupe — donc
// l'écran public quand sa catégorie passe.
// Déclarée AVANT `/:id` : sans paramètre, `validateIds` ne s'applique pas.
questionsRouter.post('/reorder', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const categoryId = parseInt(req.body?.categoryId, 10);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({ error: 'Catégorie obligatoire pour réorganiser ses questions' });
    }
    const [cat] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId));
    if (!cat) return res.status(404).json({ error: 'Catégorie introuvable' });

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'La liste ordonnée des identifiants est obligatoire' });
    }
    const ordered = [...new Set(ids.map((id) => parseInt(id, 10)).filter((n) => Number.isInteger(n) && n > 0))];
    if (ordered.length === 0) {
      return res.status(400).json({ error: 'Aucun identifiant de question valide' });
    }

    const existing = await db
      .select({ id: questions.id, categoryId: questions.categoryId })
      .from(questions)
      .where(inArray(questions.id, ordered));
    const found = new Set(existing.map((q) => q.id));
    const unknown = ordered.filter((id) => !found.has(id));
    if (unknown.length > 0) {
      return res.status(404).json({ error: `Questions introuvables : ${unknown.join(', ')}` });
    }
    const foreign = existing.filter((q) => q.categoryId !== categoryId).map((q) => q.id);
    if (foreign.length > 0) {
      return res.status(400).json({ error: `Questions d'une autre catégorie : ${foreign.join(', ')}` });
    }

    await db.transaction(async (tx) => {
      let position = 1;
      for (const id of ordered) {
        await tx.update(questions).set({ position }).where(eq(questions.id, id));
        position += 1;
      }
      // Les questions de la catégorie absentes de la liste gardent l'ordre
      // relatif et passent après : aucune ne disparaît par accident.
      const rest = await tx
        .select({ id: questions.id })
        .from(questions)
        .where(and(eq(questions.categoryId, categoryId), notInArray(questions.id, ordered)))
        .orderBy(asc(questions.id));
      for (const { id } of rest) {
        await tx.update(questions).set({ position }).where(eq(questions.id, id));
        position += 1;
      }
    });

    await logAudit(req.user?.uid, req.user?.email, 'REORDER_QUESTIONS', 'category', String(categoryId));
    const reordered = await db
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.categoryId, categoryId))
      .orderBy(asc(questions.position), asc(questions.id));
    res.json(reordered);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de réorganisation des questions' });
  }
});

questionsRouter.patch('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { categoryId, text, answer, explanation, active, position } = req.body;

    const validationError = validateQuestionPayload(req.body, true);
    if (validationError) {
      return res.status(400).json(validationError);
    }

    let parsedPosition: number | undefined;
    if (position !== undefined) {
      parsedPosition = parseInt(position, 10);
      if (!Number.isInteger(parsedPosition) || parsedPosition < 0) {
        return res.status(400).json({ error: 'Position invalide : un entier positif ou nul est attendu' });
      }
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
        ...(parsedPosition !== undefined && { position: parsedPosition }),
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
    // Une question jouée reste référencée par `matches.current_question_id`,
    // `match_questions` et `score_events`, tous en RESTRICT. Sans ce
    // classement, Postgres levait la violation et l'appelant recevait un 500
    // « Erreur lors de la suppression » : impossible à distinguer d'une panne,
    // alors que c'est le cas le plus courant — celui d'une question déjà utilisée.
    log.error('DELETE question error', { err: error });
    if (isForeignKeyViolation(error)) {
      return res.status(400).json({ error: FK_DELETE_MESSAGES.question });
    }
    res.status(500).json({ error: 'Erreur lors de la suppression' });
  }
});

