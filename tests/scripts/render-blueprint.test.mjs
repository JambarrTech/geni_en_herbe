/**
 * Tests de l'audit du blueprint Render.
 *
 * Chaque branche existe parce qu'une erreur y est silencieuse au déploiement :
 * le blueprint est lu par Render, pas par ce dépôt, donc rien d'autre ne
 * signale qu'un contrôle ne s'est pas exécuté.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const load = require('js-yaml').load;

/** `render.yaml` réel, trouvé depuis ce fichier et non depuis le cwd. */
const RENDER_YAML = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'render.yaml');

import {
  auditBlueprint,
  auditMigrationAuBuild,
  auditOriginsWs,
  auditRoleService,
  compileLeFrontend,
  estIncoherent,
  parGravite,
} from '../../scripts/render-blueprint.mjs';

/** Blueprint de référence : la configuration réellement déployée (mono-origine). */
const BLUEPRINT = {
  services: [
    {
      type: 'web',
      runtime: 'node',
      plan: 'free',
      buildCommand:
        'npm ci --include=dev && npm run build && npm ci --prefix backend && cd backend && npm run db:migrate',
      startCommand: 'cd backend && npm run start:all',
      healthCheckPath: '/__static_health',
      envVars: [
        { key: 'DATABASE_URL', sync: false },
        { key: 'WS_ALLOWED_ORIGINS', value: '' },
      ],
    },
  ],
};

/** Montage « CDN devant », qui reste possible et reste diagnostiqué. */
const AVEC_CDN = {
  buildCommand: 'npm ci',
  startCommand: 'cd backend && npm run start:all',
  envVars: [{ key: 'WS_ALLOWED_ORIGINS', value: '' }],
};

/** Clone assez profond pour modifier un service sans toucher au modèle. */
function avec(patch) {
  return { services: [{ ...BLUEPRINT.services[0], ...patch }] };
}

const texte = (findings) => findings.map((f) => f.text).join('\n');

// --- compileLeFrontend ------------------------------------------------------

test('compileLeFrontend — « npm ci » ne compile rien', () => {
  // Le cas Render : on installe, on ne compile pas. Un motif trop permissif
  // (notamment `/build/` non borné, qui court sur « buildCommand ») déclencherait
  // un avertissement sur une configuration correcte.
  assert.equal(compileLeFrontend('npm ci'), false);
  assert.equal(compileLeFrontend('npm ci --include=dev'), false);
});

test('compileLeFrontend — un build explicite est détecté', () => {
  assert.equal(compileLeFrontend('npm ci && npm run build'), true);
  assert.equal(compileLeFrontend('npx vite build'), true);
});

test('compileLeFrontend — une valeur absente ne leve pas', () => {
  assert.equal(compileLeFrontend(undefined), false);
});

// --- auditRoleService -------------------------------------------------------

test('auditRoleService — mono-origine : coherent', () => {
  const r = auditRoleService({ buildCommand: BLUEPRINT.services[0].buildCommand });
  assert.equal(r.level, 'ok');
  assert.match(r.text, /aucune variable/);
});

test('auditRoleService — STATIC_SERVE_APPS=false contre un build : avertissement', () => {
  // Configuration impossible : les écrans seraient produits puis ignorés, et
  // chaque route répondrait 404. Ni le build ni la sonde ne le signalent.
  const r = auditRoleService({ buildCommand: 'npm ci && npm run build', serveApps: 'false' });
  assert.equal(r.level, 'warn');
  assert.match(r.text, /404/);
});

test('auditRoleService — pas de build des ecrans : renvoi vers le montage CDN', () => {
  const r = auditRoleService({ buildCommand: 'npm ci', serveApps: undefined });
  assert.equal(r.level, 'warn');
  assert.match(r.text, /CDN/);
  // Le renvoi doit nommer la consequence operationnelle, pas seulement le
  // montage : c'est elle qui fera agir.
  assert.match(r.text, /WS_ALLOWED_ORIGINS/);
});

// --- auditOriginsWs ---------------------------------------------------------

test('auditOriginsWs — absente : signalee, non bloquante', () => {
  // Absente, elle retombe sur le défaut du serveur (même origine), ce qui est
  // correct ici. Mais la décision vaut mieux écrite dans le dépôt.
  assert.equal(auditOriginsWs([], { monoOrigine: true }).level, 'warn');
});

