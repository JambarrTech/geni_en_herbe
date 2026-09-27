/**
 * Verifie que le verrou de ligne corrige le lost update sur le score.
 *
 * Ce fichier est lePendant de `probe-lost-update.mjs`, qui prouve le DEFAUT.
 * Ici on rejoue EXACTEMENT le meme scenario deux fois :
 *
 *   variante « sans verrou »  -> reproduit le bug historique
 *   variante « avec verrou »  -> le comportement apres le correctif
 *
 * Comparer les deux dans un meme run demontre que le verrou de ligne est bien la
 * cause du correctif, et pas une coincidence d'ordonnancement.
 *
 * AUCUNE donnee de la competition n'est touchee : tables jetables creees puis
 * supprimees en sortie, transactions annulees.
 */
import 'dotenv/config';
import { db } from '../src/db/index.ts';
import { sql } from 'drizzle-orm';

const M = 'audit_probe_lu';
let created = false;

const reset = () =>
  db.execute(
    sql.raw(`
      TRUNCATE ${M}_events;
      TRUNCATE ${M};
      INSERT INTO ${M} (id, score) VALUES (1, 0);
    `)
  );

const truth = async () => {
  const events = await db.execute(
    sql.raw(`SELECT COALESCE(SUM(points),0)::int AS s FROM ${M}_events`)
  );
  const shown = await db.execute(sql.raw(`SELECT score FROM ${M} WHERE id = 1`));
  return { shown: shown.rows[0].score, truth: events.rows[0].s };
};

/**
 * Deux transactions concurrentes, chacune insere +10 pour une equipe differente
 * puis recalcule le score depuis le journal — exactement le corps de
 * POST /api/matches/:id/score.
 *
 * @param lock true pour prendre `SELECT ... FOR UPDATE` sur la ligne du match
 *             avant toute ecriture (le correctif applique).
 * @returns les totaux vus par chaque transaction, et l'etat final.
 */
async function concurrentScoring(lock) {
  await reset();

  /**
   * Barriere : garantit que les DEUX transactions ont insere leur evenement
   * avant que l'une ou l'autre ne calcule sa somme.
   *
   * Elle n'est appliquee qu'a la variante SANS verrou. Avec le verrou, la
   * seconde transaction BLOQUE sur `FOR UPDATE` et n'atteint jamais la
   * barriere : la poser provoquerait un interblocage, pas un test.
   *
   * C'est justement la difference qui distingue les deux variantes :
   *  - sans verrou, l'entrelacement qui perd des points EST REACHABLE ;
   *  - avec verrou, il est structurellement impossible, whatever le scheduler.
   */
  let waiting = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  const computed = [];

  const score = async (team) =>
    db.transaction(async (tx) => {
      // Le correctif : serialiser les recalculs sur la ligne du match.
      if (lock) {
        await tx.execute(sql.raw(`SELECT id FROM ${M} WHERE id = 1 FOR UPDATE`));
      }
      await tx.execute(
        sql.raw(`INSERT INTO ${M}_events (team, points) VALUES (${team}, 10)`)
      );

      if (!lock) {
        waiting += 1;
        if (waiting === 2) release();
        await gate;
      }

      const sum = await tx.execute(
        sql.raw(`SELECT COALESCE(SUM(points),0)::int AS s FROM ${M}_events`)
      );
      const total = sum.rows[0].s;
      computed.push(total);
      await tx.execute(sql.raw(`UPDATE ${M} SET score = ${total} WHERE id = 1`));
      return total;
    });

  await Promise.all([score(1), score(2)]);
  return { ...(await truth()), computed };
}

