import { Router, type Response } from 'express';
import { db } from '../db/index.ts';
import {
  matches,
  matchQuestions,
  questions,
  categories,
  teams,
  users,
  scoreEvents,
  events,
} from '../db/schema.ts';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { requireAuth, requireAdmin, requireJuryOrAdmin, type AuthRequest } from '../middleware/auth.ts';
import {
  getLiveState,
  broadcast,
  logAudit,
} from '../server/matchEngine.ts';
import { publicQuestion } from '../lib/sanitize.ts';
import { getSetting } from '../lib/settings.ts';
import { selectQuestionsForMatch } from '../lib/selectQuestions.ts';
import { scoreLimit, controlLimit, adminWriteLimit } from '../middleware/rateLimit.ts';
import { CONFIG, FLOW } from '../config.ts';
import { validateIds } from '../lib/validate.ts';
import { createLogger } from '../lib/logger.ts';

const log = createLogger('api');

export const matchesRouter = Router();

// Valide :id et :memberId une seule fois pour toutes les routes de ce
// routeur : 400 explicite sur un identifiant malforme, au lieu d'un NaN
// qui partait en requete SQL et revenait en 404 trompeur ou en 500.
validateIds(matchesRouter);

function winnerTeamIdOf(m: { teamAId: number; teamBId: number; scoreA: number; scoreB: number }): number | null {
  if (m.scoreA > m.scoreB) return m.teamAId;
  if (m.scoreB > m.scoreA) return m.teamBId;
  return null;
}

function parseOptions(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    log.warn('options question mal formées (JSON invalide)', { apercu: raw.slice(0, 80) });
    return null;
  }
}

matchesRouter.get('/', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    // Projections explicites : on ne charge plus la table `users` au complet
    // (et ses empreintes de mots de passe) pourenu seul mapping id -> nom.
    const allMatches = await db
      .select({
        id: matches.id,
        eventId: matches.eventId,
        phase: matches.phase,
        matchNumber: matches.matchNumber,
        teamAId: matches.teamAId,
        teamBId: matches.teamBId,
        juryId: matches.juryId,
        status: matches.status,
        startedAt: matches.startedAt,
        endedAt: matches.endedAt,
        currentQuestionIndex: matches.currentQuestionIndex,
        scoreA: matches.scoreA,
        scoreB: matches.scoreB,
        timerSecondsLeft: matches.timerSecondsLeft,
        timerIsRunning: matches.timerIsRunning,
        createdAt: matches.createdAt,
      })
      .from(matches)
      .orderBy(matches.eventId, matches.matchNumber);

    const allTeams = await db
      .select({
        id: teams.id,
        eventId: teams.eventId,
        name: teams.name,
        code: teams.code,
        logo: teams.logo,
        status: teams.status,
      })
      .from(teams);
    const allUsers = await db.select({ id: users.id, name: users.name }).from(users);

    const teamMap = new Map(allTeams.map((t) => [t.id, t]));
    const userMap = new Map(allUsers.map((u) => [u.id, u.name]));

    const populated = allMatches.map((m) => ({
      ...m,
      winnerTeamId: winnerTeamIdOf(m),
      teamA: teamMap.get(m.teamAId) ?? null,
      teamB: teamMap.get(m.teamBId) ?? null,
      juryName: m.juryId ? userMap.get(m.juryId) ?? null : null,
    }));

    res.json(populated);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger les matchs' });
  }
});

