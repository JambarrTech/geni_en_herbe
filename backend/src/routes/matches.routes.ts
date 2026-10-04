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
  getDiffusedScore,
  isScoreHidden,
} from '../server/matchEngine.ts';
import { publicQuestion } from '../lib/sanitize.ts';
import { getSetting } from '../lib/settings.ts';
import { selectQuestionsForMatch, sortPoolForMatch } from '../lib/selectQuestions.ts';
import { scoreLimit, controlLimit, adminWriteLimit } from '../middleware/rateLimit.ts';
import { CONFIG, FLOW } from '../config.ts';
import { validateIds } from '../lib/validate.ts';
import { createLogger } from '../lib/logger.ts';
import { isMissingSchemaError, missingSchemaMessage } from '../lib/dbErrors.ts';
import { buildMatchList, parseOptions, winnerTeamIdOf } from '../lib/matchList.ts';
import {
  BROADCAST_STAGE,
  firstCursor,
  nextCursor,
  normalizeCursor,
  previousCursor,
  timerUpdateForStep,
  type BroadcastCursor,
} from '../lib/broadcastFlow.ts';

const log = createLogger('api');

export const matchesRouter = Router();

// Valide :id et :memberId une seule fois pour toutes les routes de ce
// routeur : 400 explicite sur un identifiant malforme, au lieu d'un NaN
// qui partait en requete SQL et revenait en 404 trompeur ou en 500.
validateIds(matchesRouter);

matchesRouter.get('/', requireAuth, requireJuryOrAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    // Projections explicites : on ne charge plus la table `users` au complet
    // (et ses empreintes de mots de passe) pour un seul mapping id -> nom.
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

    // Les jointures sont faites ici plutôt qu'en SQL : voir `lib/matchList.ts`.
    res.json(buildMatchList(allMatches, allTeams, allUsers));
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
      // Ce que le public voit des points : l'annonce diffusée (ou rien) et
      // l'indicateur de masquage. Le jury pilote les deux depuis sa table.
      diffusedScore: await getDiffusedScore({
        id,
        teamAId: match.teamAId,
        teamBId: match.teamBId,
        diffusedScoreEventId: match.diffusedScoreEventId ?? null,
      }),
      scoresHidden: isScoreHidden(
        match.status,
        scores.map((s) => s.id),
        match.diffusedScoreEventId ?? null
      ),
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors du chargement du match' });
  }
});

matchesRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { eventId, phase, matchNumber, teamAId, teamBId, juryId, questionIds, matchSize } = req.body;
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

    // Sélection équilibrée des questions (validée / par catégorie), sans réutilisation.
    // `matchSize` règle la longueur de la série (défaut : 10). Une liste
    // explicite `questionIds` n'est jamais tronquée : le comité obtient
    // exactement la série qu'il a composée.
    const parsedSize = parseInt(matchSize, 10);
    const qIds = await selectQuestionsForMatch(
      targetEventId,
      questionIds,
      Number.isInteger(parsedSize) && parsedSize > 0 ? Math.min(parsedSize, 200) : CONFIG.DEFAULT_MATCH_SIZE
    );

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
    // Une colonne absente n'est pas une erreur de saisie : c'est un schéma en
    // retard. Le dire ici évite qu'un administrateur cherche un numéro de match
    // ou une équipe fautifs pendant que la vraie cause — une migration non
    // appliquée — reste invisible. Voir `lib/dbErrors.ts`.
    if (isMissingSchemaError(error)) {
      log.error('Schema incomplet : creation de match impossible', { err: error });
      return res.status(503).json({ error: missingSchemaMessage() });
    }
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
        // Première diffusion du match : l'écran affiche directement la première
        // question (pas d'effectif d'équipes). `broadcast_stage` n'est remis à
        // zéro qu'au tout premier lancement — relancer un match déjà entamé ne
        // doit pas faire repasser l'écran public par le début de la séquence.
        broadcastStage: match.startedAt ? match.broadcastStage : BROADCAST_STAGE.QUESTION,
        // Plus d'étape ROSTER : pas d'échéance de bascule automatique.
        broadcastRosterUntil: null,
        timerSecondsLeft: duration,
        timerDuration: duration,
        // Le chrono est AMORCÉ, pas lancé.
        //
        // Le compteur est autoritaire et vit dans le serveur (`timerLoopTick`),
        // qui recalcule `timerDuration - (maintenant - timerStartedAt)`. Il ne
        // s'arrête donc pas parce que l'écran public affiche autre chose : il
        // décompte en continu tant que `timerStartedAt` est posé.
        //
        // Le chrono ne démarre qu'à l'entrée de l'étape QUESTION, c'est-à-dire
        // quand le jury décide que le public voit la question (via « Étape suivante »
        // ou raccourci clavier). `next-question` l'arme aussi, pour qui pilote à l'ancienne.
        timerIsRunning: false,
        timerStartedAt: null,
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
        // Sauter de question à la main ramène la diffusion à l'étape « question ».
        //
        // Sans cela, un jury qui recule en arrière puis clique sur « Suivante »
        // republicait l'énoncé de la question 1 avec l'étape `REVEAL` encore
        // positionnée sur la question 2 — donc la bonne réponse de la question 2
        // projetée en plein match, avant qu'elle n'ait été posée. Le scénario
        // décrit la position dans le déroulé, pas la question : changer de
        // question sans changer d'étape n'est pas un état valide.
        broadcastStage: BROADCAST_STAGE.QUESTION,
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
        // Même raison que sur `next-question` : revenir sur une question
        // repositionne la diffusion sur son énoncé, jamais sur sa révélation.
        broadcastStage: BROADCAST_STAGE.QUESTION,
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

