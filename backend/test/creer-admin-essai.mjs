/**
 * Cree un compte d'administration pour l'essai manuel dans le navigateur.
 *
 * Usage :
 *   ESSAI_PASSWORD='un-mot-de-passe' node --import tsx test/creer-admin-essai.mjs
 *
 * Suppression apres usage :
 *   node --import tsx test/creer-admin-essai.mjs --supprimer
 *
 * Pourquoi ce script existe
 * -------------------------
 * La base de developpement ne contient aucun compte : sans celui-ci, impossible
 * de verifier dans le navigateur que les dialogues de confirmation, la navigation
 * et le rendu s'affichent reellement. Les tests unitaires ne remplacent pas
 * cette verification — ils ne voient pas ce qui s'affiche.
 *
 * Le mot de passe est EXIGE, sans valeur par defaut. Un script versionne qui
 * cree un compte avec un mot de passe connu invite a le laisser en place, et il
 * resterait alors un acces administrateur permanent a la competition. mieux
 * vaut une commande qui echoue bruyamment qu'un piege discret.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { db } from '../src/db/index.ts';
import { users } from '../src/db/schema.ts';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../src/lib/password.ts';

const EMAIL = process.env.ESSAI_EMAIL ?? 'essai@aeerks.local';
const PASSWORD = process.env.ESSAI_PASSWORD;
const NOM = process.env.ESSAI_NOM ?? 'Comite essai';
const suppression = process.argv.includes('--supprimer');

// --- Suppression ------------------------------------------------------------
if (suppression) {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, EMAIL));
  if (existing.length === 0) {
    console.log(`Aucun compte de test a l'adresse ${EMAIL}.`);
  } else {
    for (const u of existing) await db.delete(users).where(eq(users.id, u.id));
    console.log(`Compte de test supprime : ${EMAIL}`);
  }
  process.exit(0);
}

// --- Creation ---------------------------------------------------------------
if (!PASSWORD) {
  console.error('ESSAI_PASSWORD est obligatoire. Aucun mot de passe par defaut.');
  console.error('');
  console.error('  ESSAI_PASSWORD=... node --import tsx test/creer-admin-essai.mjs');
  console.error('');
  console.error('Ce script cree un compte ADMINISTRATEUR. Supprimez-le apres usage :');
  console.error('  node --import tsx test/creer-admin-essai.mjs --supprimer');
  process.exit(1);
}

const existing = await db
  .select({ id: users.id })
  .from(users)
  .where(eq(users.email, EMAIL))
  .limit(1);

if (existing.length > 0) {
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(PASSWORD), active: true, role: 'ADMIN' })
    .where(eq(users.id, existing[0].id));
  console.log(`Compte de test mis a jour : ${EMAIL}`);
} else {
  await db.insert(users).values({
    uid: `essai_${randomUUID()}`,
    name: NOM,
    email: EMAIL,
    role: 'ADMIN',
    passwordHash: await hashPassword(PASSWORD),
    active: true,
  });
  console.log(`Compte de test cree : ${EMAIL}`);
}

console.log('');
console.log('Pensez a le supprimer apres usage :');
console.log('  node --import tsx test/creer-admin-essai.mjs --supprimer');