// Détails complets (AVEC réponses officielles) : réservé jury/administration
matchesRouter.get('/:id', requireAuth, requireJuryOrAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    const [teamA] = await db.select().from(teams).where(eq(teams.id, match.teamAId));
    const [teamB] = await db.select().from(teams).where(eq(teams.id, match.teamBId));

    let currentQuestion = null;
    if (match.currentQuestionId) {
      const [q] = await db
        .select({
          id: questions.id,
          categoryId: questions.categoryId,
          categoryName: categories.name,
          text: questions.text,
          answer: questions.answer,
          type: questions.type,
          difficulty: questions.difficulty,
          points: questions.points,
          timeLimitSeconds: questions.timeLimitSeconds,
          options: questions.options,
          explanation: questions.explanation,
        })
        .from(questions)
        .innerJoin(categories, eq(questions.categoryId, categories.id))
        .where(eq(questions.id, match.currentQuestionId));

      if (q) {
        currentQuestion = {
          ...q,
          options: parseOptions(q.options),
        };
      }
    }

    // Load linked match questions
    const mQuestions = await db
      .select({
        id: matchQuestions.id,
        matchId: matchQuestions.matchId,
        questionId: matchQuestions.questionId,
        orderNumber: matchQuestions.orderNumber,
        status: matchQuestions.status,
        pointsAwarded: matchQuestions.pointsAwarded,
        winningTeamId: matchQuestions.winningTeamId,
        questionText: questions.text,
        questionAnswer: questions.answer,
        categoryName: categories.name,
        points: questions.points,
        timeLimitSeconds: questions.timeLimitSeconds,
        type: questions.type,
        difficulty: questions.difficulty,
        options: questions.options,
        explanation: questions.explanation,
      })
      .from(matchQuestions)
      .innerJoin(questions, eq(matchQuestions.questionId, questions.id))
      .innerJoin(categories, eq(questions.categoryId, categories.id))
      .where(eq(matchQuestions.matchId, id))
      .orderBy(matchQuestions.orderNumber);

    const parsedQuestions = mQuestions.map((mq) => ({
      id: mq.id,
      matchId: mq.matchId,
      questionId: mq.questionId,
      orderNumber: mq.orderNumber,
      status: mq.status,
      pointsAwarded: mq.pointsAwarded,
      winningTeamId: mq.winningTeamId,
      question: {
        id: mq.questionId,
        text: mq.questionText,
        answer: mq.questionAnswer,
        categoryName: mq.categoryName,
        points: mq.points,
        timeLimitSeconds: mq.timeLimitSeconds,
        type: mq.type,
        difficulty: mq.difficulty,
        options: parseOptions(mq.options),
        explanation: mq.explanation,
      },
    }));

    // Load score history
    const scores = await db
      .select()
      .from(scoreEvents)
      .where(eq(scoreEvents.matchId, id))
      .orderBy(desc(scoreEvents.id));

    res.json({
      ...match,
      winnerTeamId: winnerTeamIdOf(match),
      teamA: teamA ? { ...teamA } : null,
      teamB: teamB ? { ...teamB } : null,
      currentQuestion,
      matchQuestions: parsedQuestions,
      scoreEvents: scores,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors du chargement du match' });
  }
});

matchesRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { eventId, phase, matchNumber, teamAId, teamBId, juryId, questionIds } = req.body;
    if (!teamAId || !teamBId) {
      return res.status(400).json({ error: 'Les deux équipes sont obligatoires' });
    }

    if (teamAId === teamBId) {
      return res.status(400).json({ error: 'Une équipe ne peut pas s\'affronter elle-même' });
    }

    if (!eventId) {
      return res.status(400).json({ error: 'Le champ eventId est requis pour créer un match' });
    }
    const targetEventId = parseInt(eventId, 10);

    const [targetEvent] = await db.select().from(events).where(eq(events.id, targetEventId));
    if (!targetEvent) {
      return res.status(400).json({ error: 'Événement introuvable' });
    }

    const parsedTeamAId = parseInt(teamAId, 10);
    const parsedTeamBId = parseInt(teamBId, 10);
    const [teamA] = await db.select().from(teams).where(eq(teams.id, parsedTeamAId));
    const [teamB] = await db.select().from(teams).where(eq(teams.id, parsedTeamBId));
    if (!teamA || teamA.eventId !== targetEventId) {
      return res.status(400).json({ error: 'L\'équipe A n\'appartient pas à cet événement' });
    }
    if (!teamB || teamB.eventId !== targetEventId) {
      return res.status(400).json({ error: 'L\'équipe B n\'appartient pas à cet événement' });
    }
    if (teamA.status !== FLOW.TEAM_STATUS.ACTIVE || teamB.status !== FLOW.TEAM_STATUS.ACTIVE) {
      return res.status(400).json({ error: 'Une équipe disqualifiée ou inactive ne peut pas jouer' });
    }

    const defaultTimer = parseInt(await getSetting('DEFAULT_TIMER', String(CONFIG.DEFAULT_TIMER_SECONDS)), 10) || CONFIG.DEFAULT_TIMER_SECONDS;

    const [newMatch] = await db
      .insert(matches)
      .values({
        eventId: targetEventId,
        phase: phase || CONFIG.DEFAULT_PHASE,
        matchNumber: matchNumber ? parseInt(matchNumber, 10) : 1,
        teamAId: parsedTeamAId,
        teamBId: parsedTeamBId,
        juryId: juryId ? parseInt(juryId, 10) : null,
        status: FLOW.MATCH_STATUS.SCHEDULED,
        scoreA: 0,
        scoreB: 0,
        currentQuestionIndex: 0,
        timerSecondsLeft: defaultTimer,
        timerDuration: defaultTimer,
        timerIsRunning: false,
      })
      .returning();

    // Sélection équilibrée des questions (validée / par catégorie), sans réutilisation
    const qIds = await selectQuestionsForMatch(targetEventId, questionIds);

    if (qIds.length > 0) {
      await db.insert(matchQuestions).values(
        qIds.map((qid, idx) => ({
          matchId: newMatch.id,
          questionId: qid,
          orderNumber: idx + 1,
          status: (idx === 0 ? FLOW.QUESTION_STATUS.ACTIVE : FLOW.QUESTION_STATUS.PENDING) as 'ACTIVE' | 'PENDING',
          pointsAwarded: 0,
        }))
      );

      await db
        .update(matches)
        .set({ currentQuestionId: qIds[0] })
        .where(eq(matches.id, newMatch.id));
    }

    await logAudit(req.user?.uid, req.user?.email, 'CREATE_MATCH', 'match', String(newMatch.id));
    res.status(201).json(newMatch);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la création du match' });
  }
});

