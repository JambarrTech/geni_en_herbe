import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';

/**
 * Colonnes que le code deployed exige et que seules les migrations ajoutent.
 *
 * POURQUOI CET INVENTAIRE EXISTE
 * -----------------------------
 * Le schéma et le code sont déployés séparément : l'API part sur Render, la base
 * vit sur Neon, et le seul moment où ils sont alignés est l'exécution d'une
 * migration. La fenêtre d'incohérence est réelle, et elle s'ouvre à chaque
 * livraison.
 *
 * Une colonne manquante ne se manifeste pas par une panne franche : PostgreSQL
 * refuse la requête, la route renvoie un 500 générique, et l'écran affiche
 * « Erreur lors de la création du match ». Aucun de ces messages ne dit qu'il
 * s'agit du schéma. On cherche alors du côté des données — un numéro de match,
 * une équipe, un nom — et le temps passe.
 *
 * Pire : le symptôme apparaît à l'USAGE. Une équipe peut venir d'être créée, un
 * match programmé sans incident, et c'est au milieu d'une rencontre que la
 * colonne manquante se fait connaître. Une competition qui s'arrête pour une
 * migration non appliquée n'est pas récupérable en direct.
 *
 * D'où ce contrôle : il s'exécute au démarrage, une fois, et nomme ce qui
 * manque. Le défaut est alors visible avant le concours, pas pendant.
 *
 * ET POURQUOI LA LISTE EST ÉCRITE À LA MAIN
 * ------------------------------------------
 * On pourrait demander à Drizzle de comparer `schema.ts` à la base et de déduire
 * l'écart. Ce serait plus élégant, mais faux dans les deux sens qui comptent :
 * il signalerait des tables volontairement absentes (voir l'en-tête de
 * `db/schema.ts` sur `schools`, déclarée sans migration) et ne distinguerait pas
 * une colonne oubliée d'une colonne ajoutée puis retirée. Ici, seule compte la
 * liste de ce que le code lit réellement.
 *
 * Une entrée manquante fait échouer la vérification — c'est le rappel à
 * maintenir l'inventaire à jour, et il est visible au relecture d'un diff.
 */
export const REQUIRED_COLUMNS: readonly { table: string; column: string; since: string }[] = [
  { table: 'sessions', column: 'token_hash', since: '0003_sessions_table' },
  { table: 'sessions', column: 'expires_at', since: '0003_sessions_table' },
  { table: 'matches', column: 'broadcast_stage', since: '0004_broadcast_stage' },
  { table: 'matches', column: 'broadcast_roster_until', since: '0005_broadcast_roster_until' },
  { table: 'matches', column: 'diffused_score_event_id', since: '0009_diffused_score' },
  { table: 'questions', column: 'position', since: '0010_question_position' },
  { table: 'categories', column: 'position', since: '0008_category_position' },
];

/**
 * Colonnes requises mais absentes de la base.
 *
 * Une seule requête, quel que soit le nombre de colonnes vérifiées : le contrôle
 * tourne au démarrage d'un process qui peut démarrer plusieurs fois, et une
 * requête par colonne transformerait une vérification gratuite en attente réseau.
 *
 * `information_schema.columns` est posé par PostgreSQL sur toutes ses bases et
 * pose moins de souci de droits que `pg_catalog` pour un utilisateur applicatif.
 */
export async function findMissingColumns(
  required: readonly { table: string; column: string; since: string }[] = REQUIRED_COLUMNS
): Promise<{ table: string; column: string; since: string }[]> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (${sql.join(
        required.map((r) => sql`${r.table}`),
        sql`, `
      )})
  `);

  const present = new Set(rows.rows.map((r) => `${r.table_name}.${r.column_name}`));
  return required.filter((r) => !present.has(`${r.table}.${r.column}`));
}

/**
 * Phrase de diagnostic, ou `null` si tout est là.
 *
 * `null` plutôt qu'une chaîne vide : l'appelant teste la présence, et « aucune
 * anomalie » doit se lire dans le code, pas dans une comparaison.
 */
export function describeMissingColumns(
  missing: readonly { table: string; column: string; since: string }[]
): string | null {
  if (missing.length === 0) return null;

  const liste = missing.map((m) => `${m.table}.${m.column} (migration ${m.since})`).join(', ');
  // L'accord est fait pour de bon, pas neutralisé par « manquante(s) » : un
  // message qui finit par « (s) » se remarque, et dans une salle de concours on
  // lit des messages d'erreur en diagonale. C'est le genre de détail qui inspire
  // moins confiance dans le reste du message.
  const pluriel = missing.length > 1;
  return (
    `Base de données en retard sur le code : ${missing.length} ` +
    `${pluriel ? 'colonnes' : 'colonne'} manquante${pluriel ? 's' : ''} — ${liste}. ` +
    'Aucune donnée n\'est en cause. Depuis le dossier backend/, exécutez ' +
    '`npm run db:migrate`, puis redémarrez.'
  );
}