// Diffusion des points à l'écran public (jury ou admin, depuis la table du jury).
//
// Pendant le match, les points attribués NE partent PAS tout seuls sur
// l'écran : les totaux publics restent figés sur la dernière diffusion, puis
// masqués dès qu'un nouveau point est attribué. Cette route pose le marqueur
// `diffused_score_event_id` sur le dernier événement (ou celui demandé) : à
// partir de là — et seulement là — le public voit les totaux et l'annonce.
matchesRouter.post('/:id/diffuse-score', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    // Diffuser n'a de sens que pendant ou juste après le match : avant le
    // lancement il n'y a rien à montrer, après annulation plus rien à diffuser.
    if (
      match.status !== FLOW.MATCH_STATUS.LIVE &&
      match.status !== FLOW.MATCH_STATUS.PAUSED &&
      match.status !== FLOW.MATCH_STATUS.FINISHED
    ) {
      return res.status(400).json({ error: 'Diffusion impossible : match non démarré ou annulé' });
    }

    const { scoreEventId } = req.body;
    let targetId: number | null = null;
    if (scoreEventId !== undefined && scoreEventId !== null) {
      const parsed = parseInt(scoreEventId, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'Identifiant d\'événement invalide' });
      }
      const [ev] = await db
        .select({ id: scoreEvents.id })
        .from(scoreEvents)
        .where(and(eq(scoreEvents.id, parsed), eq(scoreEvents.matchId, id)))
        .limit(1);
      if (!ev) {
        return res.status(404).json({ error: 'Événement de score introuvable pour ce match' });
      }
      targetId = ev.id;
    } else {
      const [latest] = await db
        .select({ id: scoreEvents.id })
        .from(scoreEvents)
        .where(eq(scoreEvents.matchId, id))
        .orderBy(desc(scoreEvents.id))
        .limit(1);
      if (!latest) {
        return res.status(400).json({ error: 'Aucun point attribué à diffuser pour ce match' });
      }
      targetId = latest.id;
    }

    await db
      .update(matches)
      .set({ diffusedScoreEventId: targetId, updatedAt: new Date() })
      .where(eq(matches.id, id));

    const diffused = await getDiffusedScore({
      id,
      teamAId: match.teamAId,
      teamBId: match.teamBId,
      diffusedScoreEventId: targetId,
    });

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'DIFFUSE_SCORE',
      'match',
      String(id),
      diffused
        ? `Points diffusés à l'écran : ${diffused.points > 0 ? '+' : ''}${diffused.points} pts pour ${diffused.teamName} (événement ${diffused.eventId})`
        : `Diffusion des points à l'écran (événement ${targetId})`
    );

    const liveState = await getLiveState(match.eventId);
    broadcast('score_diffused', {
      matchId: id,
      diffusedScore: diffused,
      liveState,
    });

    res.json({ success: true, diffusedScore: diffused });
  } catch (error: any) {
    log.error('Erreur diffusion des points', { err: error });
    if (isMissingSchemaError(error)) {
      return res.status(503).json({ error: missingSchemaMessage() });
    }
    res.status(500).json({ error: 'Erreur lors de la diffusion des points' });
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

// ---- Pilotage du scénario de diffusion (Jury / Admin) ----

/**
 * Avance (ou recule) l'écran public d'une étape de diffusion.
 *
 * POURQUOI UNE ROUTE DÉDIÉE
 * -------------------------
 * Le déroulé public — effectif, question, équipe A, équipe B, révélation,
 * résultat final — est piloté par le jury avec UN bouton, pas déduit des
 * actions existantes. Le motif est la broadcast safety : la réponse officielle
 * part sur l'écran public quand cette route écrit `REVEAL`. Si l'avancement
 * dépendait d'une action ordinaire (attribuer des points, passer à la question
 * suivante), la réponse partirait au moment d'un clic destiné à autre chose, et
 * personne ne saurait dire à coup sûr ce que le public voit. Ici, un cran du
 * scénario est exactement un appel explicite à cette route.
 *
 * Le corps est `{ action: 'next' | 'previous' | 'restart' }`.
 *  - `next`     : l'étape suivante ; refuse la dernière (FINAL), qui se termine
 *                 par la clôture du match, pas par la diffusion.
 *  - `previous` : l'étape précédente, pour corriger un cran de trop.
 *  - `restart`  : retour à l'effectif des équipes, au cas où le jury présente le
 *                 match depuis le début.
 *
 * Question et chronomètre : le chrono démarre à l'entrée de l'étape QUESTION
 * d'une question jamais jouée, et seulement dans le sens « avant ». Il ne part
 * donc pas au lancement du match — lequel ouvre sur l'effectif des équipes et
 * arme un chrono au repos (cf. `/:id/start`) — mais au moment où le public voit
 * réellement la question. Sur les étapes de réponse et de révélation il garde
 * l'état que le jury lui a donné avec ses propres commandes : le scénario ne
 * prend pas le chrono des mains du jury au milieu d'une question.
 */
// Réordonne la série d'un match NON DÉMARRÉ selon les priorités admin
// (position de catégorie puis de question). Les matchs en cours, terminés ou
// déjà scorés sont intouchables : réécrire leur série changerait le sens des
// points attribués. C'est ce qui applique un réordonnancement tardif aux
// matchs programmés avant — jury et public suivent `orderNumber`.
matchesRouter.post('/:id/reorder-questions', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    if (
      match.status !== FLOW.MATCH_STATUS.SCHEDULED &&
      match.status !== FLOW.MATCH_STATUS.READY
    ) {
      return res.status(400).json({ error: 'Seule la série d\'un match non démarré peut être réordonnée' });
    }

    const [scored] = await db
      .select({ id: scoreEvents.id })
      .from(scoreEvents)
      .where(eq(scoreEvents.matchId, id))
      .limit(1);
    if (scored) {
      return res.status(400).json({ error: 'Série figée : des points ont déjà été attribués sur ce match' });
    }

    const rows = await db
      .select({
        mqId: matchQuestions.id,
        questionId: matchQuestions.questionId,
        categoryId: questions.categoryId,
        position: questions.position,
      })
      .from(matchQuestions)
      .innerJoin(questions, eq(matchQuestions.questionId, questions.id))
      .where(eq(matchQuestions.matchId, id));
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Aucune question dans la série de ce match' });
    }

    const catRows = await db
      .select({ id: categories.id, position: categories.position })
      .from(categories);
    const rank = new Map(catRows.map((c) => [c.id, c.position] as const));
    const ordered = sortPoolForMatch(
      rows.map((r) => ({ id: r.questionId, categoryId: r.categoryId, position: r.position })),
      rank
    );
    const mqByQuestion = new Map(rows.map((r) => [r.questionId, r.mqId]));

    await db.transaction(async (tx) => {
      let order = 1;
      for (const q of ordered) {
        const mqId = mqByQuestion.get(q.id);
        if (mqId === undefined) continue;
        await tx
          .update(matchQuestions)
          .set({
            orderNumber: order,
            status: order === 1 ? FLOW.QUESTION_STATUS.ACTIVE : FLOW.QUESTION_STATUS.PENDING,
          })
          .where(eq(matchQuestions.id, mqId));
        order += 1;
      }
      await tx
        .update(matches)
        .set({
          currentQuestionIndex: 0,
          currentQuestionId: ordered[0]?.id ?? null,
          updatedAt: new Date(),
        })
        .where(eq(matches.id, id));
    });

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'REORDER_MATCH_QUESTIONS',
      'match',
      String(id),
      `Série du match ${id} réordonnée selon les priorités (${ordered.length} questions)`
    );

    const liveState = await getLiveState(match.eventId);
    broadcast('questions_reordered', { matchId: id, liveState });
    res.json({ success: true, order: ordered.map((q) => q.id) });
  } catch (error: any) {
    log.error('Erreur réordonnancement de la série', { err: error });
    if (isMissingSchemaError(error)) {
      return res.status(503).json({ error: missingSchemaMessage() });
    }
    res.status(500).json({ error: 'Erreur lors du réordonnancement de la série' });
  }
});