// ---- Match Execution Actions (Jury / Admin) ----

matchesRouter.post('/:id/start', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    if (match.status === FLOW.MATCH_STATUS.LIVE || match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({ error: 'Impossible de lancer ce match (statut incompatible)' });
    }

    // Un seul match en cours / en pause à la fois sur l'événement
    const concurrent = await db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.eventId, match.eventId), inArray(matches.status, [FLOW.MATCH_STATUS.LIVE, FLOW.MATCH_STATUS.PAUSED])));
    const otherLive = concurrent.find((m) => m.id !== id);
    if (otherLive) {
      return res.status(400).json({ error: 'Un autre match est déjà en cours sur cet événement' });
    }

    // La durée par défaut vient de la configuration de compétition
    // (competition_settings > DEFAULT_TIMER), pas de la constante codée en dur.
    const defaultTimerSetting = await getSetting(
      'DEFAULT_TIMER',
      String(CONFIG.DEFAULT_TIMER_SECONDS)
    );
    let duration: number = parseInt(defaultTimerSetting, 10) || CONFIG.DEFAULT_TIMER_SECONDS;

    // First question check
    const mQuestions = await db
      .select()
      .from(matchQuestions)
      .where(eq(matchQuestions.matchId, id))
      .orderBy(matchQuestions.orderNumber);

    // La durée du chrono doit venir de la question courante.
    // Bug historique : la condition `&& !firstQId` rendait cette lecture morte
    // (currentQuestionId est déjà positionné à la création du match), si bien que
    // toutes les parties démarraient sur DEFAULT_TIMER_SECONDS et que
    // timeLimitSeconds de la 1re question n'était jamais honoré.
    let firstQId = match.currentQuestionId;
    if (mQuestions.length > 0) {
      firstQId = firstQId ?? mQuestions[0].questionId;
      const [q] = await db
        .select({ timeLimitSeconds: questions.timeLimitSeconds })
        .from(questions)
        .where(eq(questions.id, firstQId))
        .limit(1);
      if (q?.timeLimitSeconds) {
        duration = q.timeLimitSeconds;
      }
    }

    const [updated] = await db
      .update(matches)
      .set({
        status: FLOW.MATCH_STATUS.LIVE,
        startedAt: match.startedAt || new Date(),
        currentQuestionId: firstQId,
        timerSecondsLeft: duration,
        timerDuration: duration,
        timerIsRunning: true,
        timerStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    // Mark first question active
    if (mQuestions.length > 0) {
      await db
        .update(matchQuestions)
        .set({ status: FLOW.QUESTION_STATUS.ACTIVE, startedAt: new Date() })
        .where(eq(matchQuestions.id, mQuestions[0].id));
    }

    await logAudit(req.user?.uid, req.user?.email, 'START_MATCH', 'match', String(id));

    broadcast('match_started', { matchId: id, match: updated });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur au démarrage du match' });
  }
});

matchesRouter.post('/:id/pause', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });
    if (match.status !== FLOW.MATCH_STATUS.LIVE) {
      return res.status(400).json({ error: 'Seul un match en cours peut être mis en pause' });
    }

    const [updated] = await db
      .update(matches)
      .set({
        status: FLOW.MATCH_STATUS.PAUSED,
        timerIsRunning: false,
        timerStartedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'PAUSE_MATCH', 'match', String(id));

    const liveState = await getLiveState(match.eventId);
    broadcast('match_paused', { matchId: id, match: updated, liveState });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise en pause' });
  }
});

