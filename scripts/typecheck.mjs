import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import path from 'node:path';

/**
 * Vérifie le type de tous les projets, en parallèle.
 *
 * `tests/` est le seul cible qui ne soit pas un paquet npm : lui donner un
 * `package.json` pour satisfaire ce script aurait créé un paquet fantôme, que
 * ni `npm ci` ni le Dockerfile ne connaîtraient, et dont le `dependencies`
 * serait vide alors que les tests en ont. On l'atteint donc par son
 * `tsconfig.json`, invoqué directement.
 */
const targets = [
  { dir: 'backend', label: 'backend' },
  { dir: 'apps/live', label: 'apps/live' },
  { dir: 'apps/jury', label: 'apps/jury' },
  { dir: 'apps/admin', label: 'apps/admin' },
  { tsconfig: 'tests/tsconfig.json', label: 'tests' },
];

// Sur Windows, `npm` est un fichier `npm.cmd` : sans ce correctif,
// `spawn('npm', ...)` échoue avec ENOENT et `npm run typecheck` était cassé.
const NPM_CMD = platform === 'win32' ? 'npm.cmd' : 'npm';
const SHELL = platform === 'win32';

/** Lance `tsc --noEmit` et rejette au premier code de sortie non nul. */
function check(target) {
  const [command, args, cwd] = target.tsconfig
    ? [process.execPath, [require_tsc(), '--noEmit', '-p', path.resolve(target.tsconfig)], process.cwd()]
    : [NPM_CMD, ['run', 'typecheck'], path.resolve(target.dir)];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: SHELL && !target.tsconfig });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Typecheck échoué dans ${target.label} (code ${code})`));
    });
  });
}

/**
 * Chemin du binaire `tsc`.
 *
 * Résolu par Node plutôt que par `npx` : `npx` télécharge le paquet s'il est
 * absent, ce qui masque ici un environment mal installé et transforme un
 * « TypeScript manquant » en « TypeScript téléchargé, résultats ignorés ».
 * On veut que l'absence se voie.
 */
function require_tsc() {
  return path.resolve('node_modules/typescript/bin/tsc');
}

// Projets indépendants : vérification en parallèle, et on remonte la première
// erreur en indicating tous les projets fautifs.
const results = await Promise.allSettled(targets.map(check));
const failed = results
  .map((r, i) => (r.status === 'rejected' ? targets[i].label : null))
  .filter(Boolean);

if (failed.length > 0) {
  console.error(`\n[typecheck] ÉCHEC dans : ${failed.join(', ')}`);
  process.exit(1);
}

console.log('\n[typecheck] Tous les projets passent le typecheck.');
