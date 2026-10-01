/**
 * Superviseur des quatre processus du backend.
 *
 * POURQUOI CE FICHIER EXISTE
 * -------------------------
 * Le backend est conçu comme quatre processus distincts : `api`, `ws`,
 * `worker` et `static`. Cette séparation est justifiée — un traitement de
 * requête long côté API ne doit pas pouvoir figer la boucle de chrono — et
 * `docker-compose.yml` la met en place par quatre services.
 *
 * Mais Render ne l'accorde pas. Son offre gratuite donne 750 heures PAR
 * WORKSPACE ET PAR MOIS, partagées entre tous les services : quatre services
 * demanderaient 3000 heures, soit quatre fois le plafond. Un service unique
 * consomme 750 heures, soit exactement la limite.
 *
 * On regroupe donc les quatre processus dans un conteneur unique, chacun restant
 * un OS PROCESS DISTINCT.
 *
 * CE QUI EST PRÉSERVÉ
 * -------------------
 *  - L'isolation reste réelle : un `await` long dans l'API ne bloque ni le
 *    chrono, ni la diffusion. C'est le bénéfice de la séparation, et il
 *    survit à son déploiement dans un seul conteneur.
 *  - Le verrou de leader PostgreSQL reste nécessaire et reste correct : si un
 *    second superviseur se démarrait, le `worker` refuserait de démarrer au
 *    lieu de disputer la ligne de match.
 *  - Les sondes, la journalisation et les métriques par service restent
 *    lisibles : chaque processus écrit sur la même sortie standard, avec son
 *    propre préfixe de service.
 *
 * CE QUI CHANGE
 * -------------
 * Un conteneur n'a qu'un port public. Seul `static` l'ouvre — il relaie déjà
 * `/api` et `/ws` vers les autres processus (cf. `server/static.ts`). `api`,
 * `ws` et `worker` n'écoutent que sur `127.0.0.1`, donc restent injoignables
 * depuis l'extérieur. C'est exactement la disposition de `docker-compose.yml`,
 * où seul `static` publie un port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from './config.ts';
import { createLogger } from './lib/logger.ts';
import { envForService } from './lib/supervisorPorts.ts';

const log = createLogger('supervisor');

// `import.meta.url` pointe sur `src/supervisor.ts` ; on remonte au dossier
// `src/` puis on descend dans `server/`. Les points de passage sont explicites
// plutôt que calculés : `path.join(a, '..', b)` ne normalise pas, et une
// traversée oubliée se voit seulement à l'exécution.
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(SRC_DIR, 'server');

/** Distingue les lignes des quatre processus dans les journaux. */
const COULEURS = ['[36m', '[35m', '[33m', '[32m'];
const RESET = '[0m';

interface Service {
  name: string;
  entry: string;
  color: string;
  /** Dépendances à démarrer avant celle-ci. */
  needs: string[];
  /** Exposition publique : seul le service qui sert les documents l'est. */
  public: boolean;
}

/**
 * Les quatre processus, dans leur ordre de dépendance.
 *
 * `static` est déclaré PUBLIC parce que c'est lui qui reçoit le trafic de
 * Render et le relaie. Les trois autres n'ont aucun trafic entrant à recevoir :
 * les exposer n'ajouterait qu'une surface d'attaque.
 */
const SERVICES: Service[] = [
  { name: 'api', entry: path.join(SRC_DIR, 'index.ts'), color: COULEURS[0], needs: [], public: false },
  { name: 'ws', entry: path.join(SERVER_DIR, 'ws.ts'), color: COULEURS[1], needs: [], public: false },
  { name: 'worker', entry: path.join(SERVER_DIR, 'worker.ts'), color: COULEURS[2], needs: [], public: false },
  { name: 'static', entry: path.join(SERVER_DIR, 'static.ts'), color: COULEURS[3], needs: ['api', 'ws'], public: true },
];

const children = new Map<string, ChildProcess>();
let shuttingDown = false;

/**
 * Redirige la sortie d'un enfant en lui préfixant son nom de service.
 *
 * Sans cela, les journaux de quatre processus entremêlés deviennent illisibles :
 * un `info` de l'API et un `info` du worker se ressemblent, et savoir lequel a
 * échoué est précisément ce qu'on cherche à lire en incident.
 */
function pipe(prefix: string, stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    // Le dernier élément est incomplet : il attend la suite.
    buffer = lines.pop() ?? '';
    for (const line of lines) sink.write(`${prefix} ${line}\n`);
  });
  stream.on('end', () => {
    if (buffer) sink.write(`${prefix} ${buffer}\n`);
  });
}