matchesRouter.post('/:id/resume', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });
    if (match.status !== FLOW.MATCH_STATUS.PAUSED) {
      return res.status(400).json({ error: 'Seul un match en pause peut être repris' });
    }
    if (match.timerSecondsLeft <= 0) {
      return res.status(400).json({ error: 'Chronomètre expiré : réinitialisez-le avant de reprendre' });
    }

    // Reprend le décompte là où il s'était arrêté
    const elapsedBeforePause = match.timerDuration - match.timerSecondsLeft;
    const [updated] = await db
      .update(matches)
      .set({
        status: FLOW.MATCH_STATUS.LIVE,
        timerIsRunning: true,
        timerStartedAt: new Date(Date.now() - elapsedBeforePause * 1000),
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'RESUME_MATCH', 'match', String(id));

    const liveState = await getLiveState(match.eventId);
    broadcast('match_resumed', { matchId: id, match: updated, liveState });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de reprise' });
  }
});

// Authoritative Timer Action (start, pause, reset)
matchesRouter.post('/:id/timer-action', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { action, seconds } = req.body; // 'start' | 'pause' | 'reset'

    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    let timerSecondsLeft = match.timerSecondsLeft;
    let timerIsRunning = match.timerIsRunning;
    let timerDuration = match.timerDuration;
    let timerStartedAt: Date | null = match.timerStartedAt;

    if (match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({ error: 'Chrono indisponible : match terminé ou annulé' });
    }

    if (action === 'start') {
      if (timerSecondsLeft <= 0) {
        return res.status(400).json({ error: 'Chronomètre expiré : réinitialisez-le avant de relancer' });
      }
      timerIsRunning = true;
      // Repart du décompte restant (début immédiat = now - temps déjà écoulé)
      timerStartedAt = new Date(Date.now() - Math.max(0, timerDuration - timerSecondsLeft) * 1000);
    } else if (action === 'pause') {
      timerIsRunning = false;
    } else if (action === 'reset') {
      timerIsRunning = false;
      timerSecondsLeft = seconds !== undefined
        ? Math.min(Math.max(parseInt(seconds, 10) || 0, CONFIG.MIN_TIMER_SECONDS), CONFIG.MAX_TIMER_SECONDS)
        : match.timerDuration;
      timerDuration = timerSecondsLeft;
      timerStartedAt = new Date();
    } else {
      return res.status(400).json({ error: 'Action de chrono invalide' });
    }

    const [updated] = await db
      .update(matches)
      .set({
        timerSecondsLeft,
        timerIsRunning,
        timerDuration,
        timerStartedAt,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    broadcast('timer_tick', {
      matchId: id,
      timerSecondsLeft,
      timerIsRunning,
    });

    const liveState = await getLiveState(match.eventId);
    broadcast('timer_synced', { matchId: id, liveState });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur timer' });
  }
});

