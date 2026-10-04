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
// - Otherwise the selection is balanced: active questions not already used in a
//   match of the same event, picked round-robin across categories.
export async function selectQuestionsForMatch(
  eventId: number,
  providedIds?: unknown
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

  // Round-robin dans l'ordre d'affichage des catégories (`position`) : la
  // catégorie que l'admin a placée en premier ouvre la série — donc l'écran
  // public — et chaque catégorie est ensuite représentée à tour de rôle, dans
  // l'ordre de SES questions. L'insertion triée garantit l'ordre des clés.
  const catRanks = new Map(
    (
      await db
        .select({ id: categories.id, position: categories.position })
        .from(categories)
    ).map((c) => [c.id, c.position] as const)
  );
  const byCategory = new Map<number, { id: number; categoryId: number }[]>();
  for (const q of sortPoolForMatch(pool, catRanks)) {
    if (usedIds.has(q.id)) continue;
    if (!byCategory.has(q.categoryId)) byCategory.set(q.categoryId, []);
    byCategory.get(q.categoryId)!.push(q);
  }

  const picked: number[] = [];
  const seen = new Set<number>();

  // Round-robin across categories -> balanced coverage
  while (seen.size < CONFIG.DEFAULT_MATCH_SIZE && byCategory.size > 0) {
    let addedAny = false;
    for (const catId of [...byCategory.keys()]) {
      const available = byCategory.get(catId)!;
      const candidate = available.find((q) => !seen.has(q.id));
      if (candidate) {
        seen.add(candidate.id);
        picked.push(candidate.id);
        addedAny = true;
        if (seen.size >= CONFIG.DEFAULT_MATCH_SIZE) break;
      } else {
        byCategory.delete(catId);
      }
    }
    if (!addedAny) break;
  }

  return picked.slice(0, CONFIG.DEFAULT_MATCH_SIZE);
}