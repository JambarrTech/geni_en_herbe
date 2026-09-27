/**
 * Tests du limiteur de débit.
 *
 * Ces tests existaient pas avant ce middleware : sans eux, « la protection
 * anti-double-clic est contournable » resterait une affirmation. On vérifie
 * donc le comportement observable — 200 puis 429, `Retry-After`, fenêtre qui
 * glisse — sur des objets requête/réponse simulés, sans base de données.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  rateLimit,
  failureLimiter,
  scoreLimit,
  adminWriteLimit,
  loginIpFailures,
  __resetRateLimits,
} from '../src/middleware/rateLimit.ts';

/** Fausse requête : seul `ip` et `user` sont lus par le middleware. */
function fakeReq(ip = '10.0.0.1', uid = 'jury-1') {
  return { ip, socket: { remoteAddress: ip }, user: uid ? { uid } : undefined };
}

/** Fausse réponse : enregistre ce qui a été écrit. */
function fakeRes() {
  const out = { statusCode: 200, headers: {}, body: undefined, ended: false };
  return {
    setHeader(k, v) {
      out.headers[k] = v;
    },
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(payload) {
      out.body = payload;
      out.ended = true;
      return this;
    },
    _out: out,
  };
}

beforeEach(() => __resetRateLimits());

describe('rateLimit', () => {
  test('laisse passer les requêtes sous le quota', () => {
    const mw = rateLimit({ limit: 3, windowMs: 10_000 });
    for (let i = 0; i < 3; i += 1) {
      const res = fakeRes();
      let nexted = false;
      mw(fakeReq(), res, () => {
        nexted = true;
      });
      assert.equal(nexted, true, `requête ${i + 1} doit passer`);
      assert.equal(res._out.statusCode, 200);
    }
  });

  test('bloque avec 429 au-delà du quota', () => {
    const mw = rateLimit({ limit: 3, windowMs: 10_000 });
    for (let i = 0; i < 3; i += 1) mw(fakeReq(), fakeRes(), () => {});

    const res = fakeRes();
    let nexted = false;
    mw(fakeReq(), res, () => {
      nexted = true;
    });

    assert.equal(nexted, false, 'la 4e requête ne doit pas atteindre le handler');
    assert.equal(res._out.statusCode, 429);
    assert.match(res._out.body.error, /Limite atteinte/);
  });

  test('renvoie Retry-After exploitable', () => {
    const mw = rateLimit({ limit: 1, windowMs: 60_000 });
    mw(fakeReq(), fakeRes(), () => {});
    const res = fakeRes();
    mw(fakeReq(), res, () => {});
    const retry = Number(res._out.headers['Retry-After']);
    assert.ok(retry > 0, 'Retry-After doit être positif');
    assert.ok(retry <= 60, `Retry-After dans la fenêtre (reçu ${retry})`);
  });

  test('publie X-RateLimit-Remaining pour observabilité client', () => {
    const mw = rateLimit({ limit: 2, windowMs: 10_000 });
    const first = fakeRes();
    mw(fakeReq(), first, () => {});
    assert.equal(first._out.headers['X-RateLimit-Remaining'], '1');
  });

  test('sépare les utilisateurs : un quota ne bloque pas les autres', () => {
    const mw = rateLimit({ limit: 1, windowMs: 10_000 });
    mw(fakeReq('10.0.0.1', 'jury-1'), fakeRes(), () => {});

    const autre = fakeRes();
    let nexted = false;
    mw(fakeReq('10.0.0.1', 'jury-2'), autre, () => {
      nexted = true;
    });
    assert.equal(nexted, true, 'un second utilisateur ne doit pas être bloqué');
  });

  test('retombe sur l\'IP quand l\'appelant n\'est pas authentifié', () => {
    const mw = rateLimit({ limit: 1, windowMs: 10_000 });
    mw(fakeReq('10.0.0.9', ''), fakeRes(), () => {});

    const meme = fakeRes();
    let nexted = false;
    mw(fakeReq('10.0.0.9', ''), meme, () => {
      nexted = true;
    });
    assert.equal(nexted, false, 'deux appels anonymes de la même IP doivent partager le quota');
  });

  test('la fenêtre glisse : une place se libère après expiration', async () => {
    const mw = rateLimit({ limit: 1, windowMs: 120 });
    mw(fakeReq(), fakeRes(), () => {});

    const bloque = fakeRes();
    mw(fakeReq(), bloque, () => {});
    assert.equal(bloque._out.statusCode, 429);

    await new Promise((r) => setTimeout(r, 180));

    const apres = fakeRes();
    let nexted = false;
    mw(fakeReq(), apres, () => {
      nexted = true;
    });
    assert.equal(nexted, true, 'la requête doit repasser une fois la fenêtre écoulée');
  });

  test('les quotas exportés sont des instances uniques et partagées', () => {
    assert.equal(typeof scoreLimit, 'function');
    assert.equal(typeof adminWriteLimit, 'function');
    assert.notEqual(scoreLimit, adminWriteLimit, 'quota score distinct du quota admin');
  });
});

describe('failureLimiter (échecs seuls)', () => {
  test('ne bloque pas avant le nombre d\'échecs prévu', () => {
    const lim = failureLimiter({ limit: 2, windowMs: 10_000 });
    lim.penalize('ip:1');
    assert.equal(lim.isBlocked('ip:1'), false, 'un seul échec ne bloque pas');
    lim.penalize('ip:1');
    assert.equal(lim.isBlocked('ip:1'), true, 'deux échecs bloquent');
  });

  test('ne compte que les échecs, pas les succès', () => {
    const lim = failureLimiter({ limit: 3, windowMs: 10_000 });
    // 100 succès sans échec : rien à penaliser.
    for (let i = 0; i < 100; i += 1) lim.reset(`ip:${i}`);
    assert.equal(lim.isBlocked('ip:1'), false);
  });

  test('une réussite efface les échecs antérieurs', () => {
    const lim = failureLimiter({ limit: 2, windowMs: 10_000 });
    lim.penalize('ip:1');
    lim.penalize('ip:1');
    assert.equal(lim.isBlocked('ip:1'), true);
    lim.reset('ip:1');
    assert.equal(lim.isBlocked('ip:1'), false, 'la réussite doit purge le compteur');
  });

  test('les clés sont indépendantes', () => {
    const lim = failureLimiter({ limit: 1, windowMs: 10_000 });
    lim.penalize('ip:A');
    assert.equal(lim.isBlocked('ip:B'), false);
  });

  test('retryAfter renvoie 0 tant que rien n\'est bloqué', () => {
    const lim = failureLimiter({ limit: 1, windowMs: 10_000 });
    assert.equal(lim.retryAfter('ip:inexistant'), 0);
  });
});

describe('limiteur d\'échecs de connexion exporté', () => {
  test('existe et sanctionne une IP après 30 échecs', () => {
    for (let i = 0; i < 30; i += 1) loginIpFailures.penalize('login-ip:203.0.113.5');
    assert.equal(loginIpFailures.isBlocked('login-ip:203.0.113.5'), true);
  });

  test('ne bloque pas une salle entière légitime', () => {
    // 30 connexions RÉUSSIES depuis la même IP ne doivent pas bloquer :
    // c'est le cas d'usage réel d'une salle de compétition derrière un NAT.
    const ip = 'login-ip:198.51.100.7';
    for (let i = 0; i < 30; i += 1) loginIpFailures.reset(ip);
    assert.equal(loginIpFailures.isBlocked(ip), false);
  });
});
