import { db } from '../db/index.ts';
import { categories, questions, matchQuestions, matches } from '../db/schema.ts';
import { eq, inArray } from 'drizzle-orm';
import { CONFIG } from '../config.ts';

export interface MatchPoolRow {
  id: number;
  categoryId: number;
  position: number;
}

/**
 * Découpe la série d'un match dans un vivier DÉJÀ TRIÉ (cf. `sortPoolForMatch`).
 * PURE ET TESTÉE : c'est elle qui garantit que l'écran public déroule la
 * banque dans l'ordre des priorités — catégorie après catégorie, question
 * après question — au lieu d'alterner entre catégories.
 *
 * Les questions déjà jouées dans l'événement (`usedIds`) sont sautées, jamais
 * réutilisées ; `limit` tronque la fin de la série (une série courte joue le
 * début des priorités : DUEL d'abord, pas un panaché).
 */
export function pickSeriesInPriorityOrder(
  sorted: { id: number }[],
  usedIds: Set<number>,
  limit: number
): number[] {
  const picked: number[] = [];
  for (const q of sorted) {
    if (picked.length >= limit) break;
    if (usedIds.has(q.id)) continue;
    picked.push(q.id);
  }
  return picked;
}

/**
 * Trie le vivier de questions pour un match : catégorie d'abord (ordre
 * d'affichage décidé par l'admin), puis question dans sa catégorie, puis
 * identifiant (déterministe). PURE ET TESTÉE : l'ordre d'ouverture de l'écran
 * public en dépend directement.
 *
 * Les catégories inconnues (supprimées entre deux lectures) passent en
 * dernier plutôt que de disparaître : une question existante ne doit jamais
 * être silencieusement écartée de la sélection.
 */
export function sortPoolForMatch(
  pool: MatchPoolRow[],
  categoryRank: Map<number, number>
): MatchPoolRow[] {
  const rankOf = (catId: number) => categoryRank.get(catId) ?? Number.MAX_SAFE_INTEGER;
  return [...pool].sort(
    (a, b) =>
      rankOf(a.categoryId) - rankOf(b.categoryId) ||
      a.position - b.position ||
      a.id - b.id
  );
}

// Select questions for a match.
// - If explicit ids are provided, they are validated (must exist) and kept in order.
// - Otherwise the series follows the admin priorities, exactly like the bank
//   and the public screen: categories in display order (`position` decided by
//   the committee, the first one opens the series), then questions in their
//   category order. `matchQuestions.orderNumber` records that order, and the
//   broadcast scenario walks it from the first to the last.
// - `maxSize` caps the automatic pick (explicit ids are never truncated : when
//   the committee chooses the series, it gets exactly what it chose).
// - Questions already played in a match of the same event are never reused.
export async function selectQuestionsForMatch(
  eventId: number,
  providedIds?: unknown,
  maxSize: number = CONFIG.DEFAULT_MATCH_SIZE
): Promise<number[]> {
  const requested = Array.isArray(providedIds)
    ? providedIds
        .map((id) => parseInt(String(id), 10))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];

  if (requested.length > 0) {
    const unique = [...new Set(requested)];
    const rows = await db
      .select({ id: questions.id })
      .from(questions)
      .where(inArray(questions.id, unique));
    const found = new Set(rows.map((r) => r.id));
    return unique.filter((id) => found.has(id));
  }

  // Ids already used in any match of this event (no reuse)
  const usedRows = await db
    .select({ questionId: matchQuestions.questionId })
    .from(matchQuestions)
    .innerJoin(matches, eq(matchQuestions.matchId, matches.id))
    .where(eq(matches.eventId, eventId));
  const usedIds = new Set(usedRows.map((r) => r.questionId));

  const pool = await db
    .select({
      id: questions.id,
      categoryId: questions.categoryId,
      position: questions.position,
      difficulty: questions.difficulty,
    })
    .from(questions)
    .where(eq(questions.active, true));

  // Série dans l'ordre des priorités admin : la catégorie placée en premier
  // ouvre la série — donc l'écran public — puis chaque catégorie déroule SES
  // questions dans l'ordre configuré. Le même tri sert au bouton
  // « réordonner » (`POST /:id/reorder-questions`) : création et
  // réordonnancement produisent le même ordre, sans surprise.
  const catRanks = new Map(
    (
      await db
        .select({ id: categories.id, position: categories.position })
        .from(categories)
    ).map((c) => [c.id, c.position] as const)
  );
  const sorted = sortPoolForMatch(pool, catRanks);

  const limit =
    Number.isInteger(maxSize) && maxSize > 0 ? Math.min(maxSize, 200) : CONFIG.DEFAULT_MATCH_SIZE;

  return pickSeriesInPriorityOrder(sorted, usedIds, limit);
}