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

/** Blueprint de référence : la configuration réellement déployée (mono-origine). */
const BLUEPRINT = {
  services: [
    {
      type: 'web',
      runtime: 'node',
      plan: 'free',
      buildCommand: 'npm ci --include=dev && npm run build && npm ci --prefix backend',
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