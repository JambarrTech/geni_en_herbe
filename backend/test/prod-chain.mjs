/**
 * Verifie la chaine complete de production :
 *   navigateur -> 4003 (statique) -> proxy /ws  -> 4001 (diffusion)
 *                          -> proxy /api -> 4000 (API)
 *
 * C'est le scenario reellement rencontre apres la separation des serveurs. En
 * developpement, Vite joue le role de reverse proxy et le defaut resterait
 * invisible ; ce test vise donc le chemin de production.
 */
import { WebSocket } from 'ws';

const STATIC = 'http://127.0.0.1:4003';
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'OK   ' : 'ECHEC'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
}

function openWs(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:4003${path}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('delai depasse'));
    }, 12000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

console.log('A) WebSocket public a travers 4003 -> proxy -> 4001');
try {
  const ws = await openWs('/ws');
  const msg = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pas de message')), 10000);
    ws.on('message', (d) => {
      clearTimeout(t);
      resolve(JSON.parse(d.toString()));
    });
  });
  check('connexion etablie via le port statique', true);
  check('message "connected" recu', msg.type === 'connected', JSON.stringify(msg));
  check('flux public non authentifie', msg.authenticated === false);
  ws.close();
} catch (err) {
  check('connexion via 4003', false, err.message);
}

console.log('\nB) Jeton invalide : refus attendu');
try {
  const ws = await openWs('/ws?token=jeton-bidon');
  const code = await new Promise((resolve) => {
    ws.on('close', (c) => resolve(c));
    setTimeout(() => resolve(0), 8000);
  });
  check('refuse avec le code 1008', code === 1008, `code recu ${code}`);
} catch (err) {
  check('refus du jeton invalide', false, err.message);
}

console.log('\nC) API relayee par le port statique');
for (const p of ['/api/health', '/api/live', '/api/rankings']) {
  try {
    const r = await fetch(`${STATIC}${p}`);
    check(`GET ${p}`, r.ok, `HTTP ${r.status}`);
  } catch (err) {
    check(`GET ${p}`, false, err.message);
  }
}

console.log('\nD) Une route protegee reste protegee a travers le proxy');
try {
  const r = await fetch(`${STATIC}/api/users`);
  check('GET /api/users sans jeton -> 401', r.status === 401, `HTTP ${r.status}`);
} catch (err) {
  check('GET /api/users', false, err.message);
}

// Note : la traversée de repertoire est verifiee ailleurs, en requete HTTP
// brute (test/static-traversal.mjs). `fetch` normalise l'URL AVANT l'envoi,
// donc `fetch('/../../backend/.env')` atteint le serveur sous la forme
// `/backend/.env` et ne prouve rien sur la garde serveur. Ici on se contente
// de verifier qu'aucun secret ne fuit dans le corps reecu.
console.log('\nE) Aucun secret dans les reponses du proxy');
for (const p of ['/', '/api/health', '/api/live']) {
  try {
    const body = await (await fetch(`${STATIC}${p}`)).text();
    const leaked = ['DATABASE_URL', 'SQL_PASSWORD', 'AIza'].filter((s) => body.includes(s));
    check(`aucune fuite sur ${p}`, leaked.length === 0, leaked.join(','));
  } catch (err) {
    check(`lecture ${p}`, false, err.message);
  }
}

console.log(failures === 0 ? '\nOK : chaine de production operationnelle.' : `\n${failures} ECHEC(S).`);
process.exit(failures === 0 ? 0 : 1);
