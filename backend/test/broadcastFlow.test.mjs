/**
 * Tests du scénario de diffusion (`lib/broadcastFlow.ts`).
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
 *  - la RÉVÉLATION ne peut être atteinte qu'après le passage par l'équipe B ;
 *  - la réponse officielle n'est annoncée qu'à cette étape précise, jamais
 *    avant, jamais après ;
 *  - la série se termine sur le résultat final, sans étape orpheline ;
 *  - un curseur corrompu (étape inconnue, index hors bornes, série vide) est
 *    ramené dans le domaine plutôt que propagé jusqu'à l'écran.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BROADCAST_STAGE,
  broadcastPosition,
  broadcastSequence,
  firstCursor,
  isBroadcastStage,
  nextCursor,
  normalizeCursor,
  previousCursor,
  stageIsPerMatch,
  stageIsPerQuestion,
  timerUpdateForStep,
} from '../src/lib/broadcastFlow.ts';

/** Avance le scénario jusqu'à la première occurrence d'une étape. */
function walkTo(stage, questionCount, questionIndex = 0) {
  let cursor = firstCursor();
  for (let guard = 0; guard < 1000; guard += 1) {
    if (cursor.stage === stage && cursor.questionIndex === questionIndex) return cursor;
    const next = nextCursor(cursor, questionCount);
    if (!next) return cursor;
    cursor = next;
  }
  throw new Error('parcours infini');
}

describe('broadcastSequence', () => {
  test('une question produit quatre etapes, entre l’effectif et le resultat final', () => {
    const sequence = broadcastSequence(1);
    assert.deepEqual(
      sequence.map((c) => c.stage),
      ['ROSTER', 'QUESTION', 'ANSWER_A', 'ANSWER_B', 'REVEAL', 'FINAL']
    );
    assert.deepEqual(
      sequence.map((c) => c.questionIndex),
      [0, 0, 0, 0, 0, 0]
    );
  });

  test('deux questions : la serie se repete integralement avant le resultat final', () => {
    const stages = broadcastSequence(2).map((c) => `${c.stage}#${c.questionIndex}`);
    assert.deepEqual(stages, [
      'ROSTER#0',
      'QUESTION#0', 'ANSWER_A#0', 'ANSWER_B#0', 'REVEAL#0',
      'QUESTION#1', 'ANSWER_A#1', 'ANSWER_B#1', 'REVEAL#1',
      'FINAL#1',
    ]);
  });

  test('serie vide : seules l’effectif et le resultat final subsistent', () => {
    assert.deepEqual(broadcastSequence(0).map((c) => c.stage), ['ROSTER', 'FINAL']);
  });

  test('un nombre de questions negatif ou fractionnaire est traite comme un entier >= 0', () => {
    assert.equal(broadcastSequence(-3).length, 2);
    assert.deepEqual(broadcastSequence(2.7).map((c) => c.stage).filter((s) => s === 'REVEAL').length, 2);
  });
});

describe('revealation de la reponse officielle', () => {
  test('la reponse n’est revelee qu’a l’etape REVEAL', () => {
    for (const stage of ['ROSTER', 'QUESTION', 'ANSWER_A', 'ANSWER_B', 'FINAL']) {
      const cursor = walkTo(stage, 1);
      assert.equal(
        broadcastPosition(cursor, 1).revealsAnswer,
        false,
        `l'etape ${stage} ne doit pas reveler la reponse`
      );
    }
    assert.equal(broadcastPosition(walkTo('REVEAL', 1), 1).revealsAnswer, true);
  });

  test('la revelation n’atteint JAMAIS l’etape QUESTION de la question suivante', () => {
    // Piege : apres la revelation de la question 0, le scenario revient a
    // « QUESTION ». Si l’indicateur suivait l’index de question au lieu de
    // l’etape, l’enonce de la question 1 partirait avec la reponse de la
    // question 0 attachee.
    const apresQuestion0 = nextCursor(walkTo('REVEAL', 2), 2);
    assert.equal(apresQuestion0.stage, 'QUESTION');
    assert.equal(apresQuestion0.questionIndex, 1);
    assert.equal(broadcastPosition(apresQuestion0, 2).revealsAnswer, false);
  });

  test('chaque question a sa propre revelation, exactement une', () => {
    const revelations = broadcastSequence(4).filter((c) => c.stage === 'REVEAL');
    assert.equal(revelations.length, 4);
    assert.deepEqual(revelations.map((c) => c.questionIndex), [0, 1, 2, 3]);
  });

  test('l’effectif des equipes n’est montre qu’a l’etape ROSTER', () => {
    const sequence = broadcastSequence(3);
    assert.deepEqual(
      sequence.filter((c) => broadcastPosition(c, 3).showsRoster).map((c) => `${c.stage}#${c.questionIndex}`),
      ['ROSTER#0']
    );
  });
});

