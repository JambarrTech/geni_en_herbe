/**
 * Reconnaissance de l'endpoint de base : directe ou pooler en mode transaction.
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * `pg_try_advisory_lock` est un verrou de SESSION : il tient tant que la
 * connexion PostgreSQL tient. Derriere un pooler en mode transaction
 * (PgBouncer, l'endpoint pooler de Neon, Supabase), les sessions serveur sont
 * reassignees d'un client a l'autre. Le verrou peut donc rester acquis a une
 * session qui ne sert plus personne, pendant que le worker se croit leader.
 *
 * Ce n'est pas une theorie : c'est exactement l'etat que le garde-fou de
 * `worker.ts` existe pour empecher, et il le fait en REFUSANT de demarrer.
 *
 * LE TROU QUE CES TESTS COUVRENT
 * ------------------------------
 * Le garde-fou ne reconnaisait le pooler que par OPTION D'URL (`pgbouncer=true`,
 * `pool_mode=transaction`). Or l'endpoint pooler de Neon est identifiable par son
 * NOM D'HOTE (`ep-xxx-pooler....`, `....pooler....`) et ne porte AUCUNE de ces
 * options — le tableau de bord propose la chaine poolee juste a cote de la
 * directe, sans le moindre signe distinctif dans l'URL.
 *
 * Concretement : un utilisateur collait l'URL du tableau de bord Neon, le
 * worker demarrait sans un mot, le verrou ne valait rien, et deux workers
 * pouvaient se croire leader. Le garde-fou laissait passer exactement le cas
 * qu'il etait ecrit pour arreter.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { estConnexionDirecte } from '../src/server/leaderLock.ts';

describe('connexion directe — doit passer', () => {
  test('hôte Neon direct', () => {
    assert.equal(
      estConnexionDirecte('postgresql://u:p@ep-abc-def.us-east-2.aws.neon.tech/aeerks?sslmode=require'),
      true
    );
  });

  test('hôte direct avec un mot sans rapport dans le nom', () => {
    // `pooler` doit être cherché DÉLIMITÉ dans l'hôte : un nom de base ou de
    // projet qui contiendrait ce mot ne doit pas faire refuser le worker.
    assert.equal(
      estConnexionDirecte('postgresql://u:p@db.poolerless.example.com/aeerks'),
      true
    );
  });

  test('localhost, le cas du développement', () => {
    assert.equal(estConnexionDirecte('postgresql://postgres@localhost:5432/aeerks'), true);
  });

  test('URL absente ou vide : rien à signaler', () => {
    // Sans `DATABASE_URL`, c'est la branche `SQL_HOST` qui s'applique, et elle
    // n'a pas de pooler. Refuser ici empêcherait le worker de démarrer sans
    // raison.
    assert.equal(estConnexionDirecte(''), true);
    assert.equal(estConnexionDirecte(undefined), true);
    assert.equal(estConnexionDirecte(null), true);
  });

  test('URL illisible : on ne bloque pas un démarrage légitime', () => {
    // Refuser ici produirait un échec bruyant pour un problème qui n'en est pas
    // un. La détection par options reste disponible sur une URL non analysable.
    assert.equal(estConnexionDirecte('pas-une-url'), true);
  });
});

describe('pooler en mode transaction — doit être refusé', () => {
  test('option pgbouncer=true', () => {
    assert.equal(
      estConnexionDirecte('postgresql://u:p@host/db?pgbouncer=true'),
      false
    );
  });

  test('option pool_mode=transaction', () => {
    assert.equal(
      estConnexionDirecte('postgresql://u:p@host/db?pool_mode=transaction'),
      false
    );
  });

  test('hôte Neon pooler, SANS option d\'URL — le cas qui passait', () => {
    // La forme moderne de l'endpoint pooler Neon. Aucune option ne la signale :
    // c'est le nom d'hôte seul qui la trahit.
    assert.equal(
      estConnexionDirecte('postgresql://u:p@ep-abc-def-pooler.us-east-2.aws.neon.tech/aeerks?sslmode=require'),
      false
    );
  });

  test('hôte pooler, forme ancienne', () => {
    assert.equal(
      estConnexionDirecte('postgresql://u:p@ep-abc-def.us-east-2.pooler.neon.tech/aeerks'),
      false
    );
  });

  test('hôte pooler sans aucun paramètre', () => {
    assert.equal(estConnexionDirecte('postgresql://u:p@db-pooler.internal/aeerks'), false);
  });

  test('la détection par option reste valable sur une URL non analysable', () => {
    // Une URL que `URL` refuse mais qui porte l'option : le garde-fou ne doit
    // pas s'en remettre uniquement au nom d'hôte.
    assert.equal(estConnexionDirecte('scheme-inconnu://hote/db?pgbouncer=true'), false);
  });
});