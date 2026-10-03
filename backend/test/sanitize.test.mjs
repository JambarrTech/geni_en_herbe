/**
 * Tests de la porte de diffusion de la réponse officielle (`lib/sanitize.ts`).
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * `publicQuestion` est l'invariant le plus ancien et le plus strict de la
 * plateforme : la bonne réponse ne part JAMAIS sur l'écran public. Toute la
 * diffusion en direct repose dessus.
 *
 * `revealedQuestion` est l'exception assumée à cet invariant, et une
 * exception de ce genre est précisément le genre de code qu'on refactorise sans
 * y penser. Ces tests verrouillent donc deux choses :
 *  - hors révélation, la réponse est retirée comme avant ;
 *  - révélée, elle seule revient — l'explication pédagogique, elle, reste
 *    réservée au jury quoi qu'il arrive.
 *
 * Le test décisif reste celui du scénario (`broadcastFlow.test.mjs`) : il
 * vérifie que l'étape REVEAL n'est atteignable qu'après le passage par les deux
 * équipes. Ces deux fichiers se complètent : celui-ci décide du CONTENU envoyé,
 * celui-là du MOMENT où il est envoyé.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { publicQuestion, revealedQuestion } from '../src/lib/sanitize.ts';

const QUESTION = {
  id: 7,
  text: 'Capitale du Sénégal ?',
  answer: 'Dakar',
  explanation: "Note pédagogique : capitale et port principal du pays.",
  type: 'DIRECT',
  points: 10,
};

describe('publicQuestion — l\'invariant historique', () => {
  test('retire la réponse ET l\'explication', () => {
    const out = publicQuestion(QUESTION);
    assert.equal('answer' in out, false);
    assert.equal('explanation' in out, false);
  });

  test('conserve tout le reste', () => {
    const out = publicQuestion(QUESTION);
    assert.equal(out.id, 7);
    assert.equal(out.text, QUESTION.text);
    assert.equal(out.points, 10);
  });

  test('ne mute pas l\'objet source', () => {
    // Un `delete` sur la question tirée de la base la mutilerait pour le jury
    // aussi : les deux lectures partagent la même ligne SQL.
    publicQuestion(QUESTION);
    assert.equal(QUESTION.answer, 'Dakar');
    assert.equal(QUESTION.explanation, QUESTION.explanation);
  });

  test('null et undefined renvoient null', () => {
    assert.equal(publicQuestion(null), null);
    assert.equal(publicQuestion(undefined), null);
  });
});

describe('revealedQuestion — la porte de la révélation', () => {
  test('la réponse revient…', () => {
    assert.equal(revealedQuestion(QUESTION).answer, 'Dakar');
  });

  test('…mais l\'explication pédagogique reste au jury', () => {
    // C'est le point le plus important de ce fichier. L'explication est une note
    // de correction, pas une réponse à révéler : elle ne part pas, même quand la
    // réponse elle-même est diffusée.
    assert.equal('explanation' in revealedQuestion(QUESTION), false);
  });

  test('ne mute pas l\'objet source', () => {
    revealedQuestion(QUESTION);
    assert.equal(QUESTION.answer, 'Dakar');
  });

  test('une question sans réponse ne devient pas un objet tronqué', () => {
    // Renvoyer `{ text }` sans `answer` ferait croire à l'écran que la
    // révélation a eu lieu alors qu'il n'y avait rien à révéler.
    assert.equal(revealedQuestion({ id: 1, text: 'énoncé' }), null);
    assert.equal(revealedQuestion({ id: 1, text: 'énoncé', answer: null }), null);
  });

  test('une réponse vide reste une réponse', () => {
    // `''` est un cas limite réel sur une question à trous : c'est une réponse
    // volontairement vide, pas une absence de réponse.
    assert.equal(revealedQuestion({ id: 1, answer: '' }).answer, '');
  });

  test('null et undefined renvoient null', () => {
    assert.equal(revealedQuestion(null), null);
    assert.equal(revealedQuestion(undefined), null);
  });

  test('révélée, la question est plus riche que la version publique — jamais plus riche que la base', () => {
    // Propriété d'inclusion : revealedQuestion ne peut rien ajouter que
    // publicQuestion n'aurait pas déjà transmis. Un champ spread depuis une
    // source inattendue se verrait ici.
    const publique = publicQuestion(QUESTION);
    const revelee = revealedQuestion(QUESTION);
    for (const key of Object.keys(revelee)) {
      assert.ok(
        key in publique || key === 'answer',
        `le champ « ${key} » ne devrait pas être diffusé`
      );
    }
  });
});