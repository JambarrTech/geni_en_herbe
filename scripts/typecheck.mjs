import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import path from 'node:path';

const targets = ['backend', 'apps/live', 'apps/jury', 'apps/admin'];

// Sur Windows, `npm` est un fichier `npm.cmd` : sans ce correctif,
// `spawn('npm', ...)` échoue avec ENOENT et `npm run typecheck` était cassé.
const NPM_CMD = platform === 'win32' ? 'npm.cmd' : 'npm';
const SHELL = platform === 'win32';

function typecheck(target) {
  const cwd = path.resolve(target);
  return new Promise((resolve, reject) => {
    const child = spawn(NPM_CMD, ['run', 'typecheck'], {
      cwd,
      stdio: 'inherit',
      shell: SHELL,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Typecheck échoué dans ${target} (code ${code})`));
    });
  });
}

// Projets indépendants : vérification en parallèle, et on remonte la première
// erreur en indicating tous les projets fautifs.
const results = await Promise.allSettled(targets.map(typecheck));
const failed = results
  .map((r, i) => (r.status === 'rejected' ? targets[i] : null))
  .filter(Boolean);

if (failed.length > 0) {
  console.error(`\n[typecheck] ÉCHEC dans : ${failed.join(', ')}`);
  process.exit(1);
}

console.log('\n[typecheck] Tous les projets passent le typecheck.');