matchesRouter.post('/:id/broadcast-step', requireAuth, requireJuryOrAdmin, controlLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { action } = req.body || {};

    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    if (match.status === FLOW.MATCH_STATUS.FINISHED || match.status === FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({
        error: 'Match terminé ou annulé : le scénario de diffusion est clos',
      });
    }
    if (match.status === FLOW.MATCH_STATUS.SCHEDULED) {
      return res.status(400).json({ error: 'Démarrez le match avant de lancer la diffusion' });
    }

    const mQuestions = await db
      .select()
      .from(matchQuestions)
      .where(eq(matchQuestions.matchId, id))
      .orderBy(matchQuestions.orderNumber);

    const current = normalizeCursor(
      match.broadcastStage,
      match.currentQuestionIndex,
      mQuestions.length
    );

    let target: BroadcastCursor | null;
    if (action === 'previous') {
      target = previousCursor(current, mQuestions.length);
      if (!target) {
        return res.status(400).json({ error: 'La diffusion est déjà à sa première étape' });
      }
    } else if (action === 'restart') {
      target = firstCursor();
    } else if (action === 'next') {
      target = nextCursor(current, mQuestions.length);
      if (!target) {
        return res.status(400).json({
          error: 'La diffusion est à son terme : terminez le match pour publier le résultat',
        });
      }
    } else {
      return res.status(400).json({ error: 'Action de diffusion invalide (next | previous | restart)' });
    }

    const questionChanged = target.questionIndex !== match.currentQuestionIndex;
    const nextMQ = mQuestions[target.questionIndex];
    const [nextQ] = nextMQ
      ? await db
          .select({ timeLimitSeconds: questions.timeLimitSeconds })
          .from(questions)
          .where(eq(questions.id, nextMQ.questionId))
          .limit(1)
      : [null];

    // Une question déjà résolue ne doit être ni rouverte ni remise au chrono.
    // On raisonne sur le STATUT de la question, indépendamment de l'index : ce
    // qui compte est « a-t-elle déjà été jouée », pas « l'index a-t-il bougé ».
    const neverPlayed =
      nextMQ?.status === FLOW.QUESTION_STATUS.PENDING ||
      nextMQ?.status === FLOW.QUESTION_STATUS.ACTIVE;
    const fresh = questionChanged && neverPlayed;

    const duration = nextQ?.timeLimitSeconds || CONFIG.DEFAULT_TIMER_SECONDS;

    // La politique du chronomètre est dans `lib/broadcastFlow.ts`, testée : elle
    // est restée ici une fois, et le défaut qu'elle contenait — chrono décompté
    // pendant la présentation des équipes — n'aurait été vu par aucun test de
    // bout en bout, parce qu'il ne produit aucune erreur, seulement un compteur
    // trop bas.
    const timerUpdate = timerUpdateForStep(
      {
        action,
        targetStage: target.stage,
        questionChanged,
        neverPlayed,
        previousSeconds: match.timerSecondsLeft,
        previousDuration: match.timerDuration,
      },
      duration
    );

    // Passer à l'étape FINAL, c'est montrer le score final : le jury qui avance
    // jusque-là diffuse les totaux par le même geste — sinon l'écran final
    // resterait masqué alors qu'on lui demande le résultat.
    let finalDiffusedEventId: number | null | undefined;
    if (target.stage === BROADCAST_STAGE.FINAL) {
      const [latest] = await db
        .select({ id: scoreEvents.id })
        .from(scoreEvents)
        .where(eq(scoreEvents.matchId, id))
        .orderBy(desc(scoreEvents.id))
        .limit(1);
      if (latest) finalDiffusedEventId = latest.id;
    }

    const [updated] = await db
      .update(matches)
      .set({
        broadcastStage: target.stage,
        // Plus d'étape ROSTER : pas d'échéance de bascule automatique.
        broadcastRosterUntil: null,
        ...(finalDiffusedEventId !== undefined ? { diffusedScoreEventId: finalDiffusedEventId } : {}),
        ...(questionChanged
          ? {
              currentQuestionIndex: target.questionIndex,
              currentQuestionId: nextMQ?.questionId ?? match.currentQuestionId,
            }
          : {}),
        ...(timerUpdate ?? {}),
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    if (fresh && nextMQ) {
      await db
        .update(matchQuestions)
        .set({ status: FLOW.QUESTION_STATUS.ACTIVE, startedAt: new Date() })
        .where(eq(matchQuestions.id, nextMQ.id));
    }

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'BROADCAST_STEP',
      'match',
      String(id),
      `Diffusion ${action}: ${current.stage} → ${target.stage} (question ${target.questionIndex + 1}/${mQuestions.length})`
    );

    const liveState = await getLiveState(match.eventId);
    broadcast('broadcast_step', {
      matchId: id,
      action,
      from: current,
      to: target,
      match: updated,
      liveState,
    });

    res.json({ ...updated, broadcast: target });
  } catch (error: any) {
    log.error('Erreur pilotage diffusion', { err: error });
    if (isMissingSchemaError(error)) {
      return res.status(503).json({ error: missingSchemaMessage() });
    }
    res.status(500).json({ error: 'Erreur lors du pilotage de la diffusion' });
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

/**
 * Annulation d'un match terminé.
 *
 * POURQUOI CELA EXISTE
 * --------------------
 * La suppression refuse (409) tout match ayant un historique de score, parce
 * que `score_events` est en ON DELETE CASCADE : effacer le match effacerait le
 * journal d'audit. Refus légitime — mais alors le comité n'avait AUCUNE façon de
 * retirer un résultat dont il s'aperçoit après coup. Le message d'erreur
 * proposait « annulez le match », et cette route n'existait pas.
 *
 * CE QUE « ANNULLÉ » SIGNIFIE, ET CE QUE ÇA NE SIGNIFIE PAS
 * ----------------------------------------------------------
 * Le statut `CANCELLED` existait déjà dans le schéma et était déjà compris par
 * le reste du code. Deux conséquences, déjà en place avant cette route :
 *
 *  - `calculateRankings` ne compte que les matchs `FINISHED` : un match annulé
 *    sort du classement. C'est le but.
 *  - la publication refuse les matchs ni `FINISHED` ni `CANCELLED` : un match
 *    annulé ne bloque donc pas la clôture de l'événement.
 *
 * Et ce que ça ne fait PAS : rien n'est effacé. La ligne, les scores et les
 * `score_events` restent. C'est ce qui distingue une annulation d'une
 * suppression — l'audit reste lisible, et `/restore` ramène le résultat.
 *
 * L'annulation est réversible par construction : voir la route suivante.
 */
matchesRouter.post('/:id/cancel', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    if (match.status === FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({ error: 'Ce match est déjà annulé' });
    }

    // Seul un match terminé s'annule. Un match en cours se termine d'abord — il
    // porte peut-être un score en cours, et « terminer » puis « annuler » se
    // voient dans le journal. Un match programmé, lui, se supprime : il n'a rien
    // à retirer.
    if (match.status !== FLOW.MATCH_STATUS.FINISHED) {
      return res.status(400).json({
        error:
          'Seul un match terminé peut être annulé. ' +
          'Un match en cours ou en pause doit d\'abord être terminé ; un match programmé se supprime directement.',
      });
    }

    const [updated] = await db
      .update(matches)
      .set({
        status: FLOW.MATCH_STATUS.CANCELLED,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    // Le score est conservé, et `endedAt` aussi : le match A bien eu lieu. Seule
    // sa prise en compte disparaît. Effacer l'un des deux ferait dire « ce match
    // n'a jamais existé », ce qui serait faux — et le journal d'audit mentirait.
    await logAudit(
      req.user?.uid,
      req.user?.email,
      'CANCEL_MATCH',
      'match',
      String(id),
      `Annulation du match ${id} (n° ${updated.matchNumber}) — score conservé ${updated.scoreA}-${updated.scoreB}, retiré du classement`
    );

    // Le classement change : c'est tout l'intérêt de l'annulation. Isolé du
    // `try` comme ailleurs — l'écriture est faite, une panne de diffusion ne
    // doit pas se présenter comme un échec.
    try {
      broadcast('match_cancelled', { matchId: id, liveState: await getLiveState(updated.eventId, true) });
    } catch (erreurDiffusion) {
      log.error('Diffusion match_cancelled impossible', { err: erreurDiffusion });
    }

    res.json(updated);
  } catch (error: any) {
    log.error('Erreur annulation match', { err: error });
    res.status(500).json({ error: 'Erreur lors de l\'annulation du match' });
  }
});

/**
 * Rétablissement d'un match annulé.
 *
 * Une annulation qui ne se reprend pas remplacerait le refus de suppression par
 * un piège pire : on aurait échangé « impossible de retirer un résultat » contre
 * « une annulation par erreur est définitive ». Les scores étant intacts, le
 * retour arrière ne consiste qu'à leur redonner leur place.
 *
 * Le match redevient `FINISHED` : il réintègre le classement tel qu'il y était,
 * score compris. Aucune autre écriture — rien n'avait bougé ailleurs.
 */
matchesRouter.post('/:id/restore', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [match] = await db.select().from(matches).where(eq(matches.id, id));
    if (!match) return res.status(404).json({ error: 'Match non trouvé' });

    if (match.status !== FLOW.MATCH_STATUS.CANCELLED) {
      return res.status(400).json({ error: 'Ce match n\'est pas annulé' });
    }

    const [updated] = await db
      .update(matches)
      .set({
        status: FLOW.MATCH_STATUS.FINISHED,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, id))
      .returning();

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'RESTORE_MATCH',
      'match',
      String(id),
      `Rétablissement du match ${id} (n° ${updated.matchNumber}) — score ${updated.scoreA}-${updated.scoreB} réintégré au classement`
    );

    try {
      broadcast('match_restored', { matchId: id, liveState: await getLiveState(updated.eventId, true) });
    } catch (erreurDiffusion) {
      log.error('Diffusion match_restored impossible', { err: erreurDiffusion });
    }

    res.json(updated);
  } catch (error: any) {
    log.error('Erreur rétablissement match', { err: error });
    res.status(500).json({ error: 'Erreur lors du rétablissement du match' });
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

    // score_events est en ON DELETE CASCADE : on autorise la suppression
    // d'un match terminé, y compris avec un historique de score. Le journal
    // d'audit est effacé avec le match pour permettre la purge demandée.

    await db.delete(matches).where(eq(matches.id, id));
    await logAudit(req.user?.uid, req.user?.email, 'DELETE_MATCH', 'match', String(id));

    // L'écran public et l'écran jury affichent ce match. Sans diffusion, le
    // fantôme y resterait jusqu'à la prochaine resynchronisation — c'est-à-dire
    // jusqu'au rechargement de la page, en pleine session, sur un écran projeté
    // que personne ne recharge. On repart donc de l'état serveur, comme pour
    // `match_finished`.
    //
    // Isolé du `try` pour la même raison que sur les équipes : le match est
    // DÉJÀ supprimé ici, donc une erreur de diffusion ne doit pas se déguiser
    // en échec de suppression.
    try {
      broadcast('match_deleted', { matchId: id, liveState: await getLiveState(target.eventId, true) });
    } catch (erreurDiffusion) {
      log.error('Diffusion match_deleted impossible', { err: erreurDiffusion });
    }

    res.json({ success: true });
  } catch (error: any) {
    log.error('DELETE match error', { err: error });
    res.status(500).json({ error: 'Erreur lors de la suppression du match' });
  }
});
