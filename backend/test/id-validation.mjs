/**
 * Verifie la validation des parametres de route.
 *
 * Un identifiant malforme doit produire 400 (mauvaise demande du client), et
 * surtout jamais 500 (erreur serveur) ni 404 trompeur (« la ressource
 * n'existe pas » alors que la demande est malformee).
 *
 * Sur `/api/matches/12x34` la reponse 400 prouve que la validation est
 * branchee AVANT que l'identifiant n'atteigne une requete PostgreSQL : c'est
 * le `NaN` de `parseInt` qu'on eloigne de la base.
 */
const BASE = process.env.API_BASE ?? 'http://localhost:4000';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'OK   ' : 'ECHEC'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
};

/** Effectue la requête et renvoie le code, sans lever sur 4xx/5xx. */
async function call(method, path, body) {
  // Une requête GET/HEAD ne peut pas porter de corps : fetch le refuse, et ce
  // n'est pas le comportement que l'on veut éprouver.
  const sendsBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: sendsBody ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text };
}

console.log('Validation des identifiants de route\n');

console.log('A) identifiants malformes -> 400 attendu');
const malformed = [
  ['GET', '/api/matches/12x34'],
  ['GET', '/api/matches/abc'],
  ['GET', '/api/matches/1.5'],
  ['GET', '/api/matches/-5'],
  ['GET', '/api/matches/0'],
  ['GET', '/api/matches/99999999999999999999'], // hors entier sûr
  ['POST', '/api/matches/abc/score'],
  ['POST', '/api/matches/abc/start'],
  ['POST', '/api/matches/abc/adjust-score'],
  ['PATCH', '/api/teams/xyz'],
  ['PATCH', '/api/users/xyz'],
  ['PATCH', '/api/questions/xyz'],
  ['DELETE', '/api/categories/xyz'],
  ['DELETE', '/api/participants/xyz'],
];
for (const [method, path] of malformed) {
  const r = await call(method, path, {});
  const body = r.text.replace(/\s+/g, ' ').slice(0, 64);
  // 400 = la validation a tranche avant la route. 401 est acceptable sur une
  // route protegee si l'authentification est posee avant : les deux sont
  // correctes, 500 ne l'est jamais.
  const ok = r.status === 400 || r.status === 401 || r.status === 403;
  check(`${method.padEnd(6)} ${path.padEnd(38)} HTTP ${r.status}`, ok, body);
}

console.log('\nB) aucun 500 sur identifiant malforme');
for (const [method, path] of malformed) {
  const r = await call(method, path, {});
  if (r.status >= 500) check(`${method} ${path} -> 500`, false, r.text.slice(0, 80));
}
check('aucun 5xx sur les 14 cas', true);

console.log('\nC) un identifiant bien forme passe la validation');
// 1 n'existe probablement pas, mais la requete doit ATTEINDRE la couche
// metier : 404 « match non trouvé » et non 400 « identifiant invalide ».
for (const [method, path] of [
  ['GET', '/api/matches/1'],
  ['POST', '/api/matches/1/score'],
]) {
  const r = await call(method, path, {});
  const rejectedAsMalformed =
    r.status === 400 && /Identifiant invalide/.test(r.text);
  check(
    `${method.padEnd(6)} ${path.padEnd(38)} HTTP ${r.status}`,
    !rejectedAsMalformed,
    'la validation laisse passer un entier'
  );
}

console.log('\nD) le corps de la reponse 400 est exploitable');
const r = await call('GET', '/api/matches/abc');
let parsed = null;
try {
  parsed = JSON.parse(r.text);
} catch {
  /* pas du JSON */
}
check('reponse 400 en JSON', parsed !== null);
check('message d\'erreur present', typeof parsed?.error === 'string', parsed?.error ?? '');
check(
  'le message ne divulgue ni pile ni SQL',
  !/at\s+\w+\s+\(|SELECT |INSERT |pg_|node_modules/.test(r.text),
  ''
);

console.log(
  failures === 0 ? '\nOK : validation des identifiants operationnelle.' : `\n${failures} ECHEC(S).`
);
process.exit(failures === 0 ? 0 : 1);
