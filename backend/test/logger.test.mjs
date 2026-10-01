/**
 * Test de la journalisation structuree.
 *
 * Ce que ces tests protègent
 * --------------------------
 * La redaction est le SEUL point de ce module ou une regression est
 * directement exploitable : un logger structure ecrit des objets entiers, et
 * `req.body` porte le mot de passe a la connexion tandis que l'en-tete
 * `Authorization` porte le jeton de session sur chaque appel authentifie. Un
 * oubli de redaction inscrirait ces secrets dans les journaux, de facon
 * permanente et en cas de rejeu ulterieur.
 *
 * Les tests interceptent `process.stdout.write` plutot que de mocker `console` :
 * le module ecrit directement sur les flux, donc c'est la que la sortie
 * apparait reellement. C'est aussi ce que verrait un agregateur de journaux.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogger,
  withRequestId,
  currentRequestId,
  rootLogger,
} from '../src/lib/logger.ts';

/** Capture tout ce qu'ecrit un logger pendant l'execution de `fn`. */
function capture(fn, env = {}) {
  const saved = { ...process.env };
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const out = [];
  const err = [];
  try {
    Object.assign(process.env, env);
    process.stdout.write = (chunk) => {
      out.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk) => {
      err.push(String(chunk));
      return true;
    };
    fn();
  } finally {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
    process.env = saved;
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

describe('logger — redaction', () => {
  test('ne jamais laisser fuir un mot de passe', () => {
    const { stdout } = capture(() => {
      createLogger('api').info('connexion', {
        password: 'motdepasse-tres-secret',
        email: 'admin@aeerks.sn',
      });
    });

    assert.ok(!stdout.includes('motdepasse-tres-secret'), 'le mot de passe apparait dans le log');
    assert.ok(stdout.includes('[redige]'), 'la valeur n\'est pas marquee comme redigee');
    // Le champ non sensible doit rester : on ne masque pas tout le contexte.
    assert.ok(stdout.includes('admin@aeerks.sn'));
  });

  test('couvrir les variantes de casse et de separateurs', () => {
    // Le meme secret peut arriver sous trois formes selon la source du champ.
    const { stdout } = capture(() => {
      createLogger('api').warn('test', {
        password_hash: 'sel:empreinte',
        passwordHash: 'sel:empreinte',
        PASSWORD: 'x',
        access_token: 'jeton',
      });
    });

    assert.ok(!stdout.includes('sel:empreinte'));
    assert.ok(!stdout.includes('jeton'));
  });

  test('un nom de champ contenant un mot de passe suffit', () => {
    const { stdout } = capture(() => {
      createLogger('api').info('test', { userPassword: 'secret', oldPassword: 'secret' });
    });
    assert.ok(!stdout.includes('secret'));
  });

  test('l\'en-tete Authorization est masque', () => {
    const { stdout } = capture(() => {
      createLogger('api').info('requete', {
        headers: { authorization: 'Bearer aeerks_jeton_secret', accept: 'application/json' },
      });
    });
    assert.ok(!stdout.includes('aeerks_jeton_secret'));
    assert.ok(stdout.includes('application/json'), 'les en-tetes anodins restent lisibles');
  });

  test('une cle evidentiellement non sensible reste visible', () => {
    // Le risque inverse d'un filtrage trop agressif : perdre des champs utiles
    // pour ne proteger que du vent.
    const { stdout } = capture(() => {
      createLogger('api').info('test', { userId: 42, matchId: 17, teamId: 3 });
    });
    assert.ok(stdout.includes('42'));
    assert.ok(stdout.includes('17'));
    assert.ok(stdout.includes('3'));
  });
});

describe('logger — resistance aux entrees hostiles', () => {
  test('un objet circulaire ne fait pas planter le journal', () => {
    const circular = { nom: 'test' };
    circular.soi = circular;

    // `error` part sur stderr : c'est la que la ligne atterrit.
    const { stderr } = capture(() => {
      // Un journal qui leve sur une reference circulaire est pire qu'absent :
      // l'erreur qu'on cherchait a tracer disparait avec elle.
      assert.doesNotThrow(() => createLogger('api').error('test', circular));
    });
    assert.ok(stderr.includes('Circular'));
  });

  test('une profondeur excessive est bornee', () => {
    // Sans borne, un dump d'arbre tres profond bloque le processus et retarde
    // la reponse HTTP qu'il accompanyait.
    let deep = { valeur: 'fond' };
    for (let i = 0; i < 50; i += 1) deep = { imbrique: deep };

    const { stdout } = capture(() => {
      assert.doesNotThrow(() => createLogger('api').info('test', deep));
    });
    assert.ok(!stdout.includes('profondeur max 50'), 'la profondeur doit etre bornee');
  });

  test('un tableau enorme est tronque', () => {
    const huge = Array.from({ length: 50_000 }, (_, i) => i);
    const { stdout } = capture(() => {
      createLogger('api').info('test', { elements: huge });
    });
    assert.ok(!stdout.includes('49999'), 'un tableau de 50 000 elements ne doit pas etre integralement journalise');
    assert.ok(stdout.includes('de plus'));
  });

  test('une chaine enorme est tronquee', () => {
    const long = 'x'.repeat(100_000);
    const { stdout } = capture(() => {
      createLogger('api').info('test', { charge: long });
    });
    assert.ok(stdout.includes('tronque'));
    assert.ok(stdout.length < 5_000, `sortie trop longue (${stdout.length} caracteres)`);
  });

  test('une erreur garde sa pile', () => {
    const { stderr } = capture(() => {
      createLogger('api').error('echec', { err: new Error('boum') });
    });
    // Les erreurs vont sur stderr : c'est ce qui permet de les separer des
    // evenements ordinaires dans une collecte.
    assert.ok(stderr.includes('boum'));
    assert.ok(stderr.includes('at '), 'la pile doit etre conservee');
  });
});

describe('logger — format', () => {
  test('production : une ligne JSON par evenement, sans couleur', () => {
    const { stdout } = capture(
      () => createLogger('api').info('pret', { port: 4000 }),
      { NODE_ENV: 'production' }
    );

    assert.ok(!stdout.includes('[0m'), 'pas de code couleur en production');
    // Chaque ligne doit etre independamment parseable : c'est la condition
    // pour qu'un agregateur indexed une ligne sans attendre la suivante.
    const line = stdout.trim();
    assert.ok(!line.includes('\n'), 'un evenement = une ligne');
    const parsed = JSON.parse(line);
    assert.equal(parsed.msg, 'pret');
    assert.equal(parsed.service, 'api');
    assert.equal(parsed.port, 4000);
    assert.equal(parsed.level, 'info');
    assert.ok(typeof parsed.time === 'string' && !Number.isNaN(Date.parse(parsed.time)));
  });

  test('le service est toujours present', () => {
    // Quatre processus écrivent dans les mêmes journaux : sans ce champ, on
    // ne peut pas séparer leurs lignes.
    const { stdout } = capture(() => createLogger('worker').info('tick'));
    assert.ok(stdout.includes('[worker]'));
  });
});

describe('logger — niveaux', () => {
  test('LOG_LEVEL=error supprime les niveaux inferieurs', () => {
    const { stdout, stderr } = capture(
      () => {
        const log = createLogger('api');
        log.debug('bruit');
        log.info('normal');
        log.warn('attention');
        log.error('serieux');
      },
      { LOG_LEVEL: 'error' }
    );

    assert.ok(!stdout.includes('bruit'));
    assert.ok(!stdout.includes('normal'));
    assert.ok(!stdout.includes('attention'));
    assert.ok(stderr.includes('serieux'));
  });

  test('error part sur stderr, info sur stdout', () => {
    const { stdout, stderr } = capture(() => {
      const log = createLogger('api');
      log.info('normal');
      log.error('anormal');
    });
    assert.ok(stdout.includes('normal'));
    assert.ok(!stdout.includes('anormal'));
    assert.ok(stderr.includes('anormal'));
  });
});

describe('logger — correlation de requete', () => {
  test('l\'identifiant de requete apparait automatiquement', () => {
    // Les deux flux sont relus ensemble : `error` part sur stderr par
    // conception, donc lire stdout seul ne verrait que la ligne `info` et
    // ferait conclure a tort que la correlation est cassee.
    const { stdout, stderr } = capture(() => {
      withRequestId('req-abc123', () => {
        assert.equal(currentRequestId(), 'req-abc123');
        // Aucune fonction appelante ne mentionne l'identifiant : c'est le
        // module qui l'ajoute. Une erreur de base trois appels plus bas porte
        // donc le meme identifiant que la ligne d'access log.
        createLogger('api').info('appel');
        createLogger('db').error('echec sql');
      });
    });

    const combined = stdout + stderr;
    assert.ok(combined.includes('req-abc123'));
    assert.equal(
      combined.match(/req-abc123/g).length,
      2,
      'les deux lignes doivent etre correlees'
    );
  });

  test('hors contexte, aucun identifiant n\'est invente', () => {
    const { stdout } = capture(() => {
      assert.equal(currentRequestId(), undefined);
      createLogger('api').info('hors contexte');
    });
    assert.ok(!stdout.includes('requestId'));
  });

  test('deux requetes concurrentes ne se melangent pas', async () => {
    // C'est le risque propre a AsyncLocalStorage mal utilise : une variable
    // globale ecraserait l'identifiant de la premiere requete par celui de la
    // seconde, et l'on retrouverait des lignes rattachees a la mauvaise requete.
    const seen = [];
    await Promise.all(
      ['req-1', 'req-2', 'req-3'].map((id) =>
        new Promise((resolve) => {
          capture(() => {
            withRequestId(id, () => {
              setTimeout(() => {
                seen.push([id, currentRequestId()]);
                resolve();
              }, 5);
            });
          });
        })
      )
    );

    assert.deepEqual(seen.sort(), [
      ['req-1', 'req-1'],
      ['req-2', 'req-2'],
      ['req-3', 'req-3'],
    ]);
  });
});

describe('logger — enfants', () => {
  test('un logger enfant conserve les champs du parent', () => {
    const { stdout } = capture(() => {
      const base = createLogger('api');
      const child = base.child({ route: '/api/matches/:id' });
      child.info('evenement');
    });
    assert.ok(stdout.includes('api'));
    assert.ok(stdout.includes('/api/matches/:id'));
  });
});

describe('rootLogger', () => {
  test('existe sans service', () => {
    const { stdout } = capture(() => rootLogger.info('test racine'));
    assert.ok(stdout.includes('test racine'));
  });
});
