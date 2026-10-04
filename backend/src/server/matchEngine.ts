import { db } from '../db/index.ts';
import {
  matches,
  matchQuestions,
  scoreEvents,
  teams,
  auditLogs,
  events,
  questions,
  categories,
} from '../db/schema.ts';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { type TeamRanking, type LiveStatePayload, type CategoryRankings, type DiffusedScore } from '../types.ts';
import { publicQuestion, revealedQuestion } from '../lib/sanitize.ts';
import {
  broadcastPosition,
  normalizeCursor,
} from '../lib/broadcastFlow.ts';
import { loadPublicRosters, type PublicTeamMember } from '../lib/publicRoster.ts';
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
export async function recalculateMatchScore(matchId: number) {  const eventsList = await db
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

// Ligne de journal exploitable pour un classement par catégorie : l'équipe,
// les points, et la catégorie (via la question). Les événements SANS question
// rattachée (ajustements manuels) ne comptent dans aucune catégorie.
export interface CategoryScoreRow {
  teamId: number;
  points: number;
  categoryId: number | null;
}

/**
 * Agrège des lignes de score en classements par catégorie. PURE ET TESTABLE :
 * la lecture base de données vit dans `calculateCategoryRankings`, l'arithmétique
 * ici — un podium faux se voit dans un test, pas sur l'écran de la salle.
 *
 * Règles :
 * - catégories ordonnées par (`position`, `id`) : le même ordre que la banque
 *   groupée et l'écran public ;
 * - toutes les équipes figurent dans chaque catégorie (zéro explicite plutôt
 *   qu'absence : une absence se lit comme un oubli) ;
 * - tri par points décroissants, puis bonnes réponses décroissantes, puis
 *   identifiant croissant (déterministe) ; ex æquo parfait = position partagée.
 */
export function aggregateCategoryStandings(
  teamList: { id: number; name: string; code: string }[],
  categoryList: { id: number; name: string; position: number }[],
  rows: CategoryScoreRow[]
): CategoryRankings[] {
  const orderedCategories = [...categoryList].sort(
    (a, b) => a.position - b.position || a.id - b.id
  );

  return orderedCategories.map((cat) => {
    const pointsByTeam = new Map<number, number>();
    const answeredByTeam = new Map<number, number>();
    for (const t of teamList) {
      pointsByTeam.set(t.id, 0);
      answeredByTeam.set(t.id, 0);
    }
    for (const row of rows) {
      if (row.categoryId !== cat.id) continue;
      if (!pointsByTeam.has(row.teamId)) continue;
      pointsByTeam.set(row.teamId, pointsByTeam.get(row.teamId)! + row.points);
      if (row.points > 0) {
        answeredByTeam.set(row.teamId, answeredByTeam.get(row.teamId)! + 1);
      }
    }

    const standings = teamList
      .map((t) => ({
        position: 0,
        teamId: t.id,
        teamName: t.name,
        teamCode: t.code,
        points: pointsByTeam.get(t.id) ?? 0,
        questionsAnswered: answeredByTeam.get(t.id) ?? 0,
      }))
      .sort((a, b) => b.points - a.points || b.questionsAnswered - a.questionsAnswered || a.teamId - b.teamId);

    standings.forEach((s, idx) => {
      const prev = standings[idx - 1];
      s.position =
        prev && prev.points === s.points && prev.questionsAnswered === s.questionsAnswered
          ? prev.position
          : idx + 1;
    });

    return {
      categoryId: cat.id,
      categoryName: cat.name,
      categoryPosition: cat.position,
      standings,
    };
  });
}

// Classement des équipes, catégorie par catégorie, pour un événement.
// Seuls les matchs clôturés comptent (même règle que `calculateRankings`) :
// un match en cours ne doit jamais faire bouger un podium affiché.
export async function calculateCategoryRankings(eventId: number): Promise<CategoryRankings[]> {
  const [allTeams, allCategories, allMatches] = await Promise.all([
    db
      .select({ id: teams.id, name: teams.name, code: teams.code })
      .from(teams)
      .where(eq(teams.eventId, eventId))
      .orderBy(teams.id),
    db
      .select({ id: categories.id, name: categories.name, position: categories.position })
      .from(categories),
    db
      .select({ id: matches.id, status: matches.status })
      .from(matches)
      .where(eq(matches.eventId, eventId)),
  ]);

  const closedIds = allMatches
    .filter((m) => m.status === FLOW.MATCH_STATUS.FINISHED)
    .map((m) => m.id);

  let rows: CategoryScoreRow[] = [];
  if (closedIds.length > 0) {
    const events = await db
      .select({
        teamId: scoreEvents.teamId,
        points: scoreEvents.points,
        categoryId: questions.categoryId,
      })
      .from(scoreEvents)
      .leftJoin(questions, eq(scoreEvents.questionId, questions.id))
      .where(inArray(scoreEvents.matchId, closedIds));
    rows = events.map((e) => ({
      teamId: e.teamId,
      points: e.points,
      categoryId: e.categoryId ?? null,
    }));
  }

  return aggregateCategoryStandings(allTeams, allCategories, rows);
}

// Ligne de journal exploitable pour l'écran public : identifiant,
// équipe et points — le reste (nom d'équipe, question) est résolu à la lecture.
export interface PublicScoreEvent {
  id: number;
  teamId: number;
  points: number;
}

/**
 * Totaux approuvés par le jury : somme des événements jusqu'au marqueur de
 * diffusion inclus — et RIEN si le marqueur est nul. Même plancher que le
 * recalcul officiel (`Math.max(0, …)`) pour que l'écran ne montre jamais un
 * score que le match n'affiche pas.
 *
 * Le `null` strict est volontaire : un marqueur absent ne doit pas « tout
 * inclure par défaut », sinon les vrais totaux partiraient au public dans le
 * payload au moment même où l'écran les masque.
 */
export function sumEventsUpTo(
  events: PublicScoreEvent[],
  upToId: number | null,
  teamAId: number,
  teamBId: number
): { scoreA: number; scoreB: number } {
  let totalA = 0;
  let totalB = 0;
  if (upToId === null) return { scoreA: 0, scoreB: 0 };
  for (const e of events) {
    if (e.id > upToId) continue;
    if (e.teamId === teamAId) totalA += e.points;
    else if (e.teamId === teamBId) totalB += e.points;
  }
  return { scoreA: Math.max(0, totalA), scoreB: Math.max(0, totalB) };
}

/**
 * L'écran public doit-il masquer les scores de ce match ?
 *
 * - aucun point attribué : non, 0-0 n'a rien à cacher ;
 * - sinon : seulement si chaque point attribué a été diffusé. Un seul
 *   événement postérieur au marqueur, et l'écran masque — c'est le jury qui
 *   décide du moment, pas l'attribution.
 *
 * Y compris après clôture (`FINISHED`) : clôturer un match ne diffuse rien
 * par lui-même. Sans cela, le bouton « Clôturer » publierait les totaux sans
 * décision explicite, et l'étape FINAL perdrait son sens (elle resterait
 * masquée pendant que le match clôturé afficherait tout).
 */
export function isScoreHidden(
  status: string,
  eventIds: number[],
  diffusedEventId: number | null
): boolean {
  void status;
  if (eventIds.length === 0) return false;
  if (diffusedEventId == null) return true;
  return eventIds.some((id) => id > diffusedEventId);
}

/**
 * Annonce de points telle que le public a le droit de la voir, ou `null`.
 *
 * `null` dans trois cas, tous voulus : aucun marqueur (rien diffusé), marqueur
 * inconnu (événement supprimé ou d'un autre match — on n'invente pas une
 * annonce), match sans cet événement. Un marqueur corrompu masque donc les
 * scores au lieu d'en afficher de faux (cf. `isScoreHidden`).
 */
export async function getDiffusedScore(match: {
  id: number;
  teamAId: number;
  teamBId: number;
  diffusedScoreEventId: number | null;
}): Promise<DiffusedScore | null> {
  const eventId = match.diffusedScoreEventId;
  if (!eventId) return null;

  const [ev] = await db
    .select({
      id: scoreEvents.id,
      teamId: scoreEvents.teamId,
      points: scoreEvents.points,
      type: scoreEvents.type,
      reason: scoreEvents.reason,
      questionId: scoreEvents.questionId,
      createdAt: scoreEvents.createdAt,
    })
    .from(scoreEvents)
    .where(and(eq(scoreEvents.id, eventId), eq(scoreEvents.matchId, match.id)))
    .limit(1);
  if (!ev) return null;

  const [team] = await db
    .select({ name: teams.name, code: teams.code })
    .from(teams)
    .where(eq(teams.id, ev.teamId))
    .limit(1);

  let questionIndex: number | null = null;
  if (ev.questionId) {
    const [mq] = await db
      .select({ orderNumber: matchQuestions.orderNumber })
      .from(matchQuestions)
      .where(and(eq(matchQuestions.matchId, match.id), eq(matchQuestions.questionId, ev.questionId)))
      .limit(1);
    if (mq) questionIndex = mq.orderNumber - 1;
  }

  return {
    eventId: ev.id,
    teamId: ev.teamId,
    teamName: team?.name ?? 'Équipe',
    teamCode: team?.code ?? '',
    points: ev.points,
    type: ev.type,
    reason: ev.reason,
    questionId: ev.questionId,
    questionIndex,
    createdAt: ev.createdAt instanceof Date ? ev.createdAt.toISOString() : String(ev.createdAt),
  };
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

  // Match à afficher : en cours, en pause, ou prêt à jouer — sinon le DERNIER
  // match terminé.
  //
  // Le troisième cas n'existait pas, et il rendait inatteignable l'écran des
  // scores finaux : clôturer un match le faisait disparaître de l'état live,
  // donc l'écran public basculait sur « le concours commence bientôt » alors que
  // la rencontre venait d'être jouée. Les scores des deux équipes n'étaient donc
  // projetés à aucun moment de la partie — et la branche d'écran qui devait les
  // afficher ne pouvait pas l'être.
  //
  // Ce repli ne masque que le temps qu'aucun autre match ne réclame l'écran :
  // dès que le suivant passe READY, il prend la main. La fenêtre affichée est
  // donc exactement l'inter-match — celle où la salle regarde le résultat de ce
  // qu'elle vient de voir.
  //
  // Les matchs ANNULÉS en sont exclus, eux : une rencontre abandonnée en cours de
  // route n'a pas de résultat à afficher, et laisser ses scores définitifs à
  // l'écran ferait passer une interruption pour un résultat. Le motif reste dans
  // `completedMatches`, qui garde l'historique.
  const activeMatchRaw =
    allMatches.find((m) => m.status === FLOW.MATCH_STATUS.LIVE || m.status === FLOW.MATCH_STATUS.PAUSED) ||
    allMatches.find((m) => m.status === FLOW.MATCH_STATUS.READY) ||
    [...allMatches]
      .reverse()
      .find((m) => m.status === FLOW.MATCH_STATUS.FINISHED) ||
    null;

  let activeMatch = null;
  if (activeMatchRaw) {
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

    // Scénario de diffusion : c'est lui, et lui seul, qui décide de ce que le
    // public a le droit de voir. Voir `lib/broadcastFlow.ts` pour le déroulé.
    const stage = broadcastPosition(
      normalizeCursor(
        activeMatchRaw.broadcastStage,
        activeMatchRaw.currentQuestionIndex,
        mQuestions.length
      ),
      mQuestions.length
    );
    // La bascule automatique de l'effectif n'est annoncée que si elle est
    // réellement programmée : `broadcastRosterUntil` n'est renseigné que pendant
    // l'étape `ROSTER` (invariant appliqué à l'écriture), donc le `showsRoster`
    // suffit à savoir qu'il n'y a pas d'échéance résiduelle à ignorer.
    const rosterUntil = stage.showsRoster ? (activeMatchRaw.broadcastRosterUntil ?? null) : null;

    // Question affichée : celle sur laquelle se pose le curseur, et non celle
    // que porte `current_question_id`.
    //
    // Les deux désignent normalement la même question — `broadcast-step` écrit
    // les deux d'un seul coup. Mais l'écran public doit montrer ce que le
    // scénario ANNONCE : s'ils divergeaient, afficher `current_question_id`
    // diffuserait un énoncé différent de celui de l'étape courante, et la
    // réponse révélée à l'étape REVEAL serait celle d'une autre question que
    // celle dont le public lit le texte. Le curseur l'emporte.
    const cursorMQ =
      mQuestions[stage.cursor.questionIndex] ??
      mQuestions.find((mq) => mq.questionId === activeMatchRaw.currentQuestionId) ??
      null;

    // Get current question. La version publique est SANS la réponse officielle…
    // …sauf à l'étape REVEAL, où le jury a explicitement diffusé la bonne
    // réponse. La porte est le scénario, côté serveur : voir
    // `lib/sanitize.ts`.
    let currentQuestion = null;
    const currentQuestionId = cursorMQ?.questionId ?? activeMatchRaw.currentQuestionId;
    if (currentQuestionId) {
      // Le nom et la position de la catégorie accompagnent l'énoncé : l'écran
      // public affiche déjà un badge `categoryName` (jamais renseigné
      // jusqu'ici, la question étant lue sans jointure), et l'ordre des
      // catégories décide de l'ordre des questions.
      const [q] = await db
        .select({
          id: questions.id,
          categoryId: questions.categoryId,
          categoryName: categories.name,
          categoryPosition: categories.position,
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
        .leftJoin(categories, eq(questions.categoryId, categories.id))
        .where(eq(questions.id, currentQuestionId));
      currentQuestion = stage.revealsAnswer ? revealedQuestion(q) : publicQuestion(q);
    }

    const teamA = enrichTeam(teamMap.get(activeMatchRaw.teamAId));
    const teamB = enrichTeam(teamMap.get(activeMatchRaw.teamBId));

    // Effectif des équipes : chargé UNIQUEMENT à l'étape `ROSTER`.
    //
    // Deux raisons, et la seconde compte autant que la première.
    //  - `getLiveState` est appelé à chaque diffusion (score, changement de
    //    question, synchronisation de chrono) : deux requêtes de plus à chaque
    //    fois, pour des noms que l'écran n'affiche pas.
    //  - `/api/live` est public. Tenir l'effectif en permanence l'exposerait en
    //    continu, y compris pendant les questions. Il ne part que pendant
    //    l'étape prévue pour le montrer.
    //
    // Le type est déclaré explicitement : `enrichTeam` renvoie la ligne d'équipe
    // brute, dont le type est clos. Sans cette annotation, le contrôle de
    // propriété en trop de TypeScript refuse `members` — le message d'erreur est
    // ici le bon signal, on choisit donc de l'écouter plutôt que de contourner.
    type PublicTeamRow = NonNullable<typeof teamA> & { members?: PublicTeamMember[] };
    let teamAOut: PublicTeamRow | null = teamA;
    let teamBOut: PublicTeamRow | null = teamB;
    if (stage.showsRoster) {
      const rosters = await loadPublicRosters([activeMatchRaw.teamAId, activeMatchRaw.teamBId]);
      if (teamA) teamAOut = { ...teamA, members: rosters.get(teamA.id) ?? [] };
      if (teamB) teamBOut = { ...teamB, members: rosters.get(teamB.id) ?? [] };
    }

    // Points visibles par le public : JAMAIS les totaux en direct, ni pendant
    // le match ni après clôture. Seuls les points diffusés par le jury (ou
    // l'admin, bouton « Diffuser le résultat ») partent sur l'écran — voir
    // `diffused_score_event_id` (migration 0009). Un point attribué puis non
    // diffusé reste invisible : le marqueur prend du retard et l'écran montre
    // les derniers totaux approuvés, ou masque tout s'il n'y en a aucun.
    const publicEvents = await db
      .select({ id: scoreEvents.id, teamId: scoreEvents.teamId, points: scoreEvents.points })
      .from(scoreEvents)
      .where(eq(scoreEvents.matchId, activeMatchRaw.id));
    const publicEventIds = publicEvents.map((e) => e.id);
    const scoresHidden = isScoreHidden(
      activeMatchRaw.status,
      publicEventIds,
      activeMatchRaw.diffusedScoreEventId ?? null
    );
    const approved = sumEventsUpTo(
      publicEvents,
      activeMatchRaw.diffusedScoreEventId ?? null,
      activeMatchRaw.teamAId,
      activeMatchRaw.teamBId
    );
    const diffusedScore = scoresHidden
      ? null
      : await getDiffusedScore({
          id: activeMatchRaw.id,
          teamAId: activeMatchRaw.teamAId,
          teamBId: activeMatchRaw.teamBId,
          diffusedScoreEventId: activeMatchRaw.diffusedScoreEventId ?? null,
        });

    activeMatch = {
      ...activeMatchRaw,
      teamA: teamAOut,
      teamB: teamBOut,
      currentQuestion,
      matchQuestions: mQuestions,
      // Totaux publics : les vrais totaux quand rien ne les cache, les totaux
      // approuvés sinon. `scoresHidden` dit à l'écran lequel des deux il
      // montre — sans lui, un 0-0 approuvé serait indiscernable d'un masquage.
      scoreA: scoresHidden ? approved.scoreA : activeMatchRaw.scoreA,
      scoreB: scoresHidden ? approved.scoreB : activeMatchRaw.scoreB,
      scoresHidden,
      diffusedScore,
      // Scénario dérivé, transmis tel quel : ni l'écran public ni le tableau de
      // jury n'ont à recalculer la position, et les deux affichent donc
      // exactement la même étape.
      broadcast: {
        stage: stage.cursor.stage,
        questionIndex: stage.cursor.questionIndex,
        questionCount: mQuestions.length,
        stepNumber: stage.stepNumber,
        totalSteps: stage.totalSteps,
        canAdvance: stage.canAdvance,
        canRewind: stage.canRewind,
        revealsAnswer: stage.revealsAnswer,
        showsRoster: stage.showsRoster,
        // Envoyé au jury pour qu'il VOIE l'écran bouger sans lui. Une bascule
        // automatique qu'on ne voit pas venir est pire que pas de bascule : au
        // milieu d'une phrase, l'écran change et le jury ne sait pas si c'est
        // prévu. Une date, pas un nombre de secondes — cf. `useRosterCountdown`.
        rosterUntil: rosterUntil ? rosterUntil.toISOString() : null,
      },
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

  // Les matchs clôturés suivent la même règle que le match en cours : leurs
  // totaux ne partent sur l'écran public que si le jury les a diffusés.
  // Sans cela, `/api/live` (public) exposerait les résultats définitifs dès
  // la clôture, contournant le bouton « Diffuser le résultat » — y compris
  // via `winnerTeamId`, qui désigne le vainqueur à lui seul.
  const completedRaw = allMatches.filter((m) => m.status === FLOW.MATCH_STATUS.FINISHED);
  const completedIds = completedRaw.map((m) => m.id);
  const completedEvents =
    completedIds.length > 0
      ? await db
          .select({
            id: scoreEvents.id,
            matchId: scoreEvents.matchId,
            teamId: scoreEvents.teamId,
            points: scoreEvents.points,
          })
          .from(scoreEvents)
          .where(inArray(scoreEvents.matchId, completedIds))
      : [];
  const eventsByMatch = new Map<number, typeof completedEvents>();
  for (const e of completedEvents) {
    if (!eventsByMatch.has(e.matchId)) eventsByMatch.set(e.matchId, []);
    eventsByMatch.get(e.matchId)!.push(e);
  }

  const completedMatches = completedRaw.map((m) => {
    const evs = eventsByMatch.get(m.id) ?? [];
    const hidden = isScoreHidden(
      m.status,
      evs.map((e) => e.id),
      m.diffusedScoreEventId ?? null
    );
    const approved = sumEventsUpTo(evs, m.diffusedScoreEventId ?? null, m.teamAId, m.teamBId);
    return {
      ...m,
      teamA: enrichTeam(teamMap.get(m.teamAId)),
      teamB: enrichTeam(teamMap.get(m.teamBId)),
      scoreA: hidden ? approved.scoreA : m.scoreA,
      scoreB: hidden ? approved.scoreB : m.scoreB,
      scoresHidden: hidden,
      winnerTeamId: hidden ? null : winnerTeamId(m),
    };
  });

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