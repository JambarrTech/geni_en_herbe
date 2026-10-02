import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import { rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseVercelConfig, resolveBackendOrigin } from './vercel-backend.mjs';

const apps = ['live', 'jury', 'admin'];

// Sur Windows, `npm` est un fichier `npm.cmd` : `spawn('npm')` échoue avec
// ENOENT. C'était la cause du build/typecheck cassés sur la machine de dev
// alors que `dev.mjs` gérait déjà ce cas correctement.
const NPM_CMD = platform === 'win32' ? 'npm.cmd' : 'npm';
const SHELL = platform === 'win32';

// `VITE_BASE_PATH=/jury/ vite build` est une syntaxe POSIX : invalide en
// cmd.exe. On passe la variable via `env` de spawn, ce qui fonctionne partout.
const BASE_PATHS = {
  live: '/',
  jury: '/jury/',
  admin: '/admin/',
};

/**
 * `VITE_WS_URL` : déduit de `vercel.json`, et non plus saisi à la main.
 *
 * Tant que l'interface est servie par le backend lui-même — le déploiement
 * retenu, mono-origine — la variable doit rester ABSENTE : `shared/lib/wsUrl.ts`
 * suit alors l'origine de la page, ce qui est le comportement correct et ne
 * demande rien à personne.
 *
 * Elle n'est requise que si l'interface est déployée ailleurs que l'API, donc
 * sur Vercel. Plutôt que de la faire saisir dans le tableau de bord (une valeur
 * invisible du build ET du garde-fou de cohérence, dont l'oubli ne se manifeste
 * qu'en plein match, chrono figé), on la déduit de l'hôte que `vercel.json`
 * déclare déjà.
 *
 * LE GARD `VERCEL`
 * ----------------
 * Vercel positionne `VERCEL` dans tous ses builds. Sans cette condition, la
 * déduction s'exécutait aussi sur le build Render : celui-ci dépendait alors
 * d'un fichier Vercel pour produire un bundle qui n'a rien à voir avec Vercel.
 *
 * Le résultat restait juste par coïncidence — le même hôte — et c'est
 * précisément ce qui rendait la dépendance invisible. Une coïncidence correcte
 * reste une dépendance : le jour où le domaine change, le build Render aurait
 * embarqué une URL périmée sans qu'aucun contrôle ne le remarque.
 */
async function resolveWsUrlEnv() {
  if (process.env.VITE_WS_URL?.trim()) {
    return { VITE_WS_URL: process.env.VITE_WS_URL.trim() };
  }

  // Hors Vercel, le déploiement est mono-origine : rien à déduire.
  if (!process.env.VERCEL) {
    return {};
  }

  const config = await readFile(path.resolve('vercel.json'), 'utf8');

  // `vercel.json` porte le marqueur tant que le domaine n'est pas choisi. Ce
  // qui peut arriver en local, où l'interface et l'API partagent une origine.
  // Le garde-fou doit alors se taire au lieu de faire échouer un build
  // légitime. Il parle au bon moment — à l'assemblage de `dist/` pour Vercel,
  // qui refuse de livrer un canal temps réel non configuré.
  //
  // Le test précède l'appel parce que `resolveBackendOrigin` lève au lieu de
  // rendre la main quand le marqueur est présent.
  if (!parseVercelConfig(config).configured) {
    return {};
  }

  const { wsUrl, origin } = resolveBackendOrigin(config);
  console.log(`[build] VITE_WS_URL deduit de vercel.json : ${wsUrl} (${origin})`);
  return { VITE_WS_URL: wsUrl };
}

const EXTRA_ENV = await resolveWsUrlEnv();

function build(app) {
  const cwd = path.resolve('apps', app);
  return new Promise((resolve, reject) => {
    console.log(`[build] apps/${app}...`);
    const child = spawn(NPM_CMD, ['run', 'build'], {
      cwd,
      stdio: 'inherit',
      shell: SHELL,
      env: { ...process.env, ...EXTRA_ENV, VITE_BASE_PATH: BASE_PATHS[app] },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`[build] apps/${app} : OK`);
        resolve();
      } else {
        reject(new Error(`Build de apps/${app} échoué (code ${code})`));
      }
    });
  });
}

async function cleanDist() {
  for (const app of apps) {
    const dist = path.resolve('apps', app, 'dist');
    await rm(dist, { recursive: true, force: true });
  }
  console.log('[build] dist/ nettoyé (évite les chunks périmés d\'un build précédent)');
}

async function reportSizes() {
  for (const app of apps) {
    const dist = path.resolve('apps', app, 'dist', 'assets');
    let files = [];
    try {
      files = await readdir(dist);
    } catch {
      continue;
    }
    console.log(`[build] apps/${app}/dist/assets : ${files.length} fichier(s)`);
  }
}

await cleanDist();
// Les trois apps sont indépendantes : on les compile en parallèle.
await Promise.all(apps.map(build));
await reportSizes();

// Le build « réussit » au sens de Vite même quand l'interface est cassée :
// une classe Tailwind absente ne fait pas échouer le bundler. Or c'est
// exactement ce qui est arrivé — `shared/` n'était pas déclaré comme source,
// et pages de connexion, barre de navigation et modales n'avaient aucune règle
// applicable, sans que typecheck, ESLint ni grep de bundle ne le remarquent.
//
// On vérifie donc la SUBSTANCE des artefacts, pas leur présence. Le script
// échoue si une classe utilisée n'a produit aucune règle CSS.
console.log('\n[build] Vérification du CSS produit...');
const verify = spawn(process.execPath, ['scripts/verify-build-output.mjs'], {
  stdio: 'inherit',
  shell: false,
});
await new Promise((resolve, reject) => {
  verify.on('error', reject);
  verify.on('exit', (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`Vérification du CSS échouée (code ${code})`))
  );
});

console.log('\n[build] Toutes les apps sont compilées dans apps/*/dist (servies par le backend).');