/**
 * Applique les migrations SQL à la base, sans `drizzle-kit`.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * Les migrations étaient appliquées à la main, après le déploiement. Ce
 * fonctionnement a échoué deux fois de suite (`0004_broadcast_stage`, puis
 * `0005_broadcast_roster_until`) : le code était déployé, la colonne n'existait
 * pas, et chaque écran de l'application renvoyait un 500 sans cause.
 *
 * Le remède n'est pas de mieux prévenir, mais d'inverser l'ordre : appliquer le
 * schéma AVANT de déployer le code qui le lit. Executé dans le `buildCommand`,
 * ce script fait echouer le deploiement si la migration echoue — donc
 * l'ancienne version, qui fonctionne, reste en ligne. On ne peut plus livrer du
 * code qui lit une colonne absente.
 *
 * POURQUOI PAS `drizzle-kit migrate`
 * ---------------------------------
 * `drizzle-kit` est une `devDependency`, et Render pose `NODE_ENV=production` :
 * le `npm ci --prefix backend` du build l'omet. L'appliquer au deploiement
 * imposait donc d'installer les dependances de developpement en production, pour
 * un outil dont le moteur est deja present.
 *
 * `drizzle-orm` est en `dependencies`, et `drizzle-orm/node-postgres/migrator`
 * fait exactement le meme travail : lit `drizzle/meta/_journal.json`, joue les
 * fichiers SQL dans l'ordre, et enregistre chacun dans
 * `drizzle.__drizzle_migrations`. Un seul_script, une seule dependance, aucun
 * alourdissement de l'image.
 *
 * `db:migrate` pointe sur ce script : il n'y a donc qu'UN chemin de migration,
 * pas deux qui pourraient diverger.
 *
 * LA CONNEXION EST CELLE DE L'APPLICATION, PAS CELLE DE `drizzle.config.ts`
 * -----------------------------------------------------------------------
 * On réutilise le pool de `db/index.ts`, volontairement. Cela aligne le chemin
 * de migration sur le chemin d'exécution : si la validation stricte du
 * certificat TLS échoue ici, elle échouerait aussi pour l'API, et un
 * deploiement qui refuse de migrer est alors exactement le comportement voulu.
 *
 * (C'est aussi plus strict que `drizzle.config.ts`, qui passe `ssl: true` —
 * que `pg` traduit en `rejectUnauthorized: false`.)
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

dotenv.config();

// Import dynamique, et statique seulement pour `dotenv` : les imports sont
// hoistés, donc un import statique du pool serait évalué AVANT que
// `dotenv.config()` ait pu lire le `.env`, et le script retomberait sur les
// valeurs par defaut (localhost).
const { createPool } = await import('./index.ts');
const { drizzle } = await import('drizzle-orm/node-postgres');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');

// Résolu depuis l'emplacement du fichier, pas depuis le cwd : le build lance ce
// script depuis `backend/`, mais un lancement depuis la racine doit donner le
// même résultat.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Nom de la base visée, pour le journal uniquement.
 *
 * `new URL` lève sur une valeur malformée, et une ligne d'affichage ne doit pas
 * être la cause de l'échec : le message utile sur une `DATABASE_URL` invalide
 * vient de la tentative de connexion, pas d'ici. La valeur brute est alors
 * montrée telle quelle — c'est elle qu'il faut corriger.
 */
function describeCible() {
  if (process.env.DATABASE_URL) {
    try {
      return new URL(process.env.DATABASE_URL).host;
    } catch {
      return `${process.env.DATABASE_URL} (URL illisible — à vérifier)`;
    }
  }

  const pieces = [
    process.env.SQL_HOST && `hote ${process.env.SQL_HOST}`,
    process.env.SQL_DB_NAME && `base ${process.env.SQL_DB_NAME}`,
  ].filter(Boolean);

  return pieces.length > 0 ? pieces.join(', ') : '(aucune)';
}

const cible = describeCible();

async function main() {
  if (!process.env.DATABASE_URL && !process.env.SQL_HOST) {
    throw new Error(
      'Aucune base cible : ni DATABASE_URL ni SQL_HOST ne sont définis. ' +
        "Les migrations ne peuvent pas s'appliquer sans savoir où aller."
    );
  }

  console.log(`[migrate] base cible : ${cible}`);
  console.log(`[migrate] dossier   : ${migrationsFolder}`);

  const pool = createPool();
  const db = drizzle(pool);

  // `migrate` journalise « applied N migrations » et n'écrit rien si la base est
  // déjà à jour. Il lève si une migration échoue : on laisse remonter, pour que
  // `npm` rende un code de sortie non nul et que le build Render échoue.
  await migrate(db, { migrationsFolder });

  const { rows: appliquees } = await pool.query(
    'SELECT count(*)::int AS total FROM drizzle.__drizzle_migrations'
  );
  console.log(`[migrate] migrations enregistrées dans la base : ${appliquees[0].total}`);

  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] ECHEC — le déploiement doit être interrompu :', err);
  process.exit(1);
});