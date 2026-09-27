/**
 * Test de securite du serveur statique : la normalisation d'URL est faite par
 * le CLIENT. `fetch('/../../backend/.env')` est reecrit en `/backend/.env`
 * AVANT d'atteindre le serveur : tester ainsi ne prouve rien sur la garde
 * serveur, qui elle-meme recoit un chemin deja normalise.
 *
 * On ecrit donc la requete HTTP a la main, sur une socket brute, pour envoyer
 * un chemin reellement non normalise, et on verifie que la garde du serveur
 * (resolution confinee au dossier dist) tient.
 */
import net from 'node:net';

const HOST = '127.0.0.1';
const PORT = 4003;
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'OK   ' : 'ECHEC'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
}

/** Requete HTTP brute : le chemin est envoye tel quel, sans normalisation. */
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: ${HOST}:${PORT}\r\n` +
          'Connection: close\r\n' +
          '\r\n'
      );
    });
    let buf = '';
    sock.setTimeout(10000, () => {
      sock.destroy();
      reject(new Error('delai depasse'));
    });
    sock.on('data', (d) => {
      buf += d.toString();
    });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

/** Indices de fuite : contenu qu'on ne doit JAMAIS voir dans une reponse. */
const SECRETS = [
  'DATABASE_URL',
  'SQL_PASSWORD',
  'FIREBASE',
  'AIza',
  'connectionString',
];

const PATHS = [
  '/../backend/.env',
  '/../../backend/.env',
  '/../../../../etc/passwd',
  '/%2e%2e%2fbackend%2f.env',
  '/%2e%2e/%2e%2e/backend/.env',
  '/jury/../../backend/.env',
  '/admin/../../../backend/.env',
  '//..//..//backend/.env',
  '/....//backend/.env',
];

console.log('Traversee de repertoire — requete HTTP brute, chemin non normalise\n');

for (const p of PATHS) {
  let body = '';
  let status = 0;
  try {
    const res = await rawGet(p);
    const sep = res.indexOf('\r\n\r\n');
    const head = sep >= 0 ? res.slice(0, sep) : res;
    body = sep >= 0 ? res.slice(sep + 4) : '';
    status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  } catch (err) {
    check(`${p.padEnd(30)}`, false, err.message);
    continue;
  }

  const leaked = SECRETS.filter((s) => body.includes(s));
  // 200 est acceptable SEULEMENT si la reponse est le shell SPA (pas le .env).
  const isSpaShell = body.includes('<div id="root">');
  const ok = leaked.length === 0 && (status !== 200 || isSpaShell);
  check(
    `${p.padEnd(30)}`,
    ok,
    `HTTP ${status}${leaked.length ? ' FUITE: ' + leaked.join(',') : ''}${
      status === 200 && isSpaShell ? ' (shell SPA)' : ''
    }`
  );
}

console.log(
  failures === 0
    ? '\nOK : aucune fuite hors du dossier dist.'
    : `\n${failures} ECHEC(S).`
);
process.exit(failures === 0 ? 0 : 1);