describe('enchainement des etapes', () => {
  test('la question ne peut etre revelee sans passer par les deux equipes', () => {
    const ordre = [];
    let cursor = firstCursor();
    for (let i = 0; i < 5; i += 1) {
      cursor = nextCursor(cursor, 1);
      ordre.push(cursor.stage);
    }
    assert.deepEqual(ordre, ['QUESTION', 'ANSWER_A', 'ANSWER_B', 'REVEAL', 'FINAL']);
  });

  test('avancer depuis la derniere revelation donne le resultat final, pas une question fantome', () => {
    const fin = nextCursor(walkTo('REVEAL', 1), 1);
    assert.equal(fin.stage, 'FINAL');
    assert.equal(nextCursor(fin, 1), null, 'rien ne suit le resultat final');
  });

  test('reculer depuis le resultat final revient a la derniere revelation', () => {
    const final = walkTo('FINAL', 2);
    const back = previousCursor(final, 2);
    assert.equal(back.stage, 'REVEAL');
    assert.equal(back.questionIndex, 1);
  });

  test('reculer depuis l’effectif ne fait rien', () => {
    assert.equal(previousCursor(firstCursor(), 3), null);
  });

  test('aller-retour : revenir en arriere puis avancer redonne exactement la meme position', () => {
    // Invariant de bout en bout. Sans lui, un aller simple de 4 etapes ferait
    // diverger le scenario de sa sequence de reference et le jury finirait par
    // broadcaster une etape qui n’existe pas.
    const depart = walkTo('REVEAL', 3, 1);
    let cursor = depart;
    for (let i = 0; i < 4; i += 1) cursor = nextCursor(cursor, 3);
    cursor = previousCursor(cursor, 3);
    cursor = previousCursor(cursor, 3);
    cursor = previousCursor(cursor, 3);
    cursor = previousCursor(cursor, 3);
    assert.deepEqual(cursor, depart);
  });

  test('le scenario se parcourt entierement sans trou ni boucle', () => {
    const count = 5;
    const total = broadcastSequence(count).length;
    let cursor = firstCursor();
    const visited = [];
    for (let i = 0; i < total; i += 1) {
      visited.push(`${cursor.stage}#${cursor.questionIndex}`);
      cursor = nextCursor(cursor, count);
    }
    assert.equal(cursor, null);
    assert.deepEqual(visited, broadcastSequence(count).map((c) => `${c.stage}#${c.questionIndex}`));
    assert.equal(new Set(visited).size, visited.length, 'aucune etape ne doit se repeter');
  });
});