/**
 * Calcule les variables de port d'un service.
 *
 * La règle elle-même — et pourquoi `PORT` doit être SUPPRIMÉ chez les services
 * privés, pas seulement redéfini chez le public — vit dans `lib/supervisorPorts.ts`,
 * avec ses tests. Un déploiement Raté sur `EADDRINUSE` ne se voit qu'à
 * l'exécution : mieux vaut que la règle soit éprouvable.
 */
function portsFor(service: Service): NodeJS.ProcessEnv {
  return envForService({
    platformPort: process.env.PORT,
    isPublic: service.public,
    // L'ENFANT HÉRITE DE TOUT : `spawn` REMPLACE l'environnement, il ne le
    // fusionne pas. Sans cette ligne, les quatre processus ne recevaient que
    // leurs ports — ni `DATABASE_URL`, ni `NODE_ENV`, ni `TRUST_PROXY`.
    baseEnv: process.env,
  });
}

/** Environnement complet d'un service. */
function envFor(service: Service): NodeJS.ProcessEnv {
  const env = portsFor(service);

  // `tsx` est dans `node_modules/.bin` et pas dans le PATH d'un `node
  // --import`. On le résout pour que le superviseur fonctionne quel que soit
  // l'environnement d'exécution.
  env.NODE_PATH = [
    path.join(process.cwd(), 'node_modules'),
    process.env.NODE_PATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);

  return env;
}

function start(service: Service) {
  log.info(`Démarrage du processus « ${service.name} »`, {
    public: service.public || undefined,
  });

  const child = spawn(process.execPath, ['--import', 'tsx', service.entry], {
    env: envFor(service),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${service.color}[${service.name}]${RESET}`;
  pipe(prefix, child.stdout, process.stdout);
  pipe(prefix, child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    children.delete(service.name);
    if (shuttingDown) return;

    // UN SEUL SERVICE QUI TOMBE EMPOCHE TOUT LE RESTE.
    //
    // Le `worker` qui s'arrête se relève : le verrou de leader est détenu par
    // une CONNEXION PostgreSQL, pas par le process, et cette connexion meurt
    // avec lui — le verrou est donc libéré et un autre worker peut le prendre.
    // L'API qui tombe, elle, n'a personne pour la remplacer : la laisser morte
    // exposerait `/api` en 502 pendant toute la session.
    //
    // On arrête donc tout et on laisse la plateforme redémarrer le conteneur.
    // Unprocessus partiellement vivant est un état plus difficile à diagnostiquer
    // qu'un arrêt franc.
    log.error(`Le processus « ${service.name} » s'est arrêté`, {
      code: code ?? undefined,
      signal: signal ?? undefined,
    });
    void shutdown(1);
  });

  children.set(service.name, child);
}

/** Démarre un service et ceux qui en dépendent, dans l'ordre. */
function startInOrder() {
  for (const service of SERVICES) {
    if (service.needs.length === 0) start(service);
  }
  // `static` attend ses amonts : le démarrer trop tôt exposerait des 502
  // pendant la fenêtre de démarrage, que la sonde de Render lirait comme un
  // échec de déploiement.
  for (const service of SERVICES) {
    if (service.needs.length > 0) start(service);
  }
}

/**
 * Arrête tous les enfants, puis le superviseur.
 *
 * L'ordre est l'inverse du démarrage : `static` d'abord, parce qu'il n'a plus
 * rien à servir si ses amonts tombent. Chaque enfant reçoit SIGTERM, ce qui
 * lui permet de relâcher proprement le verrou de leader et de fermer ses
 * transactions — l'arrêt par SIGTERM est ce que les quatre processus gèrent
 * déjà individuellement.
 */
async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Arrêt du superviseur.');

  const ordered = [...children.entries()].reverse();
  for (const [name, child] of ordered) {
    if (child.exitCode !== null) continue;
    log.info(`SIGTERM -> ${name}`);
    child.kill('SIGTERM');
  }

  // On ne seure pas d'un processus qui refuse de s'arrêter : un conteneur qui
  // ne répond plus est tué par la plateforme, une transaction PostgreSQL en
  // cours avec.
  const deadline = setTimeout(() => {
    log.warn('Des processus refusent de s’arrêter : SIGKILL.');
    for (const child of children.values()) child.kill('SIGKILL');
  }, 8000);
  deadline.unref();

  await Promise.all(
    ordered.map(
      ([, child]) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null) return resolve();
          child.once('exit', () => resolve());
        })
    )
  );

  clearTimeout(deadline);
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

process.on('unhandledRejection', (reason) => log.error('Promesse non gérée (superviseur)', { err: reason }));
process.on('uncaughtException', (reason) => log.error('Exception non interceptée (superviseur)', { err: reason }));

log.info('Superviseur démarré.', {
  services: SERVICES.map((s) => s.name),
  portPublic: process.env.PORT || CONFIG.STATIC_PORT,
});

startInOrder();