// Next Question
matchesRouter.post('/:id/next-question', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });
    if (match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({ error: 'Match terminé : navigation question interdite' });
    }

    const mQuestions = await db
      .select()
      .from(matchQuestions)
      .where(eq(matchQuestions.matchId, id))
      .orderBy(matchQuestions.orderNumber);

    if (mQuestions.length === 0) {
      return res.status(400).json({ error: 'Aucune question associée à ce match' });
    }

    const nextIndex = match.currentQuestionIndex + 1;
    if (nextIndex >= mQuestions.length) {
      return res.status(400).json({ error: 'Fin de la série de questions atteinte' });
    }

    const nextMQ = mQuestions[nextIndex];
    const [nextQ] = await db.select().from(questions).where(eq(questions.id, nextMQ.questionId));

    const duration = nextQ ? nextQ.timeLimitSeconds : CONFIG.DEFAULT_TIMER_SECONDS;

    // Une question déjà résolue (bonne réponse) ne doit PAS être ré-ouverte.
    const fresh = nextMQ.status === FLOW.QUESTION_STATUS.PENDING || nextMQ.status === FLOW.QUESTION_STATUS.ACTIVE;

    const [updated] = await db
      .update(matches)
      .set({
        currentQuestionIndex: nextIndex,
        currentQuestionId: nextMQ.questionId,
        timerSecondsLeft: duration,
        timerDuration: duration,
        timerStartedAt: match.status === FLOW.MATCH_STATUS.LIVE && fresh ? new Date() : null,
        timerIsRunning: match.status === FLOW.MATCH_STATUS.LIVE && fresh,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    if (fresh) {
      await db
        .update(matchQuestions)
        .set({ status: FLOW.QUESTION_STATUS.ACTIVE, startedAt: new Date() })
        .where(eq(matchQuestions.id, nextMQ.id));
    }

    const liveState = await getLiveState(match.eventId);

    broadcast('question_changed', {
      matchId: id,
      currentQuestionIndex: nextIndex,
      question: nextQ ? publicQuestion(nextQ) : null,
      liveState,
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de changement de question' });
  }
});

// Previous Question
matchesRouter.post('/:id/previous-question', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });
    if (match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({ error: 'Match terminé : navigation question interdite' });
    }

    const mQuestions = await db
      .select()
      .from(matchQuestions)
      .where(eq(matchQuestions.matchId, id))
      .orderBy(matchQuestions.orderNumber);

    if (mQuestions.length === 0) {
      return res.status(400).json({ error: 'Aucune question associée à ce match' });
    }

    const prevIndex = Math.max(0, match.currentQuestionIndex - 1);
    if (prevIndex === match.currentQuestionIndex) {
      return res.status(400).json({ error: 'Déjà à la première question' });
    }

    const prevMQ = mQuestions[prevIndex];
    const [prevQ] = await db.select().from(questions).where(eq(questions.id, prevMQ.questionId));
    const duration = prevQ ? prevQ.timeLimitSeconds : CONFIG.DEFAULT_TIMER_SECONDS;

    // Une question déjà résolue n'est pas ré-ouverte ni remise au chrono
    const fresh = prevMQ.status === FLOW.QUESTION_STATUS.PENDING || prevMQ.status === FLOW.QUESTION_STATUS.ACTIVE;

    const [updated] = await db
      .update(matches)
      .set({
        currentQuestionIndex: prevIndex,
        currentQuestionId: prevMQ.questionId,
        timerSecondsLeft: duration,
        timerDuration: duration,
        timerStartedAt: null,
        timerIsRunning: false,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    if (fresh) {
      // Remarque la question revue comme ACTIVE
      await db
        .update(matchQuestions)
        .set({ status: FLOW.QUESTION_STATUS.ACTIVE, startedAt: new Date() })
        .where(eq(matchQuestions.id, prevMQ.id));
    }

    const liveState = await getLiveState(match.eventId);

    broadcast('question_changed', {
      matchId: id,
      currentQuestionIndex: prevIndex,
      question: prevQ ? publicQuestion(prevQ) : null,
      liveState,
    });

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur navigation question' });
  }
});

// Score Operation with Double-Click Protection & Full Audit
const lastScoreAction = new Map<string, number>();

// Purge périodique des clés de protection : sans cela la Map croît sur toute la
// durée de vie du process (elle n'est jamais bornée en taille).
setInterval(
  () => {
    const cutoff = Date.now() - CONFIG.ANTI_DOUBLE_CLICK_MS;
    for (const [key, ts] of lastScoreAction) {
      if (ts < cutoff) lastScoreAction.delete(key);
    }
  },
  60_000
).unref();

