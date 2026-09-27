import { spawn } from 'node:child_process';
import { platform } from 'node:process';

const cwd = process.cwd();

// Port unique du backend : surchargeable via BACKEND_PORT (ou PORT).
// 4000 doit rester aligné sur CONFIG.PORT_DEFAULT (backend/src/config.ts).
const BACKEND_PORT = process.env.BACKEND_PORT || process.env.PORT || '4000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${BACKEND_PORT}`;

// Sur Windows, npm est un fichier .cmd
const NPM_CMD = platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [];

function run(name, target, extraEnv = {}) {
  const isWindows = platform === 'win32';
  const child = spawn(NPM_CMD, ['run', 'dev'], {
    cwd: target,
    stdio: 'inherit',
    detached: true,
    shell: isWindows, // Nécessaire sur Windows pour exécuter les .cmd
    env: { ...process.env, ...extraEnv },
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[${name}] s'est arrêté avec le code ${code}`);
    }
  });
  children.push(child);
  return child;
}

async function waitForBackend(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/health`);
      if (res.ok) return true;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

console.log('[dev] Démarrage du backend (API + WebSocket)...');
run('backend', 'backend', { PORT: BACKEND_PORT });

if (!(await waitForBackend())) {
  console.error(`\n[dev] Backend injoignable sur ${BACKEND_URL}.`);
  console.error(`  - Port déjà occupé par un autre processus ?`);
  console.error(`    Vérifier avec : lsof -i :${BACKEND_PORT}`);
  console.error(`  - Autre port voulu ? Relancer avec : BACKEND_PORT=XXXX npm run dev`);
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* déjà terminé */
    }
  }
  process.exit(1);
}

console.log('[dev] Backend prêt — lancement des trois apps frontend...');
console.log(`[dev]   API     -> ${BACKEND_URL}`);
console.log('[dev]   Live    -> http://localhost:5173 (écran public)');
console.log('[dev]   Jury    -> http://localhost:5174 (espace jury)');
console.log('[dev]   Admin   -> http://localhost:5175 (administration)');

run('live', 'apps/live', { BACKEND_URL });
run('jury', 'apps/jury', { BACKEND_URL });
run('admin', 'apps/admin', { BACKEND_URL });

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[dev] Arrêt (${signal}) — fermeture des processus...`);
  for (const child of children) {
    try {
      // Le processus est lancé en groupe (detached) : on tue tout le groupe
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* déjà terminé */
      }
    }
  }
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));