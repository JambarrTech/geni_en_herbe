import { db } from '../db/index.ts';
import {
  matches,
  matchQuestions,
  scoreEvents,
  teams,
  auditLogs,
  events,
  questions,
} from '../db/schema.ts';
import { eq, desc } from 'drizzle-orm';
import { type TeamRanking, type LiveStatePayload } from '../types.ts';
import { publicQuestion } from '../lib/sanitize.ts';
import { publish as publishBusEvent } from './pubsub.ts';
import { CONFIG, FLOW } from '../config.ts';
import { createLogger } from '../lib/logger.ts';
import { metrics } from '../lib/metrics.ts';

const log = createLogger('matchEngine');

// Web socket broadcast callback hook.
//
// L'API et le serveur WebSocket sont deux processus distincts : ce rappel en
// mémoire n'est donc plus le canal de diffusion principal. Il ne subsiste que
// pour le mode « tout-en-un » (npm run dev:all), où un seul processus héberge
// tout. En fonctionnement séparé, la diffusion transite par le bus
// PostgreSQL LISTEN/NOTIFY (cf. server/pubsub.ts) : `broadcast()` publie, et le
// serveur WebSocket relaie.
type BroadcastFn = (event: string, data: any) => void;
let broadcastCallback: BroadcastFn | null = null;

export function setBroadcastCallback(fn: BroadcastFn) {
  broadcastCallback = fn;
}

export function broadcast(event: string, data: any) {
  // 1. Bus inter-processus : c'est lui qui atteint le serveur WebSocket.
  void publishBusEvent({ type: event, data })
    .then(() => metrics.busPublished.inc({ type: event }))
    .catch((err) => {
      metrics.busErrors.inc({ type: event });
      // Non bloquant : l'état en base fait foi, et les clients se
      // resynchronisent à la reconnexion. Un échec ici signifie un écran
      // retardé, pas une action perdue.
      log.error(`Diffusion « ${event} » impossible via le bus`, { err });
    });

  // 2. Rappel en mémoire, seulement s'il existe (mode monolithique).
  if (broadcastCallback) {
    broadcastCallback(event, data);
  }
}

// Log audit action
export async function logAudit(
  userId: string | undefined,
  userEmail: string | undefined,
  action: string,
  entity: string,
  entityId: string,
  metadata?: string
) {
  try {
    await db.insert(auditLogs).values({
      userId: userId || 'anonymous',
      userEmail: userEmail || 'system@aeerks.sn',
      action,
      entity,
      entityId,
      metadata: metadata || null,
    });
  } catch (err) {
    // L'audit n'est jamais bloquant : une ligne manquante ne doit pas faire
    // échouer l'action métier qui venait de réussir. En revanche, un échec
    // répété ici est une perte de traçabilité réelle, donc on le compte et on
    // le signale.
    metrics.dbErrors.inc({ operation: 'audit' });
    log.error('Erreur enregistrement audit log', { err, action, entity });
  }
}

// Timer ticker auto-programmé (setTimeout successif, jamais de chevauchement).
// Si la base est injoignable, on espace les tentatives (backoff exponentiel borné)
// et on limite le spam de logs : erreur complète une seule fois, puis bref rappel.
let timerTimeout: NodeJS.Timeout | null = null;
let timerStopping = false;
let consecutiveDbFailures = 0;

export function stopAuthoritativeTimerLoop() {
  timerStopping = true;
  if (timerTimeout) {
    clearTimeout(timerTimeout);
    timerTimeout = null;
  }
}

export function startAuthoritativeTimerLoop() {
  if (timerTimeout || timerStopping) return;
  // Premier tick immédiat : on détecte vite un éventuel problème de base.
  scheduleNextTimerTick(0);
}