matchesRouter.post('/:id/score', requireAuth, requireJuryOrAdmin, scoreLimit, async (req: AuthRequest, res: Response) => {
  try {
    const matchId = parseInt(req.params.id, 10);
    const { teamId, questionId, points, type, reason } = req.body;

    const parsedTeamId = parseInt(teamId, 10);
    if (!parsedTeamId || points === undefined) {
      return res.status(400).json({ error: 'Équipe et points requis' });
    }
    const parsedPoints = parseInt(points, 10);
    if (Number.isNaN(parsedPoints)) {
      return res.status(400).json({ error: 'Points invalides' });
    }
    if (Math.abs(parsedPoints) > CONFIG.MAX_ADJUST_POINTS) {
      return res.status(400).json({ error: `Points hors bornes (max ±${CONFIG.MAX_ADJUST_POINTS} pts)` });
    }

    // Anti Double-click: la clé n'est posée qu'APRÈS validation (voir plus bas).
    // La poser avant consommerait la fenêtre de 1,5 s y compris pour une
    // requête rejetée, et le jury se prendrait un 429 sur son clic suivant.
    const actionKey = `${matchId}_${parsedTeamId}_${questionId || 'general'}_${type}`;
    const now = Date.now();
    if (now - (lastScoreAction.get(actionKey) || 0) < CONFIG.ANTI_DOUBLE_CLICK_MS) {
      return res.status(429).json({
        error: 'Action ignorée : opération en double détectée. Veuillez patienter.',
      });
    }

    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    // Un match non démarré ne peut pas être scoré : sinon le jury attribue des
    // points sur une partie qui n'a pas eu lieu.
    if (
      match.status !== FLOW.MATCH_STATUS.LIVE &&
      match.status !== FLOW.MATCH_STATUS.PAUSED
    ) {
      return res.status(400).json({
        error:
          match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED
            ? 'Impossible d\'attribuer des points : match terminé ou annulé'
            : 'Impossible d\'attribuer des points : le match n\'est pas en cours',
      });
    }

    if (match.teamAId !== parsedTeamId && match.teamBId !== parsedTeamId) {
      return res.status(400).json({ error: 'L\'équipe indiquée ne participe pas à ce match' });
    }

    // La question doit appartenir à la série du match
    const parsedQuestionId = questionId ? parseInt(questionId, 10) : null;
    const scoreType = type || FLOW.SCORE_TYPE.ANSWER;
    if (parsedQuestionId) {
      const [mq] = await db
        .select()
        .from(matchQuestions)
        .where(
          and(
            eq(matchQuestions.matchId, matchId),
            eq(matchQuestions.questionId, parsedQuestionId)
          )
        );
      if (!mq) {
        return res.status(400).json({ error: 'Cette question ne fait pas partie du match' });
      }

      // Règle métier : une question ne peut être résolue qu'une fois.
      // Une bonne réponse déjà validée est verrouillée (correction via ajustement).
      if (scoreType === FLOW.SCORE_TYPE.ANSWER && mq.status === FLOW.QUESTION_STATUS.ANSWERED) {
        return res.status(400).json({
          error: 'Cette question a déjà été validée (bonne réponse). Pour corriger, utilisez l\'ajustement manuel.',
        });
      }

      // Bonus : pas de doublon pour le même match, la même équipe et la même question
      if (scoreType === FLOW.SCORE_TYPE.BONUS && mq.status === FLOW.QUESTION_STATUS.ANSWERED) {
        const [dupBonus] = await db
          .select({ id: scoreEvents.id })
          .from(scoreEvents)
          .where(
            and(
              eq(scoreEvents.matchId, matchId),
              eq(scoreEvents.teamId, parsedTeamId),
              eq(scoreEvents.questionId, parsedQuestionId),
              eq(scoreEvents.type, FLOW.SCORE_TYPE.BONUS)
            )
          );
        if (dupBonus) {
          return res.status(400).json({ error: 'Bonus déjà attribué pour cette question' });
        }
      }
    }

    // Toutes les validations sont passées : on consume la fenêtre anti-double-clic.
    lastScoreAction.set(actionKey, now);

    // Écriture atomique : sans transaction, un incident entre l'insertion de
    // l'événement et la mise à jour de matches.score_a/score_b laisserait le
    // score affiché désynchronisé du journal (piste d'audit) — inacceptable pour
    // un score officiel.
    const result = await db.transaction(async (tx) => {
      // VERROU de ligne — à ne pas retirer.
      //
      // Le recalcul ci-dessous lit le journal pour en déduire le score. Sous
      // READ COMMITTED, deux transactions concurrentes lisent le MÊME
      // instantané : chacune voit ses propres écritures et celles déjà
      // commitées, mais pas celle de l'autre, encore en cours. Elles calculent
      // donc le même total, et la seconde écrase la première.
      //
      // Ce n'est pas théorique : les deux membres du jury qui attribuent des
      // points à des équipes différentes ont des clés anti-double-clic
      // DISTINCTES, les deux requêtes passent, et l'entrelacement est
      // parfaitement réalable à quelques millisecondes d'écart.
      //
      // Mesuré sur cette base (backend/test/probe-lost-update-fixed.mjs,
      // +10 par transaction, deux équipes) :
      //     sans verrou : total réel 20, score affiché 10  → 10 points perdus
      //     avec verrou : total réel 20, score affiché 20  → 0 point perdu
      // Le journal d'audit restait complet dans les deux cas : la perte
      // n'était visible que sur l'écran, ce qui la rendait indétectable sans
      // comparaison au journal.
      await tx
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.id, matchId))
        .for('update');

      const [ev] = await tx
        .insert(scoreEvents)
        .values({
          matchId,
          teamId: parsedTeamId,
          questionId: parsedQuestionId,
          points: parsedPoints,
          type: scoreType,
          reason: reason || `Attribution ${parsedPoints > 0 ? '+' : ''}${parsedPoints} pts`,
          createdBy: req.user?.name || req.user?.email || 'Jury AEERKS',
        })
        .returning();

      // Recalcule les scores depuis score_events, dans la même transaction
      const eventsList = await tx
        .select({ teamId: scoreEvents.teamId, points: scoreEvents.points })
        .from(scoreEvents)
        .where(eq(scoreEvents.matchId, matchId));

      let totalA = 0;
      let totalB = 0;
      for (const e of eventsList) {
        if (e.teamId === match.teamAId) totalA += e.points;
        else if (e.teamId === match.teamBId) totalB += e.points;
      }
      // Plancher de sécurité : un score ne peut pas être négatif
      const scoreA = Math.max(0, totalA);
      const scoreB = Math.max(0, totalB);

      // Stop timer on answered question (sans écraser le reset du chrono)
      await tx
        .update(matches)
        .set({ timerIsRunning: false, timerStartedAt: null, updatedAt: new Date() })
        .where(eq(matches.id, matchId));

      // Update match question state if applicable
      if (parsedQuestionId) {
        await tx
          .update(matchQuestions)
          .set({
            status: parsedPoints > 0 ? FLOW.QUESTION_STATUS.ANSWERED : FLOW.QUESTION_STATUS.SKIPPED,
            pointsAwarded: parsedPoints,
            winningTeamId: parsedPoints > 0 ? parsedTeamId : null,
            answeredAt: new Date(),
          })
          .where(
            and(
              eq(matchQuestions.matchId, matchId),
              eq(matchQuestions.questionId, parsedQuestionId)
            )
          );
      }

      // Verrou pessimiste optionnel : si deux membres du jury scorent en même
      // temps sur des équipes différentes (clés anti-double-clic distinctes), la
      // transaction sérialise les recalculs et le dernier l'emporte sans
      // perdre d'événement.
      await tx
        .update(matches)
        .set({ scoreA, scoreB, updatedAt: new Date() })
        .where(eq(matches.id, matchId));

      return { ev, scoreA, scoreB };
    });

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'SCORE_EVENT',
      'score_event',
      String(result.ev.id),
      `Match ${matchId}: Équipe ${teamId} -> ${parsedPoints > 0 ? '+' : ''}${parsedPoints} pts (${type})`
    );

    // Broadcast score update
    const liveState = await getLiveState(match.eventId);
    broadcast('score_updated', {
      matchId,
      scoreA: result.scoreA,
      scoreB: result.scoreB,
      scoreEvent: result.ev,
      liveState,
    });

    res.json({
      success: true,
      scoreA: result.scoreA,
      scoreB: result.scoreB,
      event: result.ev,
    });
  } catch (error: any) {
    log.error('Erreur score', { err: error });
    res.status(500).json({ error: 'Erreur lors de l\'enregistrement du score' });
  }
});

