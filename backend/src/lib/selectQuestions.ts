import { db } from '../db/index.ts';
import { categories, questions, matchQuestions, matches } from '../db/schema.ts';
import { asc, eq, inArray } from 'drizzle-orm';
import { CONFIG } from '../config.ts';

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
      difficulty: questions.difficulty,
    })
    .from(questions)
    .where(eq(questions.active, true));

  const byCategory = new Map<number, { id: number; categoryId: number }[]>();
  for (const q of pool) {
    if (usedIds.has(q.id)) continue;
    if (!byCategory.has(q.categoryId)) byCategory.set(q.categoryId, []);
    byCategory.get(q.categoryId)!.push(q);
  }

  const picked: number[] = [];
  const seen = new Set<number>();

  // Round-robin dans l'ordre d'affichage des catégories (`position`) : la
  // catégorie que l'admin a placée en premier ouvre la série — donc l'écran
  // public — et chaque catégorie est ensuite représentée à tour de rôle.
  const catPositions = new Map(
    (
      await db
        .select({ id: categories.id, position: categories.position })
        .from(categories)
        .orderBy(asc(categories.position), asc(categories.id))
    ).map((c) => [c.id, c.position] as const)
  );
  const rankOf = (catId: number) => catPositions.get(catId) ?? Number.MAX_SAFE_INTEGER;
  const orderedCatIds = [...byCategory.keys()].sort(
    (a, b) => rankOf(a) - rankOf(b) || a - b
  );

  // Round-robin across categories -> balanced coverage
  while (seen.size < CONFIG.DEFAULT_MATCH_SIZE && orderedCatIds.length > 0) {
    let addedAny = false;
    for (const catId of [...orderedCatIds]) {
      const available = byCategory.get(catId)!;
      const candidate = available.find((q) => !seen.has(q.id));
      if (candidate) {
        seen.add(candidate.id);
        picked.push(candidate.id);
        addedAny = true;
        if (seen.size >= CONFIG.DEFAULT_MATCH_SIZE) break;
      } else {
        byCategory.delete(catId);
        orderedCatIds.splice(orderedCatIds.indexOf(catId), 1);
      }
    }
    if (!addedAny) break;
  }

  return picked.slice(0, CONFIG.DEFAULT_MATCH_SIZE);
}