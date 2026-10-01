/**
 * Tests des regles de mise en forme des matchs.
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * `winnerTeamIdOf` repond a la question la plus lourde de consequence de la
 * plateforme : « qui a gagne ? ». Le classement et les statistiques d'equipe
 * en derivent. Une erreur de comparaison y inverserait un classement sans
 * qu'aucun autre test ne s'en apercoive, et le defaut ne se verrait qu'a la
 * remise des prix.
 *
 * Le point le plus delicat est l'EGALITE : elle doit valoir `null`, jamais un
 * identifiant d'equipe. Un `null` confondu avec l'equipe A donnerait une
 * victoire de plus a A et une defaite de plus a B.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { winnerTeamIdOf, parseOptions, buildMatchList } from '../src/lib/matchList.ts';

describe('winnerTeamIdOf', () => {
  const teamAId = 10;
  const teamBId = 20;

  test("equipe A devant -> equipe A", () => {
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: 30, scoreB: 10 }), teamAId);
  });

  test("equipe B devant -> equipe B", () => {
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: 10, scoreB: 30 }), teamBId);
  });

  test("egalite -> null, jamais un identifiant d'equipe", () => {
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: 20, scoreB: 20 }), null);
  });

  test("0-0 est une egalite, pas un match gagne par A", () => {
    // Cas limite : un score nul ne doit pas etre confondu avec « pas de
    // donnees ». Sur un match non commence, les deux scores valent 0.
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: 0, scoreB: 0 }), null);
  });

  test("une penalite peut rendre un score negatif", () => {
    // -5 contre 0 : l'equipe B gagne. Une comparaison ecrite avec
    // `scoreA >= scoreB` aurait declare A vainqueur.
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: -5, scoreB: 0 }), teamBId);
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: 0, scoreB: -5 }), teamAId);
  });

  test("une difference d'un seul point suffit a designer un vainqueur", () => {
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: 11, scoreB: 10 }), teamAId);
    assert.equal(winnerTeamIdOf({ teamAId, teamBId, scoreA: 10, scoreB: 11 }), teamBId);
  });
});

describe('parseOptions', () => {
  test('null / undefined / chaine vide -> null', () => {
    assert.equal(parseOptions(null), null);
    assert.equal(parseOptions(undefined), null);
    assert.equal(parseOptions(''), null);
  });

  test('tableau JSON -> tableau', () => {
    assert.deepEqual(parseOptions('["Paris","Dakar"]'), ['Paris', 'Dakar']);
  });

  test('tableau vide -> tableau vide, pas null', () => {
    // La distinction compte : `[]` est une question a choix repondus mais
    // aucun, `null` est une question ouverte.
    assert.deepEqual(parseOptions('[]'), []);
  });

  test('JSON invalide -> null, sans lever', () => {
    // Un seul enregistrement corrompu ne doit pas faire echouer tout l'ecran
    // jury : la question reste jouable sans ses options.
    assert.doesNotThrow(() => parseOptions('{ceci nest pas du json'));
    assert.equal(parseOptions('{ceci nest pas du json'), null);
  });

  test('JSON valide mais pas un tableau -> null', () => {
    // `{"a":1}` parse sans erreur mais serait ensuite parcouru comme une
    // liste : on ne renvoie que des tableaux.
    assert.equal(parseOptions('{"a":1}'), null);
    assert.equal(parseOptions('"une chaine"'), null);
    assert.equal(parseOptions('42'), null);
    assert.equal(parseOptions('null'), null);
  });

  test('un objet imbrique dans le tableau est conserve tel quel', () => {
    // Les options sont ecrites par le client : on ne valide pas leur forme en
    // profondeur ici, on garantit seulement le type enveloppe.
    assert.deepEqual(parseOptions('[{"id":1}]'), [{ id: 1 }]);
  });
});

describe('buildMatchList', () => {
  const teams = [
    { id: 10, eventId: 1, name: 'Lions', code: 'LIO', logo: null, status: 'ACTIVE' },
    { id: 20, eventId: 1, name: 'Aigles', code: 'AIG', logo: 'a.png', status: 'ACTIVE' },
  ];
  const users = [
    { id: 7, name: 'Fatou' },
    { id: 8, name: 'Moussa' },
  ];

  const rows = [
    { id: 1, eventId: 1, teamAId: 10, teamBId: 20, juryId: 7, scoreA: 30, scoreB: 10 },
  ];

  test('joint les equipes et le nom du jury', () => {
    const [match] = buildMatchList(rows, teams, users);
    assert.equal(match.teamA?.name, 'Lions');
    assert.equal(match.teamB?.name, 'Aigles');
    assert.equal(match.juryName, 'Fatou');
    assert.equal(match.winnerTeamId, 10);
  });

  test('conserve les colonnes projetees telles quelles', () => {
    const [match] = buildMatchList(rows, teams, users);
    assert.equal(match.id, 1);
    assert.equal(match.scoreA, 30);
    assert.equal(match.eventId, 1);
  });

  test('une equipe absente devient null, pas undefined', () => {
    // `undefined` disparait de la serialisation JSON : le client ne peut alors
    // pas distinguer « pas d'equipe » de « champ oublie ».
    const [match] = buildMatchList(rows, [teams[0]], users);
    assert.equal(match.teamB, null);
    assert.ok(Object.prototype.hasOwnProperty.call(match, 'teamB'));
    assert.equal(JSON.parse(JSON.stringify(match)).teamB, null);
  });

  test('un match sans jury -> juryName null', () => {
    const [match] = buildMatchList([{ ...rows[0], juryId: null }], teams, users);
    assert.equal(match.juryName, null);
  });

  test('un juryId orphelin -> juryName null, sans lever', () => {
    const [match] = buildMatchList([{ ...rows[0], juryId: 999 }], teams, users);
    assert.equal(match.juryName, null);
  });

  test('une liste vide -> liste vide', () => {
    assert.deepEqual(buildMatchList([], teams, users), []);
  });

  test("un match nul -> winnerTeamId null dans la liste", () => {
    const [match] = buildMatchList([{ ...rows[0], scoreA: 15, scoreB: 15 }], teams, users);
    assert.equal(match.winnerTeamId, null);
  });

  test("ne mute pas les lignes d'entree", () => {
    const input = rows.map((r) => ({ ...r }));
    const snapshot = JSON.stringify(input);
    buildMatchList(input, teams, users);
    assert.equal(JSON.stringify(input), snapshot);
  });

  test('traite plusieurs matchs independamment', () => {
    const list = buildMatchList(
      [
        { id: 1, eventId: 1, teamAId: 10, teamBId: 20, juryId: 7, scoreA: 5, scoreB: 50 },
        { id: 2, eventId: 1, teamAId: 20, teamBId: 10, juryId: 8, scoreA: 5, scoreB: 5 },
      ],
      teams,
      users
    );
    assert.equal(list[0].winnerTeamId, 20);
    assert.equal(list[1].winnerTeamId, null);
    assert.equal(list[1].juryName, 'Moussa');
  });
});