// Manual adjustment with mandatory justification
const lastAdjustAction = new Map<string, number>();

setInterval(
  () => {
    const cutoff = Date.now() - CONFIG.ANTI_DOUBLE_CLICK_MS;
    for (const [key, ts] of lastAdjustAction) {
      if (ts < cutoff) lastAdjustAction.delete(key);
    }
  },
  60_000
).unref();

matchesRouter.post('/:id/adjust-score', requireAuth, requireJuryOrAdmin, scoreLimit, async (req: AuthRequest, res: Response) => {
  try {
    const matchId = parseInt(req.params.id, 10);
    const { teamId, points, reason } = req.body;

    const parsedTeamId = parseInt(teamId, 10);
    const parsedPoints = parseInt(points, 10);
    if (!parsedTeamId || Number.isNaN(parsedPoints) || !reason || reason.trim().length < 3) {
      return res.status(400).json({
        error: 'Équipe, points et motif obligatoire (au moins 3 caractères) requis pour tout ajustement',
      });
    }
    if (Math.abs(parsedPoints) > CONFIG.MAX_ADJUST_POINTS) {
      return res.status(400).json({ error: `Ajustement hors bornes (max ±${CONFIG.MAX_ADJUST_POINTS} pts)` });
    }

    // Anti double-clic : pose de la clé après validation uniquement
    const actionKey = `adjust_${matchId}_${parsedTeamId}`;
    const now = Date.now();
    if (now - (lastAdjustAction.get(actionKey) || 0) < CONFIG.ANTI_DOUBLE_CLICK_MS) {
      return res.status(429).json({ error: 'Double soumission détectée : veuillez patienter' });
    }

    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    if (
      match.status !== FLOW.MATCH_STATUS.LIVE &&
      match.status !== FLOW.MATCH_STATUS.PAUSED
    ) {
      return res.status(400).json({
        error:
          match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED
            ? 'Impossible d\'ajuster : match terminé ou annulé'
            : 'Impossible d\'ajuster : le match n\'est pas en cours',
      });
    }

    if (match.teamAId !== parsedTeamId && match.teamBId !== parsedTeamId) {
      return res.status(400).json({ error: 'L\'équipe indiquée ne participe pas à ce match' });
    }

    lastAdjustAction.set(actionKey, now);

    const { ev, scoreA, scoreB } = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(scoreEvents)
        .values({
          matchId,
          teamId: parsedTeamId,
          points: parsedPoints,
          type: FLOW.SCORE_TYPE.ADJUSTMENT,
          reason: reason.trim(),
          createdBy: req.user?.name || req.user?.email || 'Admin/Jury AEERKS',
        })
        .returning();

      const eventsList = await tx
        .select({ teamId: scoreEvents.teamId, points: scoreEvents.points })
        .from(scoreEvents)
        .where(eq(scoreEvents.matchId, matchId));

      let totalA = 0;
      let totalB = 0;
      for (const e of eventsList) {
        if (e.teamId === match.teamAId) totalA += e.points;
        else if (e.teamId === match.teamBId) totalB += e.points;
      }
      const nextA = Math.max(0, totalA);
      const nextB = Math.max(0, totalB);

      await tx
        .update(matches)
        .set({ scoreA: nextA, scoreB: nextB, updatedAt: new Date() })
        .where(eq(matches.id, matchId));

      return { ev: inserted, scoreA: nextA, scoreB: nextB };
    });

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'ADJUST_SCORE',
      'match',
      String(matchId),
      `Ajustement ${parsedPoints > 0 ? '+' : ''}${parsedPoints} pts pour équipe ${parsedTeamId}. Motif: ${reason.trim()}`
    );

    const liveState = await getLiveState(match.eventId);
    broadcast('score_updated', {
      matchId,
      scoreA,
      scoreB,
      scoreEvent: ev,
      liveState,
    });

    res.json({ success: true, scoreA, scoreB, event: ev });
  } catch (error: any) {
    log.error('Erreur ajustement score', { err: error });
    res.status(500).json({ error: 'Erreur lors de l\'ajustement du score' });
  }
});

