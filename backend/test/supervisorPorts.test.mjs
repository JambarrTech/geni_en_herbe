/**
 * Tests de la répartition des ports du superviseur.
 *
 * POURQUOI CES TESTS EXISTENT
 * ---------------------------
 * Ce module ne contient que de l'arithmétique de ports, et c'est précisément
 * pour cela qu'il merits des tests : la règle qu'il applique ne se vérifie
 * qu'en faisant réellement écouter deux processus sur le même port.
 *
 * Le bug qu'ils empêchent a eu lieu. `PORT` injecté par l'hébergeur était
 * hérité par l'API, qui tentait d'écouter sur le port public déjà pris par
 * `static` : le conteneur mourait sur `EADDRINUSE` APRÈS une construction
 * réussie. Un déploiement qui « réussit » puis ne sert rien.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  envForService,
  portsCollide,
  publicPortEnv,
  privatePortEnv,
} from '../src/lib/supervisorPorts.ts';

const PLATEFORME = '10000';
const BASE = {
  DATABASE_URL: 'postgresql://user:pw@host/db',
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
};

describe('publicPortEnv', () => {
  test('le service public prend le port impose par la plateforme', () => {
    // Render, Railway et Heroku injectent PORT ; c'est la seule façon pour le
    // service d'ecouter sur le port que le proxy de la plateforme atteint.
    assert.deepEqual(publicPortEnv(PLATEFORME), { STATIC_PORT: PLATEFORME });
  });

  test('sans PORT injecte, repli sur le port de developpement', () => {
    // En local aucun `PORT` n'est fourni : le superviseur doit rester
    // utilisable hors hebergeur.
    assert.equal(publicPortEnv(undefined).STATIC_PORT, '4003');
    assert.equal(publicPortEnv('').STATIC_PORT, '4003');
  });

  test("un port invalide retombe sur le repli, il n'est pas propage", () => {
    // `PORT=abc` donnerait `NaN`, et `server.listen(NaN)` attribue un port au
    // hasard : le service demarre, mais le relais ne le rejoint pas.
    const port = publicPortEnv('abc').STATIC_PORT;
    assert.equal(port, '4003');
  });
});

describe('privatePortEnv', () => {
  test('ne renvoie aucune variable de port', () => {
    assert.deepEqual(privatePortEnv(), {});
  });
});

describe('envForService — la regle qui compte', () => {
  test('le service public herite de PORT ET recoit STATIC_PORT', () => {
    const env = envForService({
      platformPort: PLATEFORME,
      isPublic: true,
      baseEnv: { ...BASE, PORT: PLATEFORME },
    });
    assert.equal(env.STATIC_PORT, PLATEFORME);
    // Conservé : `static` lit d'abord STATIC_PORT, et le garder évite qu'un
    // enfant puisse le relire par erreur.
    assert.equal(env.PORT, PLATEFORME);
  });

  test("les services prives n'heritent PAS de PORT", () => {
    // LE test le plus important. Avec cet héritage, `index.ts` lit
    // `API_PORT || PORT` : l'API tente le port public, deja pris, et meurt
    // sur EADDRINUSE apres une construction reussie.
    const env = envForService({
      platformPort: PLATEFORME,
      isPublic: false,
      baseEnv: { ...BASE, PORT: PLATEFORME },
    });
    assert.equal(
      env.PORT,
      undefined,
      'PORT doit etre ABSENT chez un service prive, sinon il hérite du port public'
    );
  });

  test('PORT est absent, et non vide', () => {
    // `Number('')` vaut 0, et le port 0 est VALIDE : le systeme attribue un
    // port libre au hasard. Le service demarre, vivant et injoignable par le
    // relais -- un defaut silencieux. `in` doit etre `undefined`.
    const env = envForService({
      platformPort: PLATEFORME,
      isPublic: false,
      baseEnv: { ...BASE, PORT: PLATEFORME },
    });
    assert.ok(!('PORT' in env), 'la clé PORT doit être absente, pas présente et vide');
  });

  test('les variables de la base survivent au retrait de PORT', () => {
    // `DATABASE_URL` n'est pas négociable : le retirer ferait échouer le
    // déploiement sur une erreur de connexion, pas sur un port.
    const env = envForService({
      platformPort: PLATEFORME,
      isPublic: false,
      baseEnv: { ...BASE, PORT: PLATEFORME },
    });
    assert.equal(env.DATABASE_URL, BASE.DATABASE_URL);
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.LOG_LEVEL, 'info');
  });

  test('l environnement de base n est pas modifie', () => {
    // Le `delete` doit agir sur une COPIE. Modifier l'environnement du
    // superviseur ferait disparaitre PORT pour tous les enfants suivants,
    // y compris le service public qui en a besoin.
    const baseEnv = { ...BASE, PORT: PLATEFORME };
    envForService({ platformPort: PLATEFORME, isPublic: false, baseEnv });
    assert.equal(baseEnv.PORT, PLATEFORME, 'la source ne doit pas être mutée');
  });

  test('un environnement sans PORT fonctionne aussi', () => {
    // Développement local : le cas nominal ne doit pas devenir une erreur.
    const env = envForService({ platformPort: undefined, isPublic: false, baseEnv: { ...BASE } });
    assert.equal(env.PORT, undefined);
    assert.equal(env.DATABASE_URL, BASE.DATABASE_URL);
  });

  test("le superviseur transmet son environnement a chaque enfant", async () => {
    // Garde-fou d'INTÉGRATION. `envForService` ci-dessus est pure : elle n'est
    // correcte que si l'APPELANT lui passe `baseEnv`. Le type le garantit a la
    // compilation ; ce test le grave aussi dans la suite pour que le role de
    // `portsFor` (copier `process.env`) ne disparaisse pas en silence.
    //
    // Le bug a eu lieu. Les quatre processus ne recevaient que leurs ports,
    // donc plus de `DATABASE_URL`. Invisible en local, ou `dotenv` relit
    // `backend/.env` depuis le dossier courant ; fatal dans l'image, qui
    // l'exclut par `.dockerignore`.
    const source = await readFile(new URL('../src/supervisor.ts', import.meta.url), 'utf8');
    assert.match(source, /baseEnv:\s*process\.env/);
  });
});

describe('portsCollide — garantie structurelle du deploiement', () => {
  test('detecte deux services sur le meme port', () => {
    const conflit = portsCollide({ api: 10000, static: 10000, ws: 4001 });
    assert.match(conflit, /api et static utilisent le port 10000/);
  });

  test('ne signale rien si les ports sont distincts', () => {
    assert.equal(portsCollide({ api: 4000, ws: 4001, worker: 4002, static: 10000 }), null);
  });

  test('la disposition reelle du deploiement est sans conflit', () => {
    // Les quatre processus, avec le port de la plateforme pour le public.
    // C'est la configuration que `render.yaml` décrit : si elle devenait
    // contradictoire, ce test le dirait avant le deploiement.
    assert.equal(
      portsCollide({ api: 4000, ws: 4001, worker: 4002, static: Number(PLATEFORME) }),
      null
    );
  });

  test('le port 0 n entre pas en collision avec lui-meme', () => {
    // Le port 0 signifie « attribue-moi un port libre » : deux services qui
    // l'emploient ne se disputeront rien.
    assert.equal(portsCollide({ api: 0, ws: 0 }), null);
  });

  test('le port 0 n entre pas non plus en collision avec un port fixe', () => {
    assert.equal(portsCollide({ api: 0, ws: 4001 }), null);
  });
});