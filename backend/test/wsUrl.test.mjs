/**
 * Tests de la resolution de l'URL du canal temps reel.
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * L'URL du WebSocket decouvre le mode de fonctionnement de toute la diffusion
 * en direct. Une erreur ici n'est jamais visible par un message d'erreur : le
 * socket ne s'ouvre pas, le bandeau « connecte » reste absent, et l'ecran
 * continue d'afficher le dernier etat recu. Pendant un tournoi, cela ressemble
 * a un bug de rythme plutot qu'a une panne.
 *
 * Le cas le plus important est le PREMIER : sans `override`, la chaine produite
 * doit etre exactement celle d'avant le deploiement sur CDN. C'est la garantie
 * que l'auto-hebergement n'a pas change de comportement.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Le module est dans `shared/` (vécu par les trois apps), pas dans le backend :
// d'où le `../../`. Les tests de backend vivent sous `backend/test/`.
import { resolveWsUrl, wsOriginOf } from '../../shared/lib/wsUrl.ts';

const HTTPS = { host: 'geni_en_herbe.vercel.app', protocol: 'https:' };
const HTTP = { host: 'localhost:5173', protocol: 'http:' };

describe('resolveWsUrl — meme origine (comportement par defaut)', () => {
  test('produit wss://<hote>/ws sur une page https', () => {
    assert.equal(resolveWsUrl({ ...HTTPS, token: null }), 'wss://geni_en_herbe.vercel.app/ws');
  });

  test('produit ws://<hote>/ws sur une page http', () => {
    // Ecrire `wss:` en dur casserait le developpement : le navigateur refuse
    // un socket securise sur une page non securisee.
    assert.equal(resolveWsUrl({ ...HTTP, token: null }), 'ws://localhost:5173/ws');
  });

  test('ajoute le jeton en parametre de requete', () => {
    assert.equal(
      resolveWsUrl({ ...HTTPS, token: 'abc123' }),
      'wss://geni_en_herbe.vercel.app/ws?token=abc123'
    );
  });

  test("encode le jeton : un jeton contenant & ou = ne peut pas casser la requete", () => {
    const url = resolveWsUrl({ ...HTTPS, token: 'a&b=c' });
    assert.equal(url, 'wss://geni_en_herbe.vercel.app/ws?token=a%26b%3Dc');
    // Le seul parametre present doit rester `token`.
    const params = new URL(url).searchParams;
    assert.equal(params.get('token'), 'a&b=c');
    assert.equal([...params.keys()].length, 1);
  });

  test('un jeton vide est traite comme absent', () => {
    // `getStoredToken()` renvoie `null` ou une chaine ; un stockage corrompu
    // pourrait renvoyer `''`, qui ne doit pas produire `?token=`.
    assert.equal(resolveWsUrl({ ...HTTPS, token: '' }), 'wss://geni_en_herbe.vercel.app/ws');
  });

  test('un override vide revient a la meme origine', () => {
    const attendu = 'wss://geni_en_herbe.vercel.app/ws';
    for (const override of [undefined, '', '   ']) {
      assert.equal(resolveWsUrl({ ...HTTPS, token: null, override }), attendu);
    }
  });
});

describe('resolveWsUrl — origine distante (interface sur CDN)', () => {
  test('un override avec schema est respecte tel quel', () => {
    assert.equal(
      resolveWsUrl({ ...HTTPS, token: null, override: 'wss://api.aeerks.sn' }),
      'wss://api.aeerks.sn/ws'
    );
  });

  test('un override sans schema recoit celui de la page', () => {
    // C'est la forme la plus tapes a la main dans un tableau de bord
    // d'hebergeur : « api.aeerks.sn » sans prefixe.
    assert.equal(
      resolveWsUrl({ ...HTTPS, token: null, override: 'api.aeerks.sn' }),
      'wss://api.aeerks.sn/ws'
    );
    assert.equal(
      resolveWsUrl({ ...HTTP, token: null, override: 'api.aeerks.sn' }),
      'ws://api.aeerks.sn/ws'
    );
  });

  test('une barre oblique finale est retirees', () => {
    // `wss://api.aeerks.sn/` + `/ws` donnerait `wss://api.aeerks.sn//ws`.
    for (const override of ['wss://api.aeerks.sn/', 'wss://api.aeerks.sn//']) {
      assert.equal(resolveWsUrl({ ...HTTPS, token: null, override }), 'wss://api.aeerks.sn/ws');
    }
  });

  test('les espaces autour de la valeur sont ignores', () => {
    // Une valeur collee depuis un tableau de bord arrive souvent espaces.
    assert.equal(
      resolveWsUrl({ ...HTTPS, token: null, override: '  wss://api.aeerks.sn  ' }),
      'wss://api.aeerks.sn/ws'
    );
  });

  test('un port explicite est conserve', () => {
    assert.equal(
      resolveWsUrl({ ...HTTPS, token: null, override: 'wss://api.aeerks.sn:443' }),
      'wss://api.aeerks.sn:443/ws'
    );
  });

  test('le jeton est conserve avec un override', () => {
    assert.equal(
      resolveWsUrl({ ...HTTPS, token: 'tok', override: 'wss://api.aeerks.sn' }),
      'wss://api.aeerks.sn/ws?token=tok'
    );
  });

  test("un schema http: sur une page https reste tel quel (l'operateur decide)", () => {
    // On ne « corrige » pas une saisie : le developpeur peut vouloirement
    // pointer une instance locale non securisee derriere un tunnel.
    assert.equal(
      resolveWsUrl({ ...HTTPS, token: null, override: 'ws://localhost:4001' }),
      'ws://localhost:4001/ws'
    );
  });
});

describe('wsOriginOf', () => {
  test("extrait l'origine d'une URL de socket", () => {
    // Sert a renseigner WS_ALLOWED_ORIGINS sans avoir a deviner la mise en
    // forme de l'URL construite par resolveWsUrl.
    assert.equal(wsOriginOf('wss://api.aeerks.sn/ws?token=x'), 'wss://api.aeerks.sn');
    assert.equal(wsOriginOf('ws://localhost:4001/ws'), 'ws://localhost:4001');
  });

  test('renvoie la valeur inchangee si elle est illisible', () => {
    assert.equal(wsOriginOf('pas une url'), 'pas une url');
  });
});
