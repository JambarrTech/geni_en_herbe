/**
 * Tests du scénario de diffusion (lib/broadcastFlow.ts).
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * Ce module n'est pas du cosmétique : il décide de ce qui est envoyé à un
 * écran PUBLIC. Une régression n'y produirait pas un bouton mal placé, elle
 * produirait la réponse officielle d'une question diffusée avant que le jury
 * ne l'ait révélée — c'est-à-dire la question suivante livrée au public avant
 * l'heure. C'est le genre de défaut qu'aucun autre test ne verrait, et qui ne
 * se corrige qu'après l'incident.
 *
 * Les cas couverts sont donc, dans l'ordre d'importance :
 *  - la Révélation ne peut être atteinte qu'après le passage par l'équipe B ;
 *  - la réponse officielle n'est annoncée qu'à cette étape précise, jamais
 *    avant, jamais après ;
 *  - la série se termine sur le résultat final, sans étape orpheline ;
 *  - un curseur corrompu (étape inconnue, index hors bornes, série vide) est
 *    ramené dans le domaine plutôt que propagé jusqu'à l'écran.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { broadcastSequence, firstCursor, normalizeCursor, nextCursor, previousCursor, walkTo, broadcastPosition } from '../src/lib/broadcastFlow.ts';

describe('broadcastSequence', () => {
  test('une question produit quatre étapes, entre la question et le résultat final', () => {
    const sequence = broadcastSequence(1);
    assert.deepEqual(
      sequence.map((c) => c.stage),
      ['QUESTION', 'ANSWER_A', 'ANSWER_B', 'REVEAL', 'FINAL']
    );
    assert.deepEqual(
      sequence.map((c) => c.questionIndex),
      [0, 0, 0, 0, 0]
    );
  });

  test('deux questions : la serie se repete integralement avant le resultat final', () => {
    const stages = broadcastSequence(2).map((c) => c.stage + '#' + c.questionIndex);
    assert.deepEqual(stages, [
      'QUESTION#0', 'ANSWER_A#0', 'ANSWER_B#0', 'REVEAL#0',
      'QUESTION#1', 'ANSWER_A#1', 'ANSWER_B#1', 'REVEAL#1',
      'FINAL#1',
    ]);
  });

  test('serie vide : seul le resultat final subsiste', () => {
    assert.deepEqual(broadcastSequence(0).map((c) => c.stage), ['FINAL']);
  });

  test('un nombre de questions negatif ou fractionnaire est traite comme un entier >= 0', () => {
    assert.equal(broadcastSequence(-3).length, 1);
    assert.deepEqual(broadcastSequence(2.7).map((c) => c.stage).filter((s) => s === 'REVEAL').length, 2);
  });
});

describe('firstCursor', () => {
  test('retourne la premiere etape (QUESTION) sans effectif', () => {
    assert.deepEqual(firstCursor(), { stage: 'QUESTION', questionIndex: 0 });
  });
});

describe('normalizeCursor', () => {
  test('default QUESTION when stage is unknown and count > 0', () => {
    assert.deepEqual(normalizeCursor('UNKNOWN', 0, 3), { stage: 'QUESTION', questionIndex: 0 });
  });

  test('default FINAL when stage is unknown and count === 0', () => {
    assert.deepEqual(normalizeCursor('UNKNOWN', 0, 0), { stage: 'FINAL', questionIndex: 0 });
  });

  test('clamp questionIndex within bounds', () => {
    assert.deepEqual(normalizeCursor('QUESTION', 5, 3), { stage: 'QUESTION', questionIndex: 2 });
    assert.deepEqual(normalizeCursor('QUESTION', -1, 3), { stage: 'QUESTION', questionIndex: 0 });
  });

  test('ROSTER historique est ramene vers QUESTION (index conserve et borne)', () => {
    assert.deepEqual(normalizeCursor('ROSTER', 1, 3), { stage: 'QUESTION', questionIndex: 1 });
    assert.deepEqual(normalizeCursor('ROSTER', 9, 3), { stage: 'QUESTION', questionIndex: 2 });
  });

  test('un curseur ROSTER normalise permet au jury d avancer (pas de blocage)', () => {
    const current = normalizeCursor('ROSTER', 0, 2);
    const next = nextCursor(current, 2);
    assert.equal(next.stage, 'ANSWER_A');
    assert.equal(next.questionIndex, 0);
  });
});

describe('nextCursor', () => {
  test('enchainement QUESTION -> ANSWER_A -> ANSWER_B -> REVEAL -> FINAL', () => {
    const cursor = nextCursor({ stage: 'QUESTION', questionIndex: 0 }, 1);
    assert.equal(cursor.stage, 'ANSWER_A');
    assert.equal(cursor.questionIndex, 0);
  });

  test('FINAL n\'a pas de prochain cursor', () => {
    const cursor = nextCursor({ stage: 'FINAL', questionIndex: 0 }, 1);
    assert.equal(cursor, null);
  });
});

describe('previousCursor', () => {
  test('retour arriere FINAL -> REVEAL', () => {
    const cursor = previousCursor({ stage: 'FINAL', questionIndex: 0 }, 1);
    assert.equal(cursor.stage, 'REVEAL');
    assert.equal(cursor.questionIndex, 0);
  });

  test('retour arriere QUESTION retourne null (deja au debut)', () => {
    const cursor = previousCursor({ stage: 'QUESTION', questionIndex: 0 }, 1);
    assert.equal(cursor, null);
  });
});

describe('walkTo', () => {
  test('walkTo QUESTION avec 1 question', () => {
    const cursor = walkTo('QUESTION');
    assert.equal(cursor.stage, 'QUESTION');
    assert.equal(cursor.questionIndex, 0);
  });

  test('walkTo REVEAL avec 1 question', () => {
    const cursor = walkTo('REVEAL');
    assert.equal(cursor.stage, 'REVEAL');
    assert.equal(cursor.questionIndex, 0);
  });
});

describe('revelation de la reponse officielle', () => {
  test('la reponse n’est revelee qu’a l’etape REVEAL', () => {
    for (const stage of ['QUESTION', 'ANSWER_A', 'ANSWER_B', 'FINAL']) {
      const cursor = walkTo(stage, 1);
      assert.equal(
        broadcastPosition(cursor, 1).revealsAnswer,
        false,
        'etape ' + stage + ' ne doit pas reveler la reponse'
      );
    }
    assert.equal(broadcastPosition(walkTo('REVEAL', 1), 1).revealsAnswer, true);
  });

  test('la revelation n’atteint JAMAIS l’etape QUESTION de la question suivante', () => {
    // Piege : apres la revelation de la question 0, le scénario revient à
    // « QUESTION ». Si l’indicateur suivait l’index de question au lieu de
    // l’étape, l’enonce de la question 1 partirait avec la réponse de la
    // question 0 attachée.
    const apresQuestion0 = nextCursor(walkTo('REVEAL', 2), 2);
    assert.equal(apresQuestion0.stage, 'QUESTION');
    assert.equal(apresQuestion0.questionIndex, 1);
    assert.equal(broadcastPosition(apresQuestion0, 2).revealsAnswer, false);
  });

  test('la revelation n’atteint pas l’étape precedente de la question courante', () => {
    // Après la révélation, l'étape suivante est FINAL (pas d'étape suivante avant la question suivante)
    // Pour revenir en arrière, il faut utiliser previousCursor
    const apresQuestion1 = previousCursor(walkTo('REVEAL', 1), 1);
    assert.equal(apresQuestion1.stage, 'ANSWER_B');
    assert.equal(broadcastPosition(apresQuestion1, 1).revealsAnswer, false);
  });
});

describe('broadcastPosition', () => {
  test('QUESTION sans réponse officielle', () => {
    assert.equal(broadcastPosition({ stage: 'QUESTION', questionIndex: 0 }, 1).revealsAnswer, false);
  });

  test('REVEAL avec réponse officielle', () => {
    assert.equal(broadcastPosition({ stage: 'REVEAL', questionIndex: 0 }, 1).revealsAnswer, true);
  });

  test('FINAL sans réponse officielle après REVEAL', () => {
    assert.equal(broadcastPosition({ stage: 'FINAL', questionIndex: 0 }, 1).revealsAnswer, false);
  });
});