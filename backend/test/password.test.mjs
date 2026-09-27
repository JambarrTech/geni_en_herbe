/**
 * Tests du hachage de mot de passe.
 *
 * Deux propriétés à prouver, l'une fonctionnelle et l'autre structurante :
 *
 *  1. COMPATIBILITE. Les hachages déjà enregistrés en base ont été produits par
 *     `scryptSync`. Passer à la version asynchrone ne doit pas les invalider :
 *     sinon plus personne ne peut se connecter et il faut réinitialiser tous les
 *     comptes. C'est le piège classique du « petit nettoyage » de sécurité.
 *
 *  2. NON-BLOQUANT. C'est la raison du passage à l'asynchrone. `scryptSync`
 *     occupe le thread courant pendant ~90 à 180 ms ; une rafale de tentatives
 *     de connexion gelait alors TOUTES les requêtes en cours. On ne se contente
 *     donc pas de vérifier que le hachage fonctionne : on mesure qu'un minuteur
 *     continue de s'exécuter pendant les calculs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync, randomBytes } from 'node:crypto';

import { hashPassword, verifyPassword } from '../src/lib/password.ts';

describe('hashPassword / verifyPassword', () => {
  test('un mot de passe se hache puis se vérifie', async () => {
    const stored = await hashPassword('motdepasse-competition');
    assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/, 'format « sel:empreinte »');
    assert.equal(await verifyPassword('motdepasse-competition', stored), true);
  });

  test('un mauvais mot de passe est refusé', async () => {
    const stored = await hashPassword('correct');
    assert.equal(await verifyPassword('faux', stored), false);
  });

  test('deux hachages du meme mot de passe diffèrent (sel aléatoire)', async () => {
    const a = await hashPassword('idem');
    const b = await hashPassword('idem');
    assert.notEqual(a, b, 'le sel doit rendre les empreintes uniques');
    assert.equal(await verifyPassword('idem', a), true);
    assert.equal(await verifyPassword('idem', b), true);
  });

  test('un sel fourni est respecté', async () => {
    const sel = randomBytes(16).toString('hex');
    const stored = await hashPassword('secret', sel);
    assert.equal(stored.split(':')[0], sel);
  });

  test('les formats invalides sont refusés sans lever', async () => {
    for (const stored of [
      undefined,
      null,
      '',
      'pas-de-separateur',
      ':',
      'sel:',
      ':hash',
      // Empreinte de mauvaise longueur : timingSafeEqual lèverait sans le
      // contrôle de longueur préalable.
      'abc:deadbeef',
    ]) {
      assert.equal(
        await verifyPassword('x', stored),
        false,
        `doit refuser « ${String(stored)} » sans lever`
      );
    }
  });

  test('COMPATIBILITE : un hachage produit par scryptSync vérifie toujours', async () => {
    // Simulation exacte d'un hachage existant en base.
    const sel = randomBytes(16).toString('hex');
    const ancien = `${sel}:${scryptSync('ancien-mot-de-passe', sel, 64).toString('hex')}`;

    assert.equal(
      await verifyPassword('ancien-mot-de-passe', ancien),
      true,
      'REGRESSION : le passage à scrypt asynchrone invaliderait les comptes existants'
    );
    assert.equal(await verifyPassword('autre', ancien), false);
  });
});

describe('non-bloquance de l event loop', () => {
  /**
   * Mesure l'event loop pendant une série de hachages.
   *
   * Le témoin est le nombre de tours d'un minuteur de 10 ms. Un `scryptSync`
   * occupe le thread courant : le minuteur ne peut tourner qu'APRÈS le calcul.
   * En version asynchrone, le calcul part dans le pool de threads et le
   * minuteur continue d'avancer pendant ce temps.
   */
  async function mesurer(hachages) {
    let ticks = 0;
    const debut = performance.now();
    const minuteur = setInterval(() => {
      ticks += 1;
    }, 10);
    await hachages();
    const duree = performance.now() - debut;
    clearInterval(minuteur);
    return { ticks, duree };
  }

  const sel = randomBytes(16).toString('hex');
  const stockRef = `${sel}:${scryptSync('reference', sel, 64).toString('hex')}`;

  test('CONTROLE : la version synchrone bloque bien l event loop', async () => {
    const { ticks, duree } = await mesurer(async () => {
      for (let i = 0; i < 10; i += 1) scryptSync('tentative', sel, 64);
    });
    console.log(
      `      scryptSync   : ${ticks} tour(s) de minuteur pendant ${duree.toFixed(0)} ms`
    );
    // Dix hachages synchrones : aucune place pour le minuteur. Ce témoin DOIT
    // rester quasi nul — sans quoi la mesure suivante ne prouverait rien.
    assert.ok(
      ticks <= 2,
      `le témoin devrait rester quasi nul en synchrone (obtenu : ${ticks})`
    );
  });

  test('la version asynchrone laisse tourner l event loop', async () => {
    const { ticks, duree } = await mesurer(async () => {
      await Promise.all(
        Array.from({ length: 10 }, () => verifyPassword('tentative', stockRef))
      );
    });
    console.log(
      `      scrypt async : ${ticks} tour(s) de minuteur pendant ${duree.toFixed(0)} ms`
    );
    // C'est LA propriété qui compte : le minuteur avance pendant le calcul.
    assert.ok(
      ticks >= 5,
      `le minuteur doit continuer d'avancer pendant les hachages (obtenu : ${ticks} tour(s))`
    );
  });

  test('les dix vérifications sont réellement parallèles', async () => {
    const t0 = performance.now();
    await verifyPassword('a', stockRef);
    const une = performance.now() - t0;

    const t1 = performance.now();
    await Promise.all(
      Array.from({ length: 10 }, () => verifyPassword('b', stockRef))
    );
    const dix = performance.now() - t1;

    // Dix en parallèle coûtent nettement moins que dix en série : c'est la
    // signature du pool de threads. Le seuil est volontairement généreux pour
    // rester stable sur une machine chargée.
    assert.ok(
      dix < une * 7,
      `10 verifications paralleles (${dix.toFixed(0)} ms) vs 1 (${une.toFixed(0)} ms) : ` +
        `le pool de threads ne semble pas utilise`
    );
  });
});