describe('robustesse du curseur', () => {
  test('une etape inconnue est ramenee a l’effectif', () => {
    const cursor = normalizeCursor('PAS_UNE_ETAPE', 2, 4);
    assert.equal(cursor.stage, 'ROSTER');
    assert.equal(cursor.questionIndex, 2);
  });

  test('null / undefined / nombre sont traites comme une etape inconnue', () => {
    for (const bogus of [null, undefined, 42, {}, []]) {
      assert.equal(normalizeCursor(bogus, 0, 3).stage, 'ROSTER');
    }
  });

  test('un index hors bornes est ramene dans la serie', () => {
    assert.equal(normalizeCursor('QUESTION', 99, 3).questionIndex, 2);
    assert.equal(normalizeCursor('QUESTION', -7, 3).questionIndex, 0);
  });

  test('serie vide : une etape de question est ramenee a l’effectif', () => {
    // Sans ce cas, l'ecran resterait bloque sur une question qui n'existe pas,
    // et surtout revealsAnswer pourrait garder la valeur attendue pour rien.
    const cursor = normalizeCursor('REVEAL', 0, 0);
    assert.equal(cursor.stage, 'ROSTER');
    assert.equal(broadcastPosition(cursor, 0).revealsAnswer, false);
  });

  test('serie vide : l’etape finale reste accessible', () => {
    assert.equal(normalizeCursor('FINAL', 3, 0).stage, 'FINAL');
  });

  test('un curseur hors sequence ne fait pas avancer l’ecran', () => {
    // Atteignable seulement par une donnee corrompue, mais l'absence de garde
    // ferait ici un `sequence[-1 + 1]` silencieusement valide.
    const horsSequence = { stage: 'ANSWER_A', questionIndex: 42 };
    assert.equal(nextCursor(horsSequence, 3), null);
    assert.equal(previousCursor(horsSequence, 3), null);
    const position = broadcastPosition(horsSequence, 3);
    assert.equal(position.canAdvance, false);
    assert.equal(position.canRewind, false);
    assert.equal(position.cursor.stage, 'ROSTER');
  });

  test('normalizeCursor conserve une etape valide et son index', () => {
    assert.deepEqual(normalizeCursor('ANSWER_B', 1, 5), { stage: 'ANSWER_B', questionIndex: 1 });
  });
});

describe('isBroadcastStage', () => {
  test('reconnait les six etapes du scenario', () => {
    for (const stage of Object.values(BROADCAST_STAGE)) {
      assert.equal(isBroadcastStage(stage), true);
    }
  });

  test('refuse tout le reste', () => {
    for (const bogus of ['ROSTER ', 'roster', 'REVEAL\n', null, undefined, 1, {}]) {
      assert.equal(isBroadcastStage(bogus), false, `${JSON.stringify(bogus)} ne doit pas etre une etape`);
    }
  });
});

describe('repartition des etapes', () => {
  test('stageIsPerQuestion ne vaut que pour les etapes de question', () => {
    assert.equal(stageIsPerQuestion('ROSTER'), false);
    assert.equal(stageIsPerQuestion('FINAL'), false);
    for (const stage of ['QUESTION', 'ANSWER_A', 'ANSWER_B', 'REVEAL']) {
      assert.equal(stageIsPerQuestion(stage), true);
    }
  });

  test('les deux etapes hors serie sont exactement ROSTER et FINAL', () => {
    // `stageIsPerMatch` est le complement exact de `stageIsPerQuestion` sur les
    // six etapes : c'est ce qui permet a l'ecran jury de masquer le compteur de
    // question sans redouter d'en oublier une.
    for (const stage of Object.values(BROADCAST_STAGE)) {
      assert.equal(stageIsPerMatch(stage), !stageIsPerQuestion(stage), stage);
    }
  });
});

