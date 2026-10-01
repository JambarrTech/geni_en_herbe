/**
 * Tests du controle d'origine des connexions WebSocket.
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * Le canal temps reel transporte le score en cours et le chronometre. Le jeton
 * de session voyage dans la chaine de requete, et aucune verification d'origine
 * n'etait faite : tant que tout etait sur une meme origine, la CSP
 * (`connect-src 'self'`) suffisait. Des que l'interface part sur un CDN, cette
 * garantie disparait.
 *
 * Le test le plus important est donc le DERNIER de `checkWebSocketOrigin` :
 * avec une liste blanche renseignee, une origine absente doit etre REFUSEE. Une
 * liste blanche qui laisse passer « pas d'origine » n'est pas une liste blanche,
 * et c'est le defaut classique de ce genre de controle.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkWebSocketOrigin,
  parseAllowedOrigins,
} from '../src/lib/wsOrigin.ts';

const HOTE = 'api.aeerks.sn';

describe('parseAllowedOrigins', () => {
  test('une variable vide donne une liste vide', () => {
    for (const raw of [null, undefined, '', '   ']) {
      assert.deepEqual(parseAllowedOrigins(raw), []);
    }
  });

  test('accepte virgule, espace et point-virgule', () => {
    // Ces variables se saisissent a la main dans un tableau de bord, ou la
    // virgule est plus facile a taper qu'un separateur dedie.
    assert.deepEqual(parseAllowedOrigins('a.sn,b.sn'), ['a.sn', 'b.sn']);
    assert.deepEqual(parseAllowedOrigins('a.sn b.sn'), ['a.sn', 'b.sn']);
    assert.deepEqual(parseAllowedOrigins('a.sn;b.sn'), ['a.sn', 'b.sn']);
  });

  test('normalise casse et barres obliques finales', () => {
    assert.deepEqual(parseAllowedOrigins('HTTPS://A.SN/'), ['https://a.sn']);
  });

  test('ignore les entrees vides', () => {
    // Une ligne laissee vide par accident ne doit pas produire une origine
    // « vide » automatiquement autorisee.
    assert.deepEqual(parseAllowedOrigins('a.sn,,b.sn'), ['a.sn', 'b.sn']);
    assert.deepEqual(parseAllowedOrigins(' a.sn  ,  '), ['a.sn']);
  });
});

describe('checkWebSocketOrigin — liste vide (deploiement actuel)', () => {
  test('accepte la meme origine', () => {
    const d = checkWebSocketOrigin(`https://${HOTE}`, [], HOTE);
    assert.equal(d.allowed, true);
  });

  test('accepte un client sans en-tete Origin', () => {
    // Sondes de vivacite, tests, scripts serveur : ce ne sont pas des
    // navigateurs et ne peuvent pas usurper une origine.
    assert.equal(checkWebSocketOrigin(undefined, [], HOTE).allowed, true);
  });

  test('refuse une origine tierce', () => {
    const d = checkWebSocketOrigin('https://pirate.example', [], HOTE);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /WS_ALLOWED_ORIGINS/);
  });

  test("refuse une origine malformee plutot que de l'accepter", () => {
    const d = checkWebSocketOrigin('pas-une-url', [], HOTE);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /illisible/);
  });

  test("refuse quand l'hote de requete est inconnu", () => {
    // Sans `Host`, on ne peut pas etablir la meme origine : la prudence
    // s'impose, faute de quoi la comparaison ne pourrait que reussir.
    const d = checkWebSocketOrigin('https://a.sn', [], undefined);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /hôte de requête inconnu/);
  });

  test('le comportement par defaut ne change rien au deploiement existant', () => {
    // LaCSP protege deja le navigateur ; ce controle ne doit pas casser le
    // fonctionnement actuel quand WS_ALLOWED_ORIGINS n'est pas renseigne.
    assert.equal(checkWebSocketOrigin(`https://${HOTE}`, [], HOTE).allowed, true);
  });
});

describe('checkWebSocketOrigin — liste blanche explicite (CDN)', () => {
  const liste = ['https://geni_en_herbe.vercel.app'];

  test('accepte une origine de la liste', () => {
    assert.equal(checkWebSocketOrigin('https://geni_en_herbe.vercel.app', liste, HOTE).allowed, true);
  });

  test('accepte insensiblement a la casse et aux barres obliques', () => {
    // Un navigateur peut envoyer une origine normalisee, un script non.
    assert.equal(
      checkWebSocketOrigin('https://Geni_En_Herbe.Vercel.App/', liste, HOTE).allowed,
      true
    );
  });

  test("REFUSE une origine absente : c'est le defaut classique", () => {
    // Une liste blanche qui laisse passer « pas d'origine » n'est pas une
    // liste blanche : n'importe quel client non navigateur passe.
    const d = checkWebSocketOrigin(undefined, liste, HOTE);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /origine absente/);
  });

  test('refuse une origine qui ne figure pas dans la liste', () => {
    assert.equal(checkWebSocketOrigin('https://pirate.example', liste, HOTE).allowed, false);
  });

  test('refuse une sous-origine : pas de correspondance partielle', () => {
    // `https://geni_en_herbe.vercel.app.evil.sn` contient la liste comme
    // sous-chaine. Une comparaison par `includes` l'accepterait.
    const d = checkWebSocketOrigin('https://geni_en_herbe.vercel.app.evil.sn', liste, HOTE);
    assert.equal(d.allowed, false);
  });

  test('refuse le meme hote sur un autre port', () => {
    // `wss://api.aeerks.sn:8443` n'est pas `wss://api.aeerks.sn`.
    const d = checkWebSocketOrigin('https://api.aeerks.sn:8443', ['https://api.aeerks.sn'], HOTE);
    assert.equal(d.allowed, false);
  });

  test('refuse un en-tete Origin repete', () => {
    // Node expose l'en-tete en tableau s'il est repete. Choisir au hasard
    // reviendrait a valider sur la premiere ou la derniere valeur.
    const d = checkWebSocketOrigin(['https://a.sn', 'https://b.sn'], liste, HOTE);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /répétée/);
  });
});

describe("checkWebSocketOrigin — le jeton n'apparait jamais dans la decision", () => {
  test('la decision ne contient que des informations non sensibles', () => {
    // Ces objets partent dans les journaux : aucune ne doit pouvoir transporter
    // de credential. Le jeton est dans l'URL, pas dans l'origine, donc il ne
    // peut pas fuiter par ce chemin.
    const d = checkWebSocketOrigin('https://a.sn?token=SECRET', ['https://b.sn'], HOTE);
    assert.equal(d.allowed, false);
    assert.ok(!JSON.stringify(d).includes('SECRET'));
  });
});
