/**
 * Verifie que la diffusion traverse REELLEMENT deux processus.
 *
 * Avant la separation, le serveur WS recevait les evenements par un rappel en
 * memoire installe dans le meme process que l'API. Ce rappel ne peut pas
 * traverser une frontiere de processus : il faut donc bel et bien que le bus
 * PostgreSQL LISTEN/NOTIFY prenne le relais.
 *
 * Ce test publie sur le canal depuis ce process, ecoute sur le meme canal, et
 * verifie que l'evenement arrive. Puis il repete l'ecoute dans un process
 * ENFANT (node) pour prouver que la frontiere de processus est franchie.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { subscribe, publish } from '../src/server/pubsub.ts';

const ECHO = 'echo-please';

function listenOnce(timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(v);
    };
    const unsubscribe = subscribe((e) => {
      if (e.type === ECHO) finish(e.data);
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

// --- 1. Lecture / ecriture sur le canal -----------------------------------
console.log('1) publication + reception sur le canal PostgreSQL');
const listening = listenOnce();
await new Promise((r) => setTimeout(r, 800)); // laisse le LISTEN s'etablir
await publish({ type: ECHO, data: { hello: 'bus' } });
const direct = await listening;
console.log('   recu :', JSON.stringify(direct));
console.log('   ->', direct ? 'OK' : 'ECHEC');

// --- 2. Reception dans un PROCESSUS ENFANT -------------------------------
console.log('\n2) emission depuis ce process, reception dans un process ENFANT');
const child = spawn(
  process.execPath,
  ['--import', 'tsx', '-e', `
    import { subscribe } from './src/server/pubsub.ts';
    const off = subscribe((e) => {
      if (e.type !== '${ECHO}') return;
      process.stdout.write('CHILD_RECEIVED:' + JSON.stringify(e.data) + '\\n');
      off();
      process.exit(0);
    });
    setTimeout(() => { process.stdout.write('CHILD_TIMEOUT\\n'); process.exit(2); }, 15000);
  `],
  {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  }
);

let childOut = '';
child.stdout.on('data', (d) => {
  childOut += d.toString();
  if (childOut.includes('CHILD_RECEIVED') || childOut.includes('CHILD_TIMEOUT')) {
    setTimeout(() => child.kill(), 200);
  }
});

await new Promise((r) => setTimeout(r, 4000)); // le LISTEN de l'enfant s'etablit
await publish({ type: ECHO, data: { from: 'parent', to: 'child' } });

await new Promise((r) => {
  const t = setTimeout(r, 16000);
  child.on('exit', () => {
    clearTimeout(t);
    r();
  });
});

console.log('   sortie enfant :', childOut.trim() || '(rien)');
const crossed = childOut.includes('CHILD_RECEIVED');
console.log('   ->', crossed ? 'OK : la diffusion franchit bien la frontiere de processus' : 'ECHEC');

process.exit(direct && crossed ? 0 : 1);
