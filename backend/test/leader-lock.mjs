/**
 * Verifie le verrou de leader du worker de chrono.
 *
 * Le defaut que le verrou empeche
 * -------------------------------
 * Deux boucles de chrono ne se contentent pas de doubler le travail : elles se
 * disputent la meme ligne de match. L'une peut remettre le chrono a zero,
 * avancer la question courante ou cloturer un match pendant que l'autre fait
 * l'inverse. Intermittent, donc quasi impossible a reproduire apres coup.
 *
 * Ce que le test etablit
 * ----------------------
 *  1. UNE SEULE connexion obtient le verrou parmi plusieurs demandes
 *     simultanees ;
 *  2. un client qui n'a PAS le verrou n'a aucun privilege particulier ;
 *  3. le verrou se libere quand on le demande — sans quoi impossible de
 *     relancer le worker apres un incident, en pleine competition ;
 *  4. il se libere EGALEMENT a la fermeture de la connexion, c'est-a-dire
 *     apres un `kill -9` : aucun nettoyage manuel n'est requis ;
 *  5. une panne d'acquisition ne donne PAS le leadership.
 *
 * Le point 4 est le plus utile en exploitation : c'est lui qui garantit qu'un
 * worker mort ne bloque pas definitivement la competition.
 */
import 'dotenv/config';
import { Client } from 'pg';
import { tryAcquireLeaderLock } from '../src/server/leaderLock.ts';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'OK   ' : 'ECHEC'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
};

/**
 * Ouvre ET connecte un client.
 *
 * `new Client({...})` ne connecte PAS : il ne fait que preparer l'objet. Sur un
 * client non connecte, `query()` empile la requete et ne l'execute jamais — le
 * processus se termine alors sur « unsettled top-level await », sans aucune
 * erreur visible. C'est exactement ce qu'a produit la premiere version de ce
 * test : le blocage venait du test, pas du verrou de leader.
 */
async function connect() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

const clients = [];
const closeAll = async () => {
  for (const c of clients) await c.end().catch(() => {});
  clients.length = 0;
};

try {
  console.log('Verrou de leader du worker\n');

  // --- 1. Une seule connexion obtient le verrou ---------------------------
  console.log('A) trois workers demandent en meme temps');
  const N = 3;
  for (let i = 0; i < N; i += 1) {
    const c = await connect();
    clients.push(c);
  }
  // Demande simultanee : c'est le cas reel d'un redeloiement ou d'un
  // redemarrage de l'orchestrateur.
  const verdicts = await Promise.all(clients.map((c) => tryAcquireLeaderLock(c)));

  const leaders = verdicts.filter((v) => v.held).length;
  const perdant = verdicts.findIndex((v) => !v.held);
  const gagnant = verdicts.findIndex((v) => v.held);

  check(`exactement 1 leader parmi ${N}`, leaders === 1, `obtenu : ${leaders}`);
  check('les deux autres sont explicitement refuses', perdant >= 0 && leaders === 1);
  check('held=false pour le refus', verdicts[perdant].held === false);
  check('held=true pour le leader', verdicts[gagnant].held === true);

  // --- 2. Liberation explicite ---------------------------------------------
  console.log('\nB) liberation explicite');
  await verdicts[gagnant].release();
  const repris = await tryAcquireLeaderLock(clients[perdant]);
  check(
    'un autre client obtient le verrou apres liberation',
    repris.held,
    'sans cela, impossible de relancer le worker apres un incident'
  );
  await repris.release();

  // --- 3. Liberation par fermeture de connexion (cas du kill -9) -----------
  console.log('\nC) liberation implicite a la fermeture de la connexion');
  const c4 = await connect();
  clients.push(c4);
  const l4 = await tryAcquireLeaderLock(c4);
  check('verrou obtenu', l4.held);

  // Simule un `kill -9` : la connexion meurt, sans appel a release().
  await c4.end();
  clients.pop();

  const c5 = await connect();
  clients.push(c5);
  const l5 = await tryAcquireLeaderLock(c5);
  check(
    'un nouveau client obtient le verrou apres fermeture de connexion',
    l5.held,
    'PostgreSQL libere les verrous de session : aucun nettoyage manuel'
  );
  await l5.release();

  // --- 4. Echec d'acquisition = pas de leadership -------------------------
  console.log('\nD) echec d acquisition = pas de leadership (fail-closed)');
  const casse = {
    query: async () => {
      throw new Error('base injoignable');
    },
  };
  const l6 = await tryAcquireLeaderLock(casse);
  check(
    'une base injoignable ne donne PAS le leadership',
    l6.held === false,
    'demarrer la boucle sans etre leader produirait la corruption decrite'
  );
} catch (err) {
  console.error('ERREUR:', err?.message ?? err);
  failures += 1;
} finally {
  await closeAll();
}

console.log(
  failures === 0 ? '\nOK : verrou de leader operationnel.' : `\n${failures} ECHEC(S).`
);
process.exit(failures === 0 ? 0 : 1);