describe('broadcastPosition', () => {
  test('la premiere etape est numerotee 1 et n’est pas recuable', () => {
    const position = broadcastPosition(firstCursor(), 3);
    assert.equal(position.stepNumber, 1);
    assert.equal(position.totalSteps, 14); // ROSTER + 3x4 + FINAL
    assert.equal(position.canRewind, false);
    assert.equal(position.canAdvance, true);
  });

  test('la derniere etape est la derniere du compte et n’est pas avancable', () => {
    const final = walkTo('FINAL', 3);
    const position = broadcastPosition(final, 3);
    assert.equal(position.stepNumber, 14);
    assert.equal(position.totalSteps, 14);
    assert.equal(position.canAdvance, false);
    assert.equal(position.canRewind, true);
  });

  test('le compteur d’etape suit l’avancement', () => {
    const question0 = walkTo('QUESTION', 2);
    const question1 = walkTo('QUESTION', 2, 1);
    assert.equal(
      broadcastPosition(question1, 2).stepNumber - broadcastPosition(question0, 2).stepNumber,
      4
    );
  });
});
describe('timerUpdateForStep — le chrono suit le scenario, pas la machine', () => {
  const base = {
    previousSeconds: 60,
    previousDuration: 60,
  };

  test('ROSTER -> QUESTION arme le chrono meme quand l index ne change pas', () => {
    // LE CAS QUI A CAUSE LE DEFAUT.
    //
    // Le lancement ouvre sur ROSTER avec l'index 0 ; l'etape suivante est
    // QUESTION sur le MENE index 0. Donc `questionChanged` est false, et une
    // regle « on arme quand l index bouge » n'arme jamais a ce moment-la.
    //
    // Concretement, le chrono partait au lancement et continuait de tourner
    // pendant toute la presentation des equipes. Aucun test ne l'aurait vu : le
    // serveur ne leve rien, il renvoie un match parfaitement valide dont le
    // compteur est simplement trop bas. Et comme le decompte est autoritaire
    // cote serveur, la question 1 pouvait etre a zero avant d'etre lue.
    const update = timerUpdateForStep(
      {
        action: 'next',
        targetStage: BROADCAST_STAGE.QUESTION,
        questionChanged: false,
        neverPlayed: true,
        ...base,
      },
      60
    );

    assert.ok(update, 'le chrono doit etre arme a l entree de la question');
    assert.equal(update.timerIsRunning, true);
    // Recharge a la duree de la question, pas a la valeur decroissante en cours.
    assert.equal(update.timerSecondsLeft, 60);
    assert.equal(update.timerDuration, 60);
    assert.ok(update.timerStartedAt instanceof Date);
  });

  test('la duree de la question prime sur celle du match', () => {
    // Une question a 30 s dans un match arme a 60 s : c'est la question qui
    // commande, sinon le jury dispose de temps que personne ne lui a accorde.
    const update = timerUpdateForStep(
      {
        action: 'next',
        targetStage: BROADCAST_STAGE.QUESTION,
        questionChanged: false,
        neverPlayed: true,
        previousSeconds: 55,
        previousDuration: 60,
      },
      30
    );
    assert.equal(update.timerSecondsLeft, 30);
    assert.equal(update.timerDuration, 30);
  });

  test('changer de question arme le chrono de la nouvelle', () => {
    const update = timerUpdateForStep(
      {
        action: 'next',
        targetStage: BROADCAST_STAGE.QUESTION,
        questionChanged: true,
        neverPlayed: true,
        ...base,
      },
      45
    );
    assert.equal(update.timerIsRunning, true);
    assert.equal(update.timerSecondsLeft, 45);
  });

  test('les etapes de reponse et de revelation ne touchent PAS au chrono', () => {
    // C'est le contrat du scenario : entre l'enonce et la revelation, le chrono
    // appartient au jury. Le scenario ne doit ni le remettre a zero, ni l'arreter.
    for (const targetStage of [
      BROADCAST_STAGE.ANSWER_A,
      BROADCAST_STAGE.ANSWER_B,
      BROADCAST_STAGE.REVEAL,
      BROADCAST_STAGE.FINAL,
      BROADCAST_STAGE.ROSTER,
    ]) {
      const update = timerUpdateForStep(
        {
          action: 'next',
          targetStage,
          questionChanged: false,
          neverPlayed: true,
          ...base,
        },
        60
      );
      assert.equal(update, null, `${targetStage} ne doit rien ecrire sur le chrono`);
    }
  });

  test('reculer ne redemarre JAMAIS un chrono arrete a dessein', () => {
    // Le jury a arrete le chrono avant de publier une correction ; corriger un
    // cran de trop ne doit pas le faire repartir devant le public.
    const update = timerUpdateForStep(
      {
        action: 'previous',
        targetStage: BROADCAST_STAGE.QUESTION,
        questionChanged: false,
        neverPlayed: true,
        previousSeconds: 22,
        previousDuration: 60,
      },
      60
    );
    assert.equal(update, null, 'un recul sur la meme question ne touche a rien');
  });

  test('reculer sur une question jamais jouee FIGE le chrono', () => {
    // Le cas oppose a l armement : repartir serait faux, mais laisser tourner
    // sur une question que le jury vient d'abandonner serait pire. On fige.
    const update = timerUpdateForStep(
      {
        action: 'previous',
        targetStage: BROADCAST_STAGE.QUESTION,
        questionChanged: true,
        neverPlayed: true,
        previousSeconds: 22,
        previousDuration: 60,
      },
      60
    );
    assert.ok(update);
    assert.equal(update.timerIsRunning, false);
    assert.equal(update.timerStartedAt, null);
    // Le temps restant est conserve : le jury peut repartir d'ou il s'etait arrete.
    assert.equal(update.timerSecondsLeft, 22);
    assert.equal(update.timerDuration, 60);
  });

  test('une question deja jouee n est jamais remise au chrono', () => {
    // Revenir sur une question resolue pour corriger la diffusion ne doit pas la
    // rejouer : le public verrait le compteur repartir a zero sur une question
    // qui a deja ete notee.
    const update = timerUpdateForStep(
      {
        action: 'next',
        targetStage: BROADCAST_STAGE.QUESTION,
        questionChanged: true,
        neverPlayed: false,
        previousSeconds: 12,
        previousDuration: 60,
      },
      60
    );
    assert.ok(update);
    assert.equal(update.timerIsRunning, false);
    assert.equal(update.timerStartedAt, null);
    assert.equal(update.timerSecondsLeft, 12, 'le temps restant doit etre conserve');
  });

  test('restart ne remet pas le chrono a zero', () => {
    // Un retour a l effectif des equipes est une correction de mise en scene,
    // pas un re-decompte : le jury peut relancer l effectif apres avoir arrete
    // le chrono, et il s attend a le retrouver.
    const update = timerUpdateForStep(
      {
        action: 'restart',
        targetStage: BROADCAST_STAGE.ROSTER,
        questionChanged: true,
        neverPlayed: false,
        previousSeconds: 41,
        previousDuration: 60,
      },
      60
    );
    assert.ok(update);
    assert.equal(update.timerIsRunning, false);
    assert.equal(update.timerSecondsLeft, 41);
  });

  test('une serie deja resolue en entier ne peut pas redemarrer le chrono', () => {
    // Cas limite, mais celui du jury qui reprend un match deja joue : aucune
    // etape QUESTION ne doit remettre le compteur a zero.
    for (const neverPlayed of [false, true]) {
      const update = timerUpdateForStep(
        {
          action: 'next',
          targetStage: BROADCAST_STAGE.QUESTION,
          questionChanged: true,
          neverPlayed,
          previousSeconds: 0,
          previousDuration: 60,
        },
        60
      );
      if (neverPlayed) {
        assert.equal(update.timerIsRunning, true);
      } else {
        assert.equal(update.timerIsRunning, false);
      }
    }
  });

  test('chaque etape du scenario laisse le chrono intact sauf QUESTION', () => {
    // Propriete globale, ecrite sur la sequence ENTIERE : a aucun moment de la
    // diffusion le chrono ne peut s arreter ou repartir autrement qu'en entrant
    // sur l enonce d'une question. C'est ce qui garantit que le jury garde la
    // main pendant les reponses.
    //
    // Le parcours est strictement AVANT. Sur un parcours avant, chaque passage
    // sur QUESTION est une premiere venue : la question n'a pas pu etre notee
    // avant qu'on n'y arrive. `neverPlayed` vaut donc toujours vrai, et c'est
    // ce qui doit suffire a armer le chrono.
    const QUESTION_COUNT = 3;
    let cursor = firstCursor();
    let seconds = 60;

    for (let guard = 0; guard < 100; guard += 1) {
      const next = nextCursor(cursor, QUESTION_COUNT);
      if (!next) break;

      // Le jury baisse le chrono entre deux etapes : l'ecran suivant doit le
      // respecter tel quel.
      seconds -= 7;
      const update = timerUpdateForStep(
        {
          action: 'next',
          targetStage: next.stage,
          questionChanged: next.questionIndex !== cursor.questionIndex,
          neverPlayed: true,
          previousSeconds: seconds,
          previousDuration: 60,
        },
        60
      );

      if (next.stage === BROADCAST_STAGE.QUESTION) {
        assert.ok(update, 'QUESTION arme toujours le chrono');
        assert.equal(update.timerSecondsLeft, 60);
        // Le compteur repart de la duree de la question : sans cette
        // synchronisation, la simulation ci-dessous deriverait de la valeur
        // qu'elle a elle-meme posee, et le test passerait sur un chrono
        // parfaitement incoherent.
        seconds = update.timerSecondsLeft;
      } else {
        assert.equal(update, null, `${next.stage} ne touche pas au chrono`);
      }
      cursor = next;
    }
  });
});