// Finish Match
matchesRouter.post('/:id/finish', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });
    if (match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({ error: 'Match déjà terminé ou annulé' });
    }

    const [updated] = await db
      .update(matches)
      .set({
        status: FLOW.MATCH_STATUS.FINISHED,
        timerIsRunning: false,
        timerStartedAt: null,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    await logAudit(req.user?.uid, req.user?.email, 'FINISH_MATCH', 'match', String(id));

    // Une clôture change le classement : inclure les rankings dans l'état diffusé
    const liveState = await getLiveState(updated.eventId, true);
    broadcast('match_finished', {
      matchId: id,
      match: updated,
      liveState,
    });

    res.json(updated);
  } catch (error: any) {
    log.error('Erreur cloture match', { err: error });
    res.status(500).json({ error: 'Erreur clôture match' });
  }
});

matchesRouter.delete('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [target] = await db.select().from(matches).where(eq(matches.id, id));
    if (!target) return res.status(404).json({ error: 'Match non trouvé' });
    if (target.status === FLOW.MATCH_STATUS.LIVE || target.status === FLOW.MATCH_STATUS.PAUSED) {
      return res.status(400).json({ error: 'Impossible de supprimer un match en cours ou en pause. Terminez-le d\'abord.' });
    }

    // score_events est en ON DELETE CASCADE : supprimer un match effacerait
    // définitivement son journal de score. Pour une compétition auditée, c'est
    // inacceptable — on bloque tant qu'il existe des événements.
    const [existing] = await db
      .select({ id: scoreEvents.id })
      .from(scoreEvents)
      .where(eq(scoreEvents.matchId, id))
      .limit(1);
    if (existing) {
      return res.status(409).json({
        error:
          'Impossible de supprimer : ce match possède un historique de score. ' +
          'Le journal d\'audit doit être conservé. Annulez le match ou contactez l\'administrateur système.',
      });
    }

    await db.delete(matches).where(eq(matches.id, id));
    await logAudit(req.user?.uid, req.user?.email, 'DELETE_MATCH', 'match', String(id));
    res.json({ success: true });
  } catch (error: any) {
    log.error('DELETE match error', { err: error });
    res.status(500).json({ error: 'Erreur lors de la suppression du match' });
  }
});