let failure = null;
try {
  const iso = await db.execute(sql.raw('SHOW transaction_isolation'));
  console.log(`isolation level = ${iso.rows[0]?.transaction_isolation}`);
  console.log('');

  await db.execute(sql.raw(`
    DROP TABLE IF EXISTS ${M} CASCADE;
    CREATE TABLE ${M} (id integer PRIMARY KEY, score integer NOT NULL DEFAULT 0);
    CREATE TABLE ${M}_events (id serial PRIMARY KEY, team integer NOT NULL, points integer NOT NULL);
    INSERT INTO ${M} (id, score) VALUES (1, 0);
  `));
  created = true;
  console.log('Scenario : deux /score concurrents, +10 chaque, sur des equipes differentes');
  console.log('           (donc deux cles anti-double-clic distinctes : les deux passent)');
  console.log('');

  // --- Variante 1 : sans verrou (comportement historique) ------------------
  const sansVerrou = await concurrentScoring(false);
  const perduSansVerrou = sansVerrou.truth - sansVerrou.shown;

  // --- Variante 2 : avec verrou (comportement corrige) ---------------------
  const avecVerrou = await concurrentScoring(true);
  const perduAvecVerrou = avecVerrou.truth - avecVerrou.shown;

  console.log('  variante                     total reel   score affiche   points perdus   totaux vus par tx');
  console.log(`  sans verrou (defaut)         ${String(sansVerrou.truth).padStart(9)}   ${String(sansVerrou.shown).padStart(13)}   ${String(perduSansVerrou).padStart(12)}   ${JSON.stringify(sansVerrou.computed)}`);
  console.log(`  avec verrou (corrige)        ${String(avecVerrou.truth).padStart(9)}   ${String(avecVerrou.shown).padStart(13)}   ${String(perduAvecVerrou).padStart(12)}   ${JSON.stringify(avecVerrou.computed)}`);
  console.log('');

  // Le test ne vaut que si son CONTROLE echoue. Si la variante sans verrou ne
  // reproduit pas le defaut, c'est que l'entrelacement n'a pas ete force, et
  // alors « avec verrou : 0 point perdu » ne prouve rien du tout.
  const controleReproduit = perduSansVerrou > 0;
  const corrige = perduAvecVerrou === 0 && avecVerrou.shown === avecVerrou.truth;
  // Avec le verrou, les deux transactions sont sérialisees : la seconde voit
  // l'insertion de la premiere (10 puis 20). C'est la preuve mechanique.
  const serialise = avecVerrou.computed.includes(10) && avecVerrou.computed.includes(20);

  if (!controleReproduit) {
    console.log('  ECHEC DU CONTROLE : la variante sans verrou n\'a PAS reproduit le defaut.');
    console.log('      L\'entrelacement n\'a pas ete force, donc la comparaison ne prouve rien.');
    failure = new Error('controle non reproductible : le test ne prouve rien');
  } else if (corrige && serialise) {
    console.log(`  OK : le controle reproduit bien le defaut (${perduSansVerrou} point(s) perdu(s)).`);
    console.log('      Avec SELECT ... FOR UPDATE, les transactions sont sérialisees :');
    console.log(`      totaux vus ${JSON.stringify(avecVerrou.computed)} — la seconde voit l'insertion`);
    console.log('      de la premiere, donc le score affiche egale toujours le journal.');
  } else {
    console.log('  ECHEC : le verrou ne suffit pas.');
    console.log(`    points perdus : ${perduAvecVerrou}   sérialisé : ${serialise}`);
    failure = new Error(`points perdus avec verrou : ${perduAvecVerrou}`);
  }
} catch (err) {
  failure = err;
  console.error('ERREUR:', err?.message ?? err);
  console.error('cause  :', err?.cause?.message ?? '(aucune)');
} finally {
  if (created) {
    await db.execute(
      sql.raw(`DROP TABLE IF EXISTS ${M}_events CASCADE; DROP TABLE IF EXISTS ${M} CASCADE;`)
    ).catch(() => {});
    console.log('\ntables jetables supprimees (aucune donnee de competition touchee)');
  }
}
process.exit(failure ? 1 : 0);