function scheduleNextTimerTick(delayMs: number) {
  if (timerStopping) return;
  timerTimeout = setTimeout(async () => {
    timerTimeout = null;
    let nextDelay: number = CONFIG.TIMER_LOOP_INTERVAL_MS;
    try {
      await timerLoopTick();
      consecutiveDbFailures = 0;
    } catch (err) {
      consecutiveDbFailures += 1;
      metrics.dbErrors.inc({ operation: 'timer-tick' });
      if (consecutiveDbFailures === 1) {
        // Une seule fois l'erreur complète : évite le mur de stack traces.
        log.error('Erreur boucle chrono serveur (base de données injoignable ?)', { err });
      } else if (consecutiveDbFailures % 20 === 0) {
        log.warn(`Boucle chrono : ${consecutiveDbFailures} échecs de base consécutifs`, {
          prochaineTentativeMs: nextDelay,
        });
      }
      nextDelay = Math.min(
        CONFIG.TIMER_LOOP_INTERVAL_MS *
          Math.pow(2, Math.min(consecutiveDbFailures, CONFIG.TIMER_LOOP_MAX_BACKOFF_STEPS)),
        CONFIG.TIMER_LOOP_MAX_BACKOFF_MS
      );
    }
    scheduleNextTimerTick(nextDelay);
  }, delayMs);
}

async function timerLoopTick() {
  // Find matches where timer is running
  const activeMatches = await db
    .select()
    .from(matches)
    .where(eq(matches.timerIsRunning, true));

  for (const m of activeMatches) {
    // Décompte autoritaire basé sur l'horloge murale (pas d'accumulation de dérive)
    let newSeconds = m.timerSecondsLeft;
    if (m.timerStartedAt) {
      const elapsed = Math.floor(
        (Date.now() - new Date(m.timerStartedAt).getTime()) / 1000
      );
      newSeconds = Math.max(0, m.timerDuration - elapsed);
    } else {
      newSeconds = m.timerSecondsLeft - 1;
    }

    const running = newSeconds > 0;

    // N'écrire et ne diffuser que si l'état a changé
    if (newSeconds !== m.timerSecondsLeft || running !== m.timerIsRunning) {
      await db
        .update(matches)
        .set({
          timerSecondsLeft: newSeconds,
          timerIsRunning: running,
          updatedAt: new Date(),
        })
        .where(eq(matches.id, m.id));

      broadcast('timer_tick', {
        matchId: m.id,
        timerSecondsLeft: newSeconds,
        timerIsRunning: running,
      });

      if (newSeconds === 0) {
        broadcast('timer_expired', {
          matchId: m.id,
          currentQuestionId: m.currentQuestionId,
        });
      }
    }
  }
}

// Recalculate match score purely from score_events
export async function recalculateMatchScore(matchId: number) {
  const eventsList = await db
    .select()
    .from(scoreEvents)
    .where(eq(scoreEvents.matchId, matchId));

  const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
  if (!match) return { scoreA: 0, scoreB: 0 };

  let scoreA = 0;
  let scoreB = 0;

  for (const ev of eventsList) {
    if (ev.teamId === match.teamAId) {
      scoreA += ev.points;
    } else if (ev.teamId === match.teamBId) {
      scoreB += ev.points;
    }
  }

  // Safety floor: scores cannot be negative
  scoreA = Math.max(0, scoreA);
  scoreB = Math.max(0, scoreB);

  await db
    .update(matches)
    .set({
      scoreA,
      scoreB,
      updatedAt: new Date(),
    })
    .where(eq(matches.id, matchId));

  return { scoreA, scoreB };
}

/**
 * Départage du classement.
 *
 * Extraite de `calculateRankings` pour être testable sans base de données.
 *
 * Deux points qui avaient produit des défauts réels :
 *  1. le critère final était `b.wins - a.wins` : deux équipes à égalité
 *     parfaite sur les trois premiers critères étaient départagées dans
 *     l'ordre arbitraire du SELECT, qui peut différer d'une requête à
 *     l'autre — donc un podium instable d'un rafraîchissement à l'autre.
 *     `teamId` rend le tri déterministe.
 *  2. les positions étaient `idx + 1` : deux égalités recevaient des positions
 *     distinctes (1, 2) alors qu'elles ne devraient pas l'être. Elles partagent
 *     maintenant la même position, et la suivante saute le rang
 *     (classement sportif : 1, 1, 3).
 */
