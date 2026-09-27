/**
 * Verifie de bout en bout que la CONNEXION fonctionne avec scrypt asynchrone.
 *
 * Pourquoi ce test existe
 * -----------------------
 * Un 401 sur un email inexistant ne prouve rien : le code court-circuite avant
 * d'appeler scrypt (`user?.passwordHash` est undefined). Le passage à la
 * version asynchrone aurait donc pu casser la vérification d'un mot de passe
 * sans qu'aucun test ne le remarque — le test unitaire couvre la fonction, ce
 * test couvre le CÂBLAGE (route -> base -> scrypt -> session).
 *
 * Ce qu'il contrôle
 * -----------------
 *  1. un compte inséré avec l'ancien `scryptSync` peut se connecter
 *     (compatibilité des mots de passe déjà en base) ;
 *  2. un compte inséré avec `hashPassword` asynchrone peut se connecter ;
 *  3. un bon mot de passe donne 200 + jeton, un mauvais donne 401 ;
 *  4. le jeton obtenu fonctionne ensuite sur une route protégée.
 *
 * Le compte est SUPPRIMÉ en sortie. Aucune donnée de compétition n'est touchée :
 * on ne fait que créer puis effacer une ligne de test.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { scryptSync, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.ts';
import { users } from '../src/db/schema.ts';
import { hashPassword } from '../src/lib/password.ts';

const BASE = process.env.API_BASE ?? 'http://localhost:4000';
const MOT_DE_PASSE = 'mot-de-passe-ephemere-42';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'OK   ' : 'ECHEC'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
};

/** Connexion ; renvoie le code et le corps JSON. */
async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* pas du JSON */
  }
  return { status: res.status, body };
}

const credues = [];

async function creerCompte(email, passwordHash) {
  const uid = `test_${randomUUID()}`;
  const [row] = await db
    .insert(users)
    .values({
      uid,
      name: 'Compte de test',
      email,
      role: 'ADMIN',
      passwordHash,
      active: true,
    })
    .returning({ id: users.id, email: users.email });
  credues.push(row.id);
  return row;
}

let cleanupNeeded = false;
try {
  // --- 1. Compte au format ANCIEN (scryptSync) -----------------------------
  const selAncien = randomBytes(16).toString('hex');
  const ancienHash = `${selAncien}:${scryptSync(MOT_DE_PASSE, selAncien, 64).toString('hex')}`;
  const emailAncien = `ancien.${randomUUID()}@aeerks.test`;
  await creerCompte(emailAncien, ancienHash);
  cleanupNeeded = true;

  console.log('Connexion de bout en bout, scrypt asynchrone\n');
  console.log('A) compte au format ANCIEN (scryptSync)');

  const r1 = await login(emailAncien, MOT_DE_PASSE);
  check('connexion acceptee', r1.status === 200, `HTTP ${r1.status}`);
  const jetonAncien = r1.body?.token;
  check('un jeton de session est delivre', typeof jetonAncien === 'string' && jetonAncien.length > 20);
  check(
    'le message d erreur ne divulgue rien',
    !JSON.stringify(r1.body ?? {}).match(/scrypt|hash|stack|at Object/i)
  );

  const mauvais = await login(emailAncien, 'mauvais-mot-de-passe');
  check('mauvais mot de passe refuse', mauvais.status === 401, `HTTP ${mauvais.status}`);

  // --- 2. Le jeton fonctionne sur une route protégée -----------------------
  console.log('\nB) le jeton obtenu sert sur une route protegee');
  const protege = await fetch(`${BASE}/api/users`, {
    headers: { Authorization: `Bearer ${jetonAncien}` },
  });
  check('GET /api/users accepte le jeton', protege.status === 200, `HTTP ${protege.status}`);

  const sansJeton = await fetch(`${BASE}/api/users`);
  check('sans jeton, toujours 401', sansJeton.status === 401, `HTTP ${sansJeton.status}`);

  // --- 3. Compte au format NOUVEAU (async) ---------------------------------
  console.log('\nC) compte au format NOUVEAU (hashPassword asynchrone)');
  const emailNouveau = `nouveau.${randomUUID()}@aeerks.test`;
  await creerCompte(emailNouveau, await hashPassword(MOT_DE_PASSE));
  const r2 = await login(emailNouveau, MOT_DE_PASSE);
  check('connexion acceptee', r2.status === 200, `HTTP ${r2.status}`);
  check('jeton delivre', typeof r2.body?.token === 'string');

  // --- 4. Le rate-limit.login n'empeche pas une connexion legitime ----------
  console.log('\nD) trois connexions legitimes d affilee');
  for (let i = 0; i < 3; i += 1) {
    const r = await login(emailNouveau, MOT_DE_PASSE);
    check(`connexion ${i + 1}/3`, r.status === 200, `HTTP ${r.status}`);
  }
} catch (err) {
  console.error('ERREUR:', err?.message ?? err);
  failures += 1;
} finally {
  if (cleanupNeeded) {
    for (const id of credues) {
      await db.delete(users).where(sql`${users.id} = ${id}`).catch(() => {});
    }
    console.log('\ncomptes de test supprimes');
  }
}

console.log(failures === 0 ? '\nOK : connexion operationnelle de bout en bout.' : `\n${failures} ECHEC(S).`);
process.exit(failures === 0 ? 0 : 1);
