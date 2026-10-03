/**
 * Tests du diagnostic « base en retard sur le code ».
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * Une migration non appliquée est le seul défaut de livraison qui ne fasse RIEN
 * échouer à la construction ni au démarrage du service : la connexion à la base
 * passe, les tests passent, le process démarre. Il ne se révèle qu'à la première
 * requête qui cite la colonne manquante — donc pendant un concours, si le
 * calendrier est mal placé.
 *
 * Ces deux modules (`dbErrors` et le message de `schemaCheck`) sont la réponse à
 * cette fenêtre : un message qui nomme la cause et la commande, et une
 * vérification au boot qui la signale avant l'ouverture de la salle.
 *
 * Ils sont testés parce qu'ils sont le dernier rempart. Un message qui dirait
 * « erreur interne » resterait GREEN dans tous les tests du dépôt.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isMissingSchemaError, missingSchemaMessage } from '../src/lib/dbErrors.ts';
import { REQUIRED_COLUMNS, describeMissingColumns } from '../src/lib/schemaCheck.ts';

describe('isMissingSchemaError', () => {
  test('reconnait une colonne absente (42703)', () => {
    // C'est le code que PostgreSQL renvoie sur un `RETURNING` citant une colonne
    // que la base ne connaît pas — c'est-à-dire exactement le symptôme d'une
    // migration non appliquée.
    assert.equal(isMissingSchemaError({ code: '42703' }), true);
  });

  test('reconnait une table absente (42P01)', () => {
    // Une base vide ou une table jamais créée : même cause, même remède.
    assert.equal(isMissingSchemaError({ code: '42P01' }), true);
  });

  test('regarde aussi dans `cause`, comme le reste du fichier', () => {
    // pg encapsule parfois l'erreur : le code réel est un cran plus bas. Un
    // `cause` ignoré ferait manquer exactement le cas qu'on cherche à attraper.
    assert.equal(isMissingSchemaError({ cause: { code: '42703' } }), true);
    assert.equal(isMissingSchemaError({ code: 'ECONNREFUSED', cause: { code: '42703' } }), true);
  });

  test('ne confond pas avec les autres violations de contrainte', () => {
    // Le piège : 23505 (unicité) et 23503 (clé étrangère) sont aussi des
    // erreurs « base », mais des erreurs de DONNÉES. Les traiter comme un
    // problème de migration enverrait l'administrateur appliquer une migration
    // alors que le vrai sujet est un doublon à corriger.
    for (const code of ['23505', '23503', '23502', '22001', 'ECONNREFUSED', 'ETIMEDOUT']) {
      assert.equal(isMissingSchemaError({ code }), false, `${code} ne doit pas passer pour un schéma incomplet`);
    }
  });

  test('ne suppose rien d\'un objet sans code', () => {
    for (const err of [null, undefined, {}, new Error('boom'), 'chaîne']) {
      assert.equal(isMissingSchemaError(err), false);
    }
  });
});

describe('missingSchemaMessage', () => {
  test('nomme la commande à exécuter', () => {
    // Sans la commande, l'utilisateur transmit l'erreur à un collègue sans piste
    // pour agir. Le message est la moitié du correctif.
    assert.match(missingSchemaMessage(), /db:migrate/);
  });

  test('distingue le schéma d\'une erreur de saisie', () => {
    assert.match(missingSchemaMessage(), /migration/i);
    assert.match(missingSchemaMessage(), /Base de données non à jour/);
  });
});

describe('describeMissingColumns', () => {
  test('rien à signaler ne produit PAS de chaîne vide', () => {
    // `null` plutôt que « » : l'appelant teste la présence, et « aucune
    // anomalie » doit se lire dans le code. Une chaîne vide obligerait à
    // comparer, donc à rater le cas une fois sur deux.
    assert.equal(describeMissingColumns([]), null);
  });

  test('une colonne manquante est nommée, avec sa migration', () => {
    const message = describeMissingColumns([
      { table: 'matches', column: 'broadcast_stage', since: '0004_broadcast_stage' },
    ]);
    assert.ok(message);
    assert.match(message, /matches\.broadcast_stage/);
    // Le numéro de migration indique QUEL fichier appliquer, et non pas qu'il
    // faut chercher lequel.
    assert.match(message, /0004_broadcast_stage/);
  });

  test('accorde le pluriel', () => {
    assert.match(describeMissingColumns([{ table: 'a', column: 'b', since: '1' }]), /colonne manquante/);
    const deux = describeMissingColumns([
      { table: 'a', column: 'b', since: '1' },
      { table: 'c', column: 'd', since: '2' },
    ]);
    assert.match(deux, /2 colonnes manquantes/);
  });

  test('conserve la commande de correction dans tous les cas', () => {
    const cas = [
      [],
      [{ table: 'matches', column: 'broadcast_stage', since: '0004_broadcast_stage' }],
      [
        { table: 'a', column: 'b', since: '1' },
        { table: 'c', column: 'd', since: '2' },
      ],
    ];
    for (const manquant of cas) {
      if (manquant.length === 0) continue;
      assert.match(describeMissingColumns(manquant), /db:migrate/);
    }
  });
});

describe('REQUIRED_COLUMNS — l\'inventaire', () => {
  test('exige la colonne du scénario de diffusion', () => {
    // C'est l'entrée dont l'absence a rendu « Programmer un Match » inutilisable.
    // Elle doit rester listée tant que le code lit `matches.broadcast_stage`.
    const entree = REQUIRED_COLUMNS.find((c) => c.column === 'broadcast_stage');
    assert.ok(entree, 'matches.broadcast_stage doit figurer dans l\'inventaire');
    assert.equal(entree.table, 'matches');
    assert.equal(entree.since, '0004_broadcast_stage');
  });

  test('n\'a aucun doublon', () => {
    // Un doublon ne casse rien à l\'exécution, mais il signale un inventaire mal
    // tenu — et c\'est l\'inventaire qui doit être lu quand un schéma diverge.
    const cles = REQUIRED_COLUMNS.map((c) => `${c.table}.${c.column}`);
    assert.equal(new Set(cles).size, cles.length);
  });

  test('nomme la migration de chaque colonne', () => {
    // Sans ce champ, le diagnostic pourrait dire QUOI manque sans dire quoi
    // faire, et c\'est la moitié la plus longue du chemin de correction.
    for (const c of REQUIRED_COLUMNS) {
      assert.match(c.since, /^0\d\d\d_/, `${c.table}.${c.column} sans référence de migration`);
    }
  });
});