test('auditOriginsWs — vide EN MONO-ORIGINE : correct', () => {
  // C'est LE cas du déploiement retenu. Un audit qui signalerait ici crierait
  // au.sys sur une configuration parfaitement juste, et l'on s'habituerait à
  // ignorer ses avertissements.
  const r = auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', value: '' }], { monoOrigine: true });
  assert.equal(r.level, 'ok');
});

test('auditOriginsWs — vide AVEC CDN : le piege 1008', () => {
  // La même valeur, la seule topologie change, et le verdict s'inverse. C'est
  // exactement le mode de panne que la mono-origine supprime : un refus
  // silencieux qui se manifeste en chrono figé.
  const r = auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', value: '' }], { monoOrigine: false });
  assert.equal(r.level, 'warn');
  assert.match(r.text, /1008/);
});

test('auditOriginsWs — a definir au dashboard : consigne adaptee a la topologie', () => {
  const avecCdn = auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', sync: false }], {
    monoOrigine: false,
  });
  assert.match(avecCdn.text, /dashboard/);
  assert.match(avecCdn.text, /1008/);

  // En mono-origine, la consigne est l'inverse : vide suffit.
  const mono = auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', sync: false }], { monoOrigine: true });
  assert.match(mono.text, /VIDE suffit/);
});

test('auditOriginsWs — renseignee : aucune reserve', () => {
  const r = auditOriginsWs(
    [{ key: 'WS_ALLOWED_ORIGINS', value: 'https://aeerks.vercel.app' }],
    { monoOrigine: false }
  );
  assert.equal(r.level, 'ok');
});

test('auditOriginsWs — un seul constat, pour rester avec son sujet', () => {
  // Le tri par gravite reordonne la liste : deux constats pour un meme sujet
  // s'afficheraient dans le desordre, l'avertissement avant la ligne qui dit
  // de quoi il parle.
  assert.ok(
    !Array.isArray(auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', value: '' }], { monoOrigine: true }))
  );
});

// --- auditMigrationAuBuild --------------------------------------------------

test('auditMigrationAuBuild — db:migrate après les dépendances : correct', () => {
  // L'ordre du blueprint réellement déployé.
  const r = auditMigrationAuBuild(
    'npm ci --include=dev && npm run build && npm ci --prefix backend && cd backend && npm run db:migrate'
  );
  assert.equal(r.level, 'ok');
});

test('auditMigrationAuBuild — aucune migration : bloquant', () => {
  // L'état avant le correctif. C'est la configuration qui a coûté deux pannes :
  // le code déployé lisait une colonne absente, et rien dans le dépôt ne le
  // interdisait puisque le buildCommand ne parlait pas de migrations.
  const r = auditMigrationAuBuild('npm ci --include=dev && npm run build && npm ci --prefix backend');
  assert.equal(r.level, 'ko');
  assert.match(r.text, /db:migrate/);
  // Le constat doit rappeler pourquoi, sinon il se lit comme une préférence.
  assert.match(r.text, /0005_broadcast_roster_until/);
});

test('auditMigrationAuBuild — db:migrate avant le npm ci du backend : bloquant', () => {
  // Le script a besoin de drizzle-orm et de tsx. Sans eux il meurt sur un module
  // introuvable : bruyant, mais trompeur, et le rapport d'échec ne parle pas de
  // migrations. Détecté avant le déploiement, c'est un message clair.
  const r = auditMigrationAuBuild(
    'cd backend && npm run db:migrate && npm ci --prefix backend && npm run build'
  );
  assert.equal(r.level, 'ko');
  assert.match(r.text, /ts[xx]/);
});

test('auditMigrationAuBuild — un buildCommand absent ne leve pas', () => {
  // Le cas est réel : `auditBlueprint` signale l'absence du champ, cet audit ne
  // doit pas remplacer ce constat par une exception.
  assert.equal(auditMigrationAuBuild(undefined).level, 'ko');
});

test('auditMigrationAuBuild — ne contrôle ni l\'ordre du build ni --include=dev', () => {
  // Ce sont des préférences, pas des pannes. db:migrate AVANT `npm run build`
  // fonctionne parfaitement : le schéma peut être à jour avant même de compiler.
  const avantBuild = auditMigrationAuBuild(
    'npm ci --prefix backend && cd backend && npm run db:migrate && npm ci --include=dev && npm run build'
  );
  assert.equal(avantBuild.level, 'ok');

  // Et rien dans l'audit ne doit porter de jugement sur la taille de l'image.
  assert.doesNotMatch(auditMigrationAuBuild(undefined).text, /include=dev/);
});

// --- auditBlueprint ---------------------------------------------------------

test('auditBlueprint — le blueprint reel est coherent', () => {
  const { findings } = auditBlueprint(BLUEPRINT);
  assert.equal(estIncoherent(findings), false, texte(findings));
});

test('auditBlueprint — le render.yaml du dépôt est conforme', () => {
  // BLUEPRINT ci-dessus est une COPIE. Sans ce test, on pourrait corriger la
  // copie, laisser le vrai fichier intact, et croire le dépôt migré alors que
  // Render redéployerait sans appliquer les migrations.
  const yaml = readFileSync(RENDER_YAML, 'utf8');
  const { findings } = auditBlueprint(load(yaml));
  assert.equal(estIncoherent(findings), false, texte(findings));
  assert.match(
    auditMigrationAuBuild(load(yaml).services[0].buildCommand).text,
    /Migrations appliquées par le build/,
    "render.yaml n'applique plus les migrations"
  );
});

test('auditBlueprint — services absents : pas de division par zero', () => {
  // Un `render.yaml` vide est un cas réel : le fichier existe, il ne décrit
  // rien. Le diagnostic ne doit pas planter sur `services[0]`.
  const { service, findings } = auditBlueprint({});
  assert.equal(service, null);
  assert.equal(estIncoherent(findings), true);
});

test('auditBlueprint — commandes absentes : chacune son constat', () => {
  const { findings } = auditBlueprint(avec({ buildCommand: undefined, startCommand: undefined }));
  const t = texte(findings);
  assert.match(t, /buildCommand ABSENT/);
  assert.match(t, /startCommand ABSENT/);
  assert.equal(estIncoherent(findings), true);
});

test('auditBlueprint — rootDir signale comme incompatible avec la mono-origine', () => {
  // Le service doit compiler les interfaces, qui vivent à la racine. S'il se
  // restreint à `backend/`, il ne peut ni les compiler ni les servir.
  const { findings } = auditBlueprint(avec({ rootDir: 'backend' }));
  assert.match(texte(findings), /rootDir = "backend"/);
  assert.match(texte(findings), /mono-origine/);
});

test('auditBlueprint — le montage CDN reste diagnostiquable', () => {
  // Le chemin Vercel n'est plus déployé mais reste dans le dépôt : s'il
  // réapparaît, l'audit doit dire ce qu'il coûte, pas seulement le fait.
  const { findings } = auditBlueprint(avec(AVEC_CDN));
  const t = texte(findings);
  assert.match(t, /CDN/);
  assert.match(t, /1008/);
});

test('auditBlueprint — envVars absent ne leve pas', () => {
  const { findings } = auditBlueprint(avec({ envVars: undefined }));
  assert.match(texte(findings), /WS_ALLOWED_ORIGINS/);
});

// --- presentation -----------------------------------------------------------

test('parGravite — les constats les plus graves passent en premier', () => {
  const { findings } = auditBlueprint(avec({ buildCommand: undefined, rootDir: 'apps/api' }));
  const niveaux = parGravite(findings).map((f) => f.level);
  const rang = { ko: 0, warn: 1, info: 2, ok: 3 };
  // Ordre croissant de gravité, et surtout STABLE : c'est la première ligne
  // que l'exploitant lira, elle doit être celle qui compte.
  for (let i = 1; i < niveaux.length; i += 1) {
    assert.ok(rang[niveaux[i - 1]] <= rang[niveaux[i]], `${niveaux[i - 1]} avant ${niveaux[i]}`);
  }
});

test('parGravite — ne mute pas la liste d origine', () => {
  const findings = [{ level: 'ok', text: 'a' }, { level: 'ko', text: 'b' }];
  parGravite(findings);
  assert.equal(findings[0].level, 'ok', 'le tri doit opérer sur une copie');
});