/**
 * Tests de l'audit du blueprint Render.
 *
 * Chaque branche existe parce qu'une erreur y est silencieuse au déploiement :
 * le blueprint est lu par Render, pas par ce dépôt, donc rien d'autre ne
 * signale qu'un contrôle ne s'est pas exécuté.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditBlueprint,
  auditOriginsWs,
  auditRoleService,
  compileLeFrontend,
  estIncoherent,
  parGravite,
} from '../../scripts/render-blueprint.mjs';

/** Blueprint de référence : la configuration réellement déployée. */
const BLUEPRINT = {
  services: [
    {
      type: 'web',
      runtime: 'node',
      plan: 'free',
      rootDir: 'backend',
      buildCommand: 'npm ci',
      startCommand: 'npm run start:all',
      healthCheckPath: '/__static_health',
      envVars: [
        { key: 'DATABASE_URL', sync: false },
        { key: 'STATIC_SERVE_APPS', value: 'false' },
        { key: 'WS_ALLOWED_ORIGINS', sync: false },
      ],
    },
  ],
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

test('auditRoleService — relais seul + install seule : coherent', () => {
  const r = auditRoleService({ buildCommand: 'npm ci', serveApps: 'false' });
  assert.equal(r.level, 'ok');
});

test('auditRoleService — relais seul + build frontend : avertissement', () => {
  // L'erreur la plus coûteuse ici est invisible au déploiement : le build
  // passe, la sonde est verte, et chaque déploiement gaspille une minute.
  const r = auditRoleService({ buildCommand: 'npm ci && npm run build', serveApps: 'false' });
  assert.equal(r.level, 'warn');
  assert.match(r.text, /CDN/);
});

test('auditRoleService — sert les ecrans + build frontend : coherent', () => {
  assert.equal(
    auditRoleService({ buildCommand: 'npm ci && npm run build', serveApps: 'true' }).level,
    'ok'
  );
});

test('auditRoleService — sert les ecrans SANS build : bloquant', () => {
  // Le processus refuse de démarrer (build partiel), donc mieux vaut le dire
  // ici qu'attendre le premier déploiement.
  const r = auditRoleService({ buildCommand: 'npm ci', serveApps: 'true' });
  assert.equal(r.level, 'ko');
});

test('auditRoleService — variable absente : deduction signalee', () => {
  const r = auditRoleService({ buildCommand: 'npm ci', serveApps: undefined });
  assert.equal(r.level, 'warn');
  assert.match(r.text, /DÉDUIT/);
});

// --- auditOriginsWs ---------------------------------------------------------

test('auditOriginsWs — absente : bloquant', () => {
  assert.equal(auditOriginsWs([]).level, 'ko');
});

test('auditOriginsWs — a definir au dashboard : rappel du piege 1008', () => {
  const r = auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', sync: false }]);
  assert.match(r.text, /dashboard/);
  assert.match(r.text, /1008/);
});

test('auditOriginsWs — vide : signale pour un deploiement a deux origines', () => {
  // Une liste vide autorise la meme origine seulement. Avec Vercel en face,
  // c'est un refus systematique du WebSocket.
  const r = auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', value: '' }]);
  assert.match(r.text, /Vercel/);
});

test('auditOriginsWs — renseignee : aucune reserve', () => {
  const r = auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', value: 'https://aeerks.vercel.app' }]);
  assert.equal(r.level, 'ok');
});

test('auditOriginsWs — un seul constat, pour rester avec son sujet', () => {
  // Le tri par gravite reordonne la liste : deux constats pour un meme sujet
  // s'afficheraient dans le desordre, l'avertissement avant la ligne qui dit
  // de quoi il parle.
  assert.ok(!Array.isArray(auditOriginsWs([{ key: 'WS_ALLOWED_ORIGINS', value: '' }])));
});

// --- auditBlueprint ---------------------------------------------------------

test('auditBlueprint — le blueprint reel est coherent', () => {
  const { findings } = auditBlueprint(BLUEPRINT);
  assert.equal(estIncoherent(findings), false, texte(findings));
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

test('auditBlueprint — rootDir inattendu signale', () => {
  assert.equal(estIncoherent(auditBlueprint(avec({ rootDir: 'apps/api' })).findings), false);
  assert.match(texte(auditBlueprint(avec({ rootDir: 'apps/api' })).findings), /apps\/api/);
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