export function sortAndRankRankings(rankings: TeamRanking[]): TeamRanking[] {
  rankings.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (b.pointsDifference !== a.pointsDifference) {
      return b.pointsDifference - a.pointsDifference;
    }
    if (b.wins !== a.wins) return b.wins - a.wins;
    // Départage déterministe : ordre d'identifiant, jamais l'ordre du SELECT.
    return a.teamId - b.teamId;
  });

  rankings.forEach((r, idx) => {
    const prev = rankings[idx - 1];
    const isTie =
      prev != null &&
      prev.totalScore === r.totalScore &&
      prev.pointsDifference === r.pointsDifference &&
      prev.wins === r.wins;
    r.position = isTie ? prev.position : idx + 1;
  });

  return rankings;
}

// Calculate team rankings for an event
export async function calculateRankings(eventId: number): Promise<TeamRanking[]> {
  const allTeams = await db
    .select({
      id: teams.id,
      name: teams.name,
      code: teams.code,
    })
    .from(teams)
    .where(eq(teams.eventId, eventId))
    .orderBy(teams.id);

  const allMatches = await db
    .select()
    .from(matches)
    .where(eq(matches.eventId, eventId));

  const statsMap = new Map<
    number,
    {
      matchesPlayed: number;
      wins: number;
      draws: number;
      losses: number;
      pointsScored: number;
      pointsConceded: number;
      totalScore: number;
    }
  >();

  for (const t of allTeams) {
    statsMap.set(t.id, {
      matchesPlayed: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      pointsScored: 0,
      pointsConceded: 0,
      totalScore: 0,
    });
  }

  for (const m of allMatches) {
    // Seuls les matchs clôturés comptent : un match en cours ne doit jamais
    // faire bouger le classement affiché (podium stable et crédible).
    if (m.status !== FLOW.MATCH_STATUS.FINISHED) continue;

    const statsA = statsMap.get(m.teamAId);
    const statsB = statsMap.get(m.teamBId);
    if (!statsA || !statsB) continue;

    statsA.pointsScored += m.scoreA;
    statsA.pointsConceded += m.scoreB;
    statsA.totalScore += m.scoreA;
    statsB.pointsScored += m.scoreB;
    statsB.pointsConceded += m.scoreA;
    statsB.totalScore += m.scoreB;

    statsA.matchesPlayed += 1;
    statsB.matchesPlayed += 1;

    if (m.scoreA > m.scoreB) {
      statsA.wins += 1;
      statsB.losses += 1;
    } else if (m.scoreB > m.scoreA) {
      statsB.wins += 1;
      statsA.losses += 1;
    } else {
      statsA.draws += 1;
      statsB.draws += 1;
    }
  }

  const rankings: TeamRanking[] = allTeams.map((t) => {
    const s = statsMap.get(t.id)!;
    return {
      position: 0,
      teamId: t.id,
      teamName: t.name,
      teamCode: t.code,
      matchesPlayed: s.matchesPlayed,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
      pointsScored: s.pointsScored,
      pointsConceded: s.pointsConceded,
      pointsDifference: s.pointsScored - s.pointsConceded,
      totalScore: s.totalScore,
    };
  });

  return sortAndRankRankings(rankings);
}

// Prepare comprehensive Live State payload.
// Le calcul du classement coûte plusieurs requêtes : il n'est inclus que lorsqu'il
// change (clôture d'un match, publication) ou quand il est explicitement demandé.
export async function getLiveState(eventId?: number, includeRankings = false): Promise<LiveStatePayload> {
  // Get active or first event
  let currentEvent = null;
  if (eventId) {
    const [ev] = await db.select().from(events).where(eq(events.id, eventId));
    currentEvent = ev;
  }
  if (!currentEvent) {
    const allEv = await db.select().from(events).orderBy(desc(events.id));
    currentEvent = allEv[0] || null;
  }

  if (!currentEvent) {
    return {
      event: null,
      activeMatch: null,
      upcomingMatches: [],
      completedMatches: [],
      rankings: [],
      resultsPublished: false,
      serverTimestamp: Date.now(),
    };
  }

  const evId = currentEvent.id;

  // Get teams
  const allTeams = await db.select().from(teams).where(eq(teams.eventId, evId));
  const teamMap = new Map(allTeams.map((t) => [t.id, t]));

  const enrichTeam = (t: typeof allTeams[0] | undefined) => (t ? { ...t } : null);

  // Get matches
  const allMatches = await db
    .select()
    .from(matches)
    .where(eq(matches.eventId, evId))
    .orderBy(matches.matchNumber);

  // Identify active match (LIVE or PAUSED or first READY)
  const activeMatchRaw =
    allMatches.find((m) => m.status === FLOW.MATCH_STATUS.LIVE || m.status === FLOW.MATCH_STATUS.PAUSED) ||
    allMatches.find((m) => m.status === FLOW.MATCH_STATUS.READY) ||
    null;

  let activeMatch = null;
  if (activeMatchRaw) {
    const teamA = enrichTeam(teamMap.get(activeMatchRaw.teamAId));
    const teamB = enrichTeam(teamMap.get(activeMatchRaw.teamBId));

    // Get current question (version publique : SANS la réponse officielle)
    let currentQuestion = null;
    if (activeMatchRaw.currentQuestionId) {
      const [q] = await db
        .select()
        .from(questions)
        .where(eq(questions.id, activeMatchRaw.currentQuestionId));
      currentQuestion = q ? publicQuestion(q) : null;
    }

    // Get match questions
    // Version publique volontairement réduite : ni le libellé, ni les points
    // attribués, ni l'équipeANTE qui a répondu. Le public voit la position dans
    // la série et le statut, pas le détail du barème.
    const mQuestions = await db
      .select({
        id: matchQuestions.id,
        questionId: matchQuestions.questionId,
        orderNumber: matchQuestions.orderNumber,
        status: matchQuestions.status,
      })
      .from(matchQuestions)
      .where(eq(matchQuestions.matchId, activeMatchRaw.id))
      .orderBy(matchQuestions.orderNumber);

    activeMatch = {
      ...activeMatchRaw,
      teamA,
      teamB,
      currentQuestion,
      matchQuestions: mQuestions,
    };
  }

const upcomingMatches = allMatches
    .filter((m) => m.status === FLOW.MATCH_STATUS.SCHEDULED || m.status === FLOW.MATCH_STATUS.READY)
    .map((m) => ({
      ...m,
      teamA: enrichTeam(teamMap.get(m.teamAId)),
      teamB: enrichTeam(teamMap.get(m.teamBId)),
    }));

const winnerTeamId = (m: { teamAId: number; teamBId: number; scoreA: number; scoreB: number }) =>
    m.scoreA > m.scoreB ? m.teamAId : m.scoreB > m.scoreA ? m.teamBId : null;

  const completedMatches = allMatches
    .filter((m) => m.status === FLOW.MATCH_STATUS.FINISHED)
    .map((m) => ({
      ...m,
      teamA: enrichTeam(teamMap.get(m.teamAId)),
      teamB: enrichTeam(teamMap.get(m.teamBId)),
      winnerTeamId: winnerTeamId(m),
    }));

  const rankings = includeRankings ? await calculateRankings(evId) : [];

  return {
    event: currentEvent as any,
    activeMatch: activeMatch as any,
    upcomingMatches: upcomingMatches as any,
    completedMatches: completedMatches as any,
    rankings,
    resultsPublished: currentEvent.resultsPublished,
    serverTimestamp: Date.now(),
  };
}