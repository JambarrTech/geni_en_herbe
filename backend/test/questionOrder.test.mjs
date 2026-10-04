/**
 * Tests du tri du vivier de questions (`sortPoolForMatch`).
 *
 * Cet ordre décide de l'ouverture de l'écran public : la catégorie placée en
 * premier par l'admin ouvre la série, et chaque catégorie présente SES
 * questions dans l'ordre configuré. Un tri muet (ordre d'insertion base,
 * identifiants) ferait passer une autre catégorie — ou une autre question —
 * en premier sans que personne ne l'ait demandé.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sortPoolForMatch } from '../src/lib/selectQuestions.ts';

function row(id, categoryId, position) {
  return { id, categoryId, position };
}

const ranks = new Map([
  [10, 2],
  [20, 1],
]);

test('la catégorie en premier passe en premier, quel que soit l’ordre d’entrée', () => {
  const sorted = sortPoolForMatch(
    [row(1, 10, 1), row(2, 20, 1), row(3, 10, 2)],
    ranks
  );
  assert.deepEqual(
    sorted.map((q) => q.id),
    [2, 1, 3]
  );
});

test('dans une catégorie, les questions suivent leur position', () => {
  const sorted = sortPoolForMatch(
    [row(3, 20, 3), row(1, 20, 1), row(2, 20, 2)],
    ranks
  );
  assert.deepEqual(
    sorted.map((q) => q.id),
    [1, 2, 3]
  );
});

test('à position égale, l’identifiant départage (déterministe)', () => {
  const sorted = sortPoolForMatch([row(9, 20, 1), row(7, 20, 1)], ranks);
  assert.deepEqual(
    sorted.map((q) => q.id),
    [7, 9]
  );
});

test('une catégorie inconnue passe en dernier, sans disparaître', () => {
  const sorted = sortPoolForMatch([row(1, 999, 1), row(2, 20, 1)], ranks);
  assert.deepEqual(
    sorted.map((q) => q.id),
    [2, 1]
  );
});

test('le tableau d’entrée n’est pas muté', () => {
  const pool = [row(2, 20, 1), row(1, 10, 1)];
  sortPoolForMatch(pool, ranks);
  assert.deepEqual(
    pool.map((q) => q.id),
    [2, 1]
  );
});
