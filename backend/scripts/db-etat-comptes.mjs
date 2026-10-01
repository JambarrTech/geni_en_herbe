/**
 * Etat des comptes existants.
 *
 * DIAGNOSTIC, PAS SCRIPT DE PRODUCTION
 * -----------------------------------
 * `db:seed:admin` REINITIALISE le mot de passe d'un compte existant (cf. le
 * `UPDATE` dans src/db/seed-admin.ts). Executer le script sans savoir si le
 * compte existe transformerait une simple verification en perte d'acces.
 *
 * On interroge donc la base en LECTURE SEULE avant de semer. Aucune ecriture,
 * aucun mot de passe : ce fichier ne peut pas modifier l'etat.
 */
import { Client } from 'pg';
import { config } from 'dotenv';

config();

const email = (process.env.SEED_ADMIN_EMAIL ?? 'jambarrtech@gmail.com')
  .trim()
  .toLowerCase();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});

await client.connect();

const { rows } = await client.query(
  `SELECT email, name, role, active,
          (password_hash IS NOT NULL) AS a_mot_de_passe,
          created_at
     FROM users
    WHERE lower(email) = $1`,
  [email]
);

if (rows.length === 0) {
  console.log(`Aucun compte pour ${email} : le seed CREERA le compte.`);
} else {
  const u = rows[0];
  console.log(`Compte trouve pour ${email} :`);
  console.log(`  nom           : ${u.name}`);
  console.log(`  role          : ${u.role}`);
  console.log(`  actif         : ${u.active}`);
  console.log(`  mot de passe  : ${u.a_mot_de_passe ? 'defini' : 'AUCUN'}`);
  console.log(`  cree le       : ${new Date(u.created_at).toISOString()}`);
  console.log('');
  console.log(
    u.a_mot_de_passe
      ? 'ATTENTION : le seed va REMPLACER ce mot de passe par celui fourni.'
      : 'Le seed va définir un mot de passe sur ce compte.'
  );
}

const total = await client.query(
  `SELECT count(*)::int AS n,
          count(*) FILTER (WHERE role = 'ADMIN' AND active)::int AS admins_actifs
     FROM users`
);
console.log('');
console.log(
  `Total comptes : ${total.rows[0].n} · administrateurs actifs : ${total.rows[0].admins_actifs}`
);

await client.end();