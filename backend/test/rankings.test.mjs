/**
 * Tests du départage du classement.
 *
 * Cette logique décide du podium officiel affiché au public. Elle était
 * inline dans `calculateRankings` (donc intestable) et portait deux défauts :
 * un tri non déterministe en cas d'égalité parfaite, et des positions non
 * partagées entre équipes à égalité.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sortAndRankRankings } from '../src/server/matchEngine.ts';

/** Construit une entrée de classement minimale. */
function team(teamId, { totalScore, pointsDifference, wins }) {
  return {
    position: 0,
    teamId,
    teamName: `Equipe ${teamId}`,
    teamCode: `E${teamId}`,
    matchesPlayed: 3,
    wins,
    draws: 0,
    losses: 3 - wins,
    pointsScored: totalScore,
    pointsConceded: totalScore - pointsDifference,
    pointsDifference,
    totalScore,
  };
}

test('classe par totalScore décroissant', () => {
  const r = sortAndRankRankings([
    team(1, { totalScore: 10, pointsDifference: 2, wins: 1 }),
    team(2, { totalScore: 30, pointsDifference: 0, wins: 2 }),
    team(3, { totalScore: 20, pointsDifference: 5, wins: 1 }),
  ]);
  assert.deepEqual(
    r.map((x) => x.teamId),
    [2, 3, 1]
  );
  assert.deepEqual(
    r.map((x) => x.position),
    [1, 2, 3]
  );
});

test('départage à totalScore égal par la différence de points', () => {
  const r = sortAndRankRankings([
    team(1, { totalScore: 20, pointsDifference: -4, wins: 3 }),
    team(2, { totalScore: 20, pointsDifference: 6, wins: 1 }),
  ]);
  assert.deepEqual(
    r.map((x) => x.teamId),
    [2, 1]
  );
});

test('départage à égalité totale par les victoires', () => {
  const r = sortAndRankRankings([
    team(1, { totalScore: 20, pointsDifference: 0, wins: 1 }),
    team(2, { totalScore: 20, pointsDifference: 0, wins: 3 }),
  ]);
  assert.deepEqual(
    r.map((x) => x.teamId),
    [2, 1]
  );
});

test('égalité parfaite : positions partagées et rang suivant sauté (1, 1, 3)', () => {
  const r = sortAndRankRankings([
    team(1, { totalScore: 20, pointsDifference: 0, wins: 2 }),
    team(2, { totalScore: 20, pointsDifference: 0, wins: 2 }),
    team(3, { totalScore: 10, pointsDifference: 0, wins: 1 }),
  ]);
  assert.deepEqual(
    r.map((x) => x.position),
    [1, 1, 3],
    'les deux égalités doivent partager la 1re place, la 3e doit sauter le rang 2'
  );
});

test('le tri est déterministe quel que soit l\'ordre d\'entrée', () => {
  const build = () => [
    team(7, { totalScore: 20, pointsDifference: 0, wins: 2 }),
    team(3, { totalScore: 20, pointsDifference: 0, wins: 2 }),
    team(5, { totalScore: 20, pointsDifference: 0, wins: 2 }),
  ];

  const orderA = sortAndRankRankings(build()).map((x) => x.teamId);
  const orderB = sortAndRankRankings(build().reverse()).map((x) => x.teamId);
  const orderC = sortAndRankRankings([build()[2], build()[0], build()[1]]).map((x) => x.teamId);

  // Sans critère final stable, ces trois ordres pouvaient différer selon
  // l'ordre renvoyé par PostgreSQL : podium instable d'un rafraîchissement
  // à l'autre.
  assert.deepEqual(orderA, orderB, 'ordre inversé doit donner le même classement');
  assert.deepEqual(orderA, orderC, 'permutation doit donner le même classement');
  assert.deepEqual(orderA, [3, 5, 7], 'départage final par teamId croissant');
});

test('tableau vide ou à un élément', () => {
  assert.deepEqual(sortAndRankRankings([]), []);
  const one = sortAndRankRankings([team(42, { totalScore: 5, pointsDifference: 1, wins: 1 })]);
  assert.equal(one.length, 1);
  assert.equal(one[0].position, 1);
});

test('cinq équipes à égalité parfaite partagent toutes la première place', () => {
  const r = sortAndRankRankings([
    team(1, { totalScore: 10, pointsDifference: 0, wins: 1 }),
    team(2, { totalScore: 10, pointsDifference: 0, wins: 1 }),
    team(3, { totalScore: 10, pointsDifference: 0, wins: 1 }),
    team(4, { totalScore: 10, pointsDifference: 0, wins: 1 }),
    team(5, { totalScore: 10, pointsDifference: 0, wins: 1 }),
  ]);
  assert.deepEqual(
    r.map((x) => x.position),
    [1, 1, 1, 1, 1]
  );
  assert.deepEqual(
    r.map((x) => x.teamId),
    [1, 2, 3, 4, 5]
  );
});
