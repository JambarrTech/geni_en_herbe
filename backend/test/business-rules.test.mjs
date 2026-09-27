/**
 * Tests des règles métier pures — le cœur du score d'une compétition.
 *
 * Ces fonctions were les plus risquées du backend et n'étaient couvertes par
 * aucun test. Les bugs corrigés pendant l'audit (première question sans chrono
 * propre, égalités de classement non déterministes, fuite de la réponse
 * officielle) vivaient exactement ici.
 *
 * Exécution : `npm test` (node --test, sans dépendance supplémentaire).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { publicQuestion } from '../src/lib/sanitize.ts';
import { hashPassword, verifyPassword } from '../src/lib/password.ts';
import { isForeignKeyViolation, FK_DELETE_MESSAGES } from '../src/lib/dbErrors.ts';
import { CONFIG, FLOW } from '../src/config.ts';

test('publicQuestion retire la réponse et l\'explication', () => {
  const q = {
    id: 1,
    text: 'Capitale du Sénégal ?',
    answer: 'Dakar',
    explanation: 'Indices géographiques',
    points: 10,
  };
  const pub = publicQuestion(q);
  assert.equal('answer' in pub, false, 'la réponse ne doit jamais sortir');
  assert.equal('explanation' in pub, false, "l'explication ne doit jamais sortir");
  assert.equal(pub.text, 'Capitale du Sénégal ?');
  assert.equal(pub.points, 10);
  // L'original ne doit pas être muté.
  assert.equal(q.answer, 'Dakar');
});

test('publicQuestion tolère null/undefined', () => {
  assert.equal(publicQuestion(null), null);
  assert.equal(publicQuestion(undefined), null);
});

// `hashPassword` et `verifyPassword` sont désormais ASYNCHRONES : scrypt
// s'exécute dans le pool de threads de libuv au lieu d'occuper l'event loop.
// Sans `await`, `stored` serait une Promise, et `stored.includes` leverait
// TypeError.
test('verifyPassword accepte le bon mot de passe et rejette les autres', async () => {
  const stored = await hashPassword('motdepasse-solide');
  assert.equal(await verifyPassword('motdepasse-solide', stored), true);
  assert.equal(
    await verifyPassword('motdepasse-solidE', stored),
    false,
    'sensible à la casse'
  );
  assert.equal(await verifyPassword('', stored), false);
});

test('hashPassword produit un sel distinct à chaque appel', async () => {
  const a = await hashPassword('meme-mot-de-passe');
  const b = await hashPassword('meme-mot-de-passe');
  assert.notEqual(a, b, 'deux hachages du même secret doivent différer (sel aléatoire)');
  assert.equal(await verifyPassword('meme-mot-de-passe', a), true);
  assert.equal(await verifyPassword('meme-mot-de-passe', b), true);
});

test('verifyPassword rejette une chaîne de stockage corrompue', async () => {
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', undefined), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'pas-de-separateur'), false);
  assert.equal(await verifyPassword('x', ':'), false);
});

test('les constantes métier restent cohérentes', () => {
  assert.ok(CONFIG.MIN_TIMER_SECONDS < CONFIG.DEFAULT_TIMER_SECONDS);
  assert.ok(CONFIG.DEFAULT_TIMER_SECONDS < CONFIG.MAX_TIMER_SECONDS);
  assert.ok(CONFIG.MIN_QUESTION_POINTS <= CONFIG.DEFAULT_QUESTION_POINTS);
  assert.ok(CONFIG.DEFAULT_QUESTION_POINTS <= CONFIG.MAX_QUESTION_POINTS);
  assert.ok(CONFIG.MIN_QUESTION_TIME_SECONDS <= CONFIG.DEFAULT_TIMER_SECONDS);
  // La protection anti-double-clic serveur doit rester >= celle du client,
  // sinon l'interface se déverrouille avant la fin de la protection.
  assert.ok(CONFIG.ANTI_DOUBLE_CLICK_MS >= 1500);
  assert.ok(CONFIG.WS_MAX_PAYLOAD_BYTES > 0);
});

test('les enums de statuts sont cohérents entre eux', () => {
  assert.ok(Object.values(FLOW.MATCH_STATUS).includes('LIVE'));
  assert.ok(Object.values(FLOW.MATCH_STATUS).includes('FINISHED'));
  assert.ok(Object.values(FLOW.QUESTION_STATUS).includes('ANSWERED'));
  assert.ok(Object.values(FLOW.SCORE_TYPE).includes('ADJUSTMENT'));
  assert.ok(Object.values(FLOW.EVENT_STATUS).includes('RESULTS_PUBLISHED'));
  assert.ok(Object.values(FLOW.TEAM_STATUS).includes('DISQUALIFIED'));
});

test('isForeignKeyViolation reconnaît les violations de clé étrangère', () => {
  assert.equal(isForeignKeyViolation({ code: '23503' }), true);
  assert.equal(isForeignKeyViolation({ cause: { code: '23503' } }), true, 'code imbriqué (cause)');
  assert.equal(isForeignKeyViolation({ code: '23505' }), false, 'violation unique != FK');
  assert.equal(isForeignKeyViolation(new Error('boom')), false);
  assert.equal(isForeignKeyViolation(null), false);
  assert.equal(isForeignKeyViolation(undefined), false);
});

test('chaque entité suppressible a un message d\'erreur lisible', () => {
  for (const key of Object.keys(FK_DELETE_MESSAGES)) {
    const msg = FK_DELETE_MESSAGES[key];
    assert.ok(msg, `message manquant pour ${key}`);
    assert.ok(msg.length > 10, `message trop court pour ${key}`);
  }
});
