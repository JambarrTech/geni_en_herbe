/**
 * Tests du masquage des scores (`sumEventsUpTo`, `isScoreHidden`).
 *
 * Pendant le match, l'écran public ne montre JAMAIS les totaux en direct :
 * seuls les points diffusés par le jury (ou l'admin) y figurent. Ces deux
 * fonctions portent cette règle — un défaut ici afficherait des points non
 * diffusés devant la salle, ou masquerait un score que le jury vient
 * d'approuver.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sumEventsUpTo, isScoreHidden } from '../src/server/matchEngine.ts';

const TEAM_A = 1;
const TEAM_B = 2;

function ev(id, teamId, points) {
  return { id, teamId, points };
}

test('somme approuvée : seuls les événements jusqu’au marqueur comptent', () => {
  const { scoreA, scoreB } = sumEventsUpTo(
    [ev(1, TEAM_A, 10), ev(2, TEAM_B, 20), ev(3, TEAM_A, 10)],
    2,
    TEAM_A,
    TEAM_B
  );
  assert.equal(scoreA, 10);
  assert.equal(scoreB, 20);
});

test('marqueur nul : aucun événement ne compte', () => {
  const { scoreA, scoreB } = sumEventsUpTo([ev(1, TEAM_A, 10)], null, TEAM_A, TEAM_B);
  assert.equal(scoreA, 0);
  assert.equal(scoreB, 0);
});

test('plancher à zéro comme le recalcul officiel (pénalités)', () => {
  const { scoreA } = sumEventsUpTo([ev(1, TEAM_A, 10), ev(2, TEAM_A, -30)], 2, TEAM_A, TEAM_B);
  assert.equal(scoreA, 0);
});

test('les événements d’équipes inconnues sont ignorés', () => {
  const { scoreA, scoreB } = sumEventsUpTo([ev(1, 999, 50)], null, TEAM_A, TEAM_B);
  assert.equal(scoreA, 0);
  assert.equal(scoreB, 0);
});

test('match terminé : jamais masqué, même sans diffusion', () => {
  assert.equal(isScoreHidden('FINISHED', [1, 2], null), false);
  assert.equal(isScoreHidden('FINISHED', [1, 2], 1), false);
});

test('aucun point attribué : 0-0 affiché, rien à cacher', () => {
  assert.equal(isScoreHidden('LIVE', [], null), false);
  assert.equal(isScoreHidden('PAUSED', [], null), false);
});

test('points attribués mais rien diffusé : masqué', () => {
  assert.equal(isScoreHidden('LIVE', [1], null), true);
  assert.equal(isScoreHidden('PAUSED', [1, 2], null), true);
});

test('tout est diffusé : affiché', () => {
  assert.equal(isScoreHidden('LIVE', [1, 2], 2), false);
});

test('un seul point postérieur au marqueur : masqué à nouveau', () => {
  assert.equal(isScoreHidden('LIVE', [1, 2, 3], 2), true);
});

test('marqueur au-delà du dernier événement : affiché', () => {
  assert.equal(isScoreHidden('LIVE', [1, 2], 99), false);
});
