/**
 * Tests du classement par catégorie (`aggregateCategoryStandings`).
 *
 * Ce calcul décide du podium affiché PAR DISCIPLINE sur l'écran public et
 * dans l'administration. Comme le classement général, il doit être
 * déterministe (mêmes lignes en entrée, même podium en sortie) et ne jamais
 * faire bouger un podium avec un match en cours — cette dernière règle vit
 * dans `calculateCategoryRankings` (filtrage des matchs clôturés), l'arithmétique
 * pure est éprouvée ici.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCategoryStandings } from '../src/server/matchEngine.ts';

const teams = [
  { id: 1, name: 'Equipe 1', code: 'E1' },
  { id: 2, name: 'Equipe 2', code: 'E2' },
];

const categories = [
  { id: 10, name: 'DUEL', position: 2 },
  { id: 20, name: 'ECLAIRS', position: 1 },
];

test('les catégories suivent l’ordre d’affichage, pas l’ordre d’entrée', () => {
  const r = aggregateCategoryStandings(teams, categories, []);
  assert.deepEqual(
    r.map((c) => c.categoryId),
    [20, 10]
  );
});

test('les points sont cumulés par équipe et par catégorie', () => {
  const r = aggregateCategoryStandings(teams, categories, [
    { teamId: 1, points: 10, categoryId: 10 },
    { teamId: 1, points: 20, categoryId: 10 },
    { teamId: 2, points: 15, categoryId: 10 },
    { teamId: 2, points: 5, categoryId: 20 },
  ]);
  const duel = r.find((c) => c.categoryId === 10);
  assert.equal(duel.standings[0].teamId, 1);
  assert.equal(duel.standings[0].points, 30);
  assert.equal(duel.standings[1].teamId, 2);
  assert.equal(duel.standings[1].points, 15);
  const eclairs = r.find((c) => c.categoryId === 20);
  assert.equal(eclairs.standings[0].teamId, 2);
  assert.equal(eclairs.standings[0].points, 5);
});

test('toutes les équipes figurent dans chaque catégorie, même à zéro', () => {
  const r = aggregateCategoryStandings(teams, categories, [
    { teamId: 1, points: 10, categoryId: 10 },
  ]);
  const eclairs = r.find((c) => c.categoryId === 20);
  assert.equal(eclairs.standings.length, 2);
  assert.deepEqual(
    eclairs.standings.map((s) => s.points),
    [0, 0]
  );
});

test('les lignes sans catégorie (ajustements manuels) ne comptent nulle part', () => {
  const r = aggregateCategoryStandings(teams, categories, [
    { teamId: 1, points: 100, categoryId: null },
  ]);
  for (const c of r) {
    assert.deepEqual(
      c.standings.map((s) => s.points),
      [0, 0]
    );
  }
});

test('les lignes d’équipes inconnues sont ignorées', () => {
  const r = aggregateCategoryStandings(teams, categories, [
    { teamId: 999, points: 50, categoryId: 10 },
  ]);
  const duel = r.find((c) => c.categoryId === 10);
  assert.equal(duel.standings.length, 2);
});

test('ex æquo parfait : position partagée, rang suivant sauté', () => {
  const r = aggregateCategoryStandings(
    [...teams, { id: 3, name: 'Equipe 3', code: 'E3' }],
    categories,
    [
      { teamId: 1, points: 10, categoryId: 10 },
      { teamId: 2, points: 10, categoryId: 10 },
    ]
  );
  const duel = r.find((c) => c.categoryId === 10);
  assert.deepEqual(
    duel.standings.map((s) => s.position),
    [1, 1, 3]
  );
});

test('à points égaux, les bonnes réponses départagent', () => {
  const r = aggregateCategoryStandings(teams, categories, [
    { teamId: 1, points: 10, categoryId: 10 },
    { teamId: 2, points: 5, categoryId: 10 },
    { teamId: 2, points: 5, categoryId: 10 },
  ]);
  const duel = r.find((c) => c.categoryId === 10);
  // 10 pts chacun, mais l'équipe 2 a deux bonnes réponses contre une : elle passe devant.
  assert.equal(duel.standings[0].teamId, 2);
  assert.equal(duel.standings[0].questionsAnswered, 2);
  assert.equal(duel.standings[1].questionsAnswered, 1);
});
