/**
 * Reproduit fidelement le lost update sur le score d'un match.
 *
 * Contexte : POST /api/matches/:id/sscore fait, dans UNE transaction,
 *   INSERT INTO score_events (...)
 *   SELECT SUM(points) FROM score_events WHERE match_id = ?
 *   UPDATE matches SET score_a = <somme>
 *
 * Deux membres du jury qui attribuent des points sur deux equipes differentes
 * ont des cles anti-double-clic distinctes : les deux requetes passent et
 * s'executent en parallele.
 *
 * Question : la seconde transaction voit-elle le point insere par la premiere ?
 *
 * AUCUNE donnee de la competition n'est touchee : table jetable creee puis
 * supprimee, transactions annulees.
 */
import 'dotenv/config';
import { db } from '../src/db/index.ts';
import { sql } from 'drizzle-orm';

const M = 'audit_probe_lu';
let created = false;

async function main() {
  const iso = await db.execute(sql.raw('SHOW transaction_isolation'));
  console.log(`isolation level = ${iso.rows[0]?.transaction_isolation}`);
  console.log('');

  await db.execute(sql.raw(`
    DROP TABLE IF EXISTS ${M};
    CREATE TABLE ${M} (
      id integer PRIMARY KEY,
      score integer NOT NULL DEFAULT 0
    );
    CREATE TABLE ${M}_events (
      id serial PRIMARY KEY,
      team integer NOT NULL,
      points integer NOT NULL
    );
    INSERT INTO ${M} (id, score) VALUES (1, 0);
    INSERT INTO ${M}_events (team, points) VALUES (1, 0), (2, 0);
  `));
  created = true;

  /**
   * Barriere : garantit que les DEUX transactions ont insere leur evenement
   * avant que l'une ou l'autre ne calcule sa somme. Sans cela l'entrelacement
   * est aleatoire et le test ne prouve rien.
   */
  let waiting = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  /** Reproduit le corps de /score pour une equipe. */
  const score = async (team, label) => {
    const client = await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`INSERT INTO ${M}_events (team, points) VALUES (${team}, 10)`)
      );

      // Barriere : les deux INSERT sont passes, aucune transaction n'est encore
      // commitee. C'est le pire cas real, et c'est realisable : deux membres du
      // jury cliquent a quelques millisecondes d'ecart.
      waiting += 1;
      if (waiting === 2) release();
      await gate;

      // Somme dans le snapshot de la transaction : la ligne non commitee de
      // l'autre est INVISIBLE (MVCC, READ COMMITTED).
      const sum = await tx.execute(
        sql.raw(`SELECT COALESCE(SUM(points),0)::int AS s FROM ${M}_events`)
      );
      const total = sum.rows[0].s;
      await tx.execute(sql.raw(`UPDATE ${M} SET score = ${total} WHERE id = 1`));
      return total;
    });
    console.log(`  transaction ${label} : insere +10 (equipe ${team}), calcule score=${client}`);
    return client;
  };

  console.log('--- deux /score concurrents (equipes differentes => 2 cles distinctes) ---');
  const [a, b] = await Promise.all([score(1, 'A'), score(2, 'B')]);

  const final = await db.execute(sql.raw(`SELECT score FROM ${M} WHERE id = 1`));
  const events = await db.execute(
    sql.raw(`SELECT COALESCE(SUM(points),0)::int AS s FROM ${M}_events`)
  );
  const shown = final.rows[0].score;
  const truth = events.rows[0].s;

  console.log('');
  console.log(`  score calcule par A      : ${a}`);
  console.log(`  score calcule par B      : ${b}`);
  console.log(`  total REEL des evenements: ${truth}`);
  console.log(`  score AFFICHE (matches)  : ${shown}`);
  console.log('');

  if (shown < truth) {
    console.log(`  *** LOST UPDATE CONFIRME : ${truth - shown} point(s) journalise(s)`);
    console.log(`      dans ${M}_events mais absents du score affiche.`);
    console.log('      Le journal d\'audit est complet, l\'affichage est faux.');
  } else {
    console.log('  Aucun lost update observe sur cet essai.');
    console.log('  (l\'ordre d\'execution peut varier ; relancer pour confirmer)');
  }
}

let failure = null;
try {
  await main();
} catch (err) {
  failure = err;
  console.error('ERREUR:', err?.message ?? err);
  console.error('cause  :', err?.cause?.message ?? '(aucune)');
} finally {
  if (created) {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${M}_events; DROP TABLE IF EXISTS ${M};`)).catch(
      () => {}
    );
    console.log(`\ntables jetables supprimees (aucune donnee de competition touchee)`);
  }
}
process.exit(failure ? 1 : 0);
