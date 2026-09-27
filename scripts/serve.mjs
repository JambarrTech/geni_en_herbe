import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Lance les quatre processus de l'backend AEERKS en parallèle.
 *
 *   API     -> API_PORT     (ou PORT)   4000 par défaut
 *   WS      -> WS_PORT      4001
 *   WORKER  -> WORKER_PORT  4002
 *   STATIC  -> STATIC_PORT  4003
 *
 * Usage :
 *   npm run serve            les 4 processus
 *   npm run serve -- api ws  une sélection
 *
 * Arrêt : Ctrl+C termine proprement le groupe (SIGTERM puis SIGKILL).
 */

const NPM_CMD = platform === 'win32' ? 'npm.cmd' : 'npm';
const SHELL = platform === 'win32';

const ALL = [
  { name: 'api', script: 'start:api', color: 36 },
  { name: 'ws', script: 'start:ws', color: 35 },
  { name: 'worker', script: 'start:worker', color: 33 },
  { name: 'static', script: 'start:static', color: 32 },
];

const requested = process.argv.slice(2);
const targets = requested.length
  ? ALL.filter((t) => requested.includes(t.name))
  : ALL;

if (requested.length && targets.length !== requested.length) {
  const unknown = requested.filter((r) => !ALL.some((t) => t.name === r));
  console.error(
    `[serve] Cible inconnue : ${unknown.join(', ')}. Disponibles : ${ALL.map((t) => t.name).join(', ')}`
  );
  process.exit(1);
}

const useColor = process.stdout.isTTY;
const paint = (color, text) => (useColor ? `[${color}m${text}[0m` : text);

const children = [];
let stopping = false;

console.log(
  `[serve] Démarrage de ${targets.length} processus : ${targets.map((t) => t.name).join(', ')}`
);
console.log('[serve] Ctrl+C pour tout arrêter.\n');

for (const target of targets) {
  const child = spawn(NPM_CMD, ['run', target.script], {
    cwd: path.resolve('backend'),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: SHELL,
    env: process.env,
  });

  children.push({ ...target, child });

  const relay = (stream, isError) => {
    readline.createInterface({ input: stream }).on('line', (line) => {
      const prefix = paint(target.color, `[${target.name}]`.padEnd(8));
      (isError ? process.stderr : process.stdout).write(`${prefix} ${line}\n`);
    });
  };
  relay(child.stdout, false);
  relay(child.stderr, true);

  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(
      paint(target.color, `[serve] ${target.name} s'est arrêté `) +
        `(${signal ? `signal ${signal}` : `code ${code}`}).`
    );
    stopAll(1);
  });
}

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\n[serve] Arrêt de tous les processus…');
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      try {
        if (platform === 'win32') child.kill('SIGTERM');
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* déjà arrêté */
      }
    }
  }
  // Filet : ce qui refuse le SIGTERM finit en SIGKILL.
  setTimeout(() => {
    for (const { child } of children) {
      try {
        if (child.exitCode === null) {
          if (platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        /* déjà arrêté */
      }
    }
    process.exit(exitCode);
  }, 4000).unref();
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
