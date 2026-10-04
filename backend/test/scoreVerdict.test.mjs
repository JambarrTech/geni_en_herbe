/**
 * Tests du pilotage de l'écran public par le verdict du jury.
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * Noter n'est pas qu'écrire des points : c'est aussi dire à la salle ce
 * qu'elle regarde. Sans cette règle, chaque verdict demandait DEUX gestes du
 * jury (noter, puis avancer l'écran) — et tout oubli du second laissait le
 * public sur une prise de parole alors que la question était déjà tranchée,
 * ou sans la bonne réponse qu'il venait de voir attribuer.
 *
 * La règle est donc :
 *  - bonne réponse (points > 0) sur la question courante -> `REVEAL` : la
 *    réponse officielle part sur l'écran ;
 *  - « Faux » (0 pt ou moins) -> la parole passe à l'autre équipe si elle ne
 *    l'a pas eue (`ANSWER_A` -> `ANSWER_B`), sinon `REVEAL` (les deux ont
 *    échoué : la bonne réponse s'affiche dans les deux cas) ;
 *  - partout ailleurs (autre question, étape déjà révélée, bonus isolé...) :
 *    l'écran ne bouge pas.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoStageForVerdict } from '../src/lib/broadcastFlow.ts';

const verdict = (stage, points, isCurrentQuestion = true) =>
  autoStageForVerdict({ stage, points, isCurrentQuestion });

describe('autoStageForVerdict — la bonne réponse révèle', () => {
  test('bonne réponse équipe A à son tour : la réponse officielle part', () => {
    assert.equal(verdict('ANSWER_A', 10), 'REVEAL');
  });

  test('bonne réponse équipe B à son tour : la réponse officielle part', () => {
    assert.equal(verdict('ANSWER_B', 10), 'REVEAL');
  });

  test('bonne réponse dès l’énoncé (sans passer par la prise de parole)', () => {
    assert.equal(verdict('QUESTION', 20), 'REVEAL');
  });

  test('bonus et réplique suivent le même signe (pas d’exception par type)', () => {
    // La réplique (+10) EST la réponse de l’équipe B : elle révèle.
    assert.equal(verdict('ANSWER_B', 5), 'REVEAL');
  });
});

describe('autoStageForVerdict — la mauvaise réponse fait circuler la parole', () => {
  test('faux de l’équipe A : l’écran attend la réponse de l’équipe B', () => {
    assert.equal(verdict('ANSWER_A', 0), 'ANSWER_B');
  });

  test('faux dès l’énoncé : l’écran donne la parole à l’équipe B', () => {
    assert.equal(verdict('QUESTION', 0), 'ANSWER_B');
  });

  test('faux de l’équipe B : les deux ont échoué, la réponse s’affiche', () => {
    assert.equal(verdict('ANSWER_B', 0), 'REVEAL');
  });

  test('pénalité négative : même circulation qu’un faux', () => {
    assert.equal(verdict('ANSWER_A', -5), 'ANSWER_B');
    assert.equal(verdict('ANSWER_B', -5), 'REVEAL');
  });
});

describe('autoStageForVerdict — ce qui ne doit pas bouger l’écran', () => {
  test('correction d’une autre question : l’écran reste où il est', () => {
    assert.equal(verdict('ANSWER_A', 10, false), null);
    assert.equal(verdict('ANSWER_A', 0, false), null);
  });

  test('verdict tardif (déjà révélé, final) : on ne recule jamais l’écran', () => {
    for (const stage of ['REVEAL', 'FINAL', 'INCONNUE']) {
      assert.equal(verdict(stage, 10), null, `bonne à ${stage}`);
      assert.equal(verdict(stage, 0), null, `faux à ${stage}`);
    }
  });

  test('ligne ROSTER historique : jugée comme QUESTION (migration 0011)', () => {
    assert.equal(verdict('ROSTER', 10), 'REVEAL');
    assert.equal(verdict('ROSTER', 0), 'ANSWER_B');
  });
});

describe('route POST /:id/score — le verdict est persisté avec les points', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const sansCommentaires = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const corpsScore = (() => {
    const source = readFileSync(join(SRC, 'routes', 'matches.routes.ts'), 'utf8');
    const debut = source.indexOf("post('/:id/score'");
    assert.ok(debut !== -1, 'route POST /:id/score introuvable');
    const fin = source.indexOf('\n});', debut);
    return sansCommentaires(source.slice(debut, fin === -1 ? undefined : fin));
  })();

  test('la route décide de l’étape via autoStageForVerdict', () => {
    // Sans cet appel, la règle pure ci-dessus existerait mais personne ne
    // l’appliquerait : le jury noterait, et l’écran resterait figé.
    assert.ok(
      corpsScore.includes('autoStageForVerdict'),
      'POST /:id/score ne pilote plus l’écran : le verdict demande deux gestes'
    );
  });

  test('l’étape est écrite dans la même transaction que les scores', () => {
    // Séparer les deux écritures rouvrirait la désynchronisation que la
    // transaction était venue fermer (écran sur une prise de parole close).
    assert.ok(
      corpsScore.includes('broadcastStage: autoStage'),
      'POST /:id/score calcule l’étape sans la persister avec les points'
    );
  });
});
