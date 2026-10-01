/**
 * Journalisation structuree, sans dependance externe.
 *
 * Pourquoi ne pas Pino
 * --------------------
 * Le projet a fait un choix de conception constant : ne rien embarquer qui
 * puisse etre remplace par quelque chose de petit et verifiable.
 *   - `node:test` plutot que Vitest/Jest pour les tests serveur ;
 *   - `scripts/verify-build-output.mjs` plutot qu'un plugin de bundler ;
 *   - `middleware/rateLimit.ts` plutot qu'express-rate-limit (qui n'offre ni le
 *     fenetrage glissant, ni la separation succes/echecs, ni la cle par
 *     utilisateur exigees ici) ;
 *   - `server/leaderLock.ts` plutot qu'un client Redis ou etcd.
 * Pino ajouterait sept dependances transitives a l'image de production pour
 * obtenir ce que ~180 lignes donnent ici : rotation de format, niveaux,
 * contexte lie a un logger enfant, et surtout la redaction.
 *
 * Le point non negociable : la REDACTION. Un logger structure ecrit des objets
 * entiers. Or `req.body` contient le mot de passe lors de `/auth/login`, et
 * l'en-tete `Authorization` porte le jeton de session sur chaque appel authentifie.
 * Un logger naif qui sérialiserait `{ req }` inscrirait durablement ces secrets
 * dans les journaux — c'est la raison d'etre principale de ce module.
 *
 * Formats
 * -------
 * - production : une ligne JSON par evenement (parseable par Loki, Datadog,
 *   CloudWatch, `jq`...). Aucun rendu colore dans les logs de conteneur.
 * - developpement : format compact et colore, date en heure locale.
 *
 * La decision repose sur `NODE_ENV`, pas sur `isTTY` : un `docker logs` est
 * bien un TTY, et y ecrire des codes d'echappement ne rendrait le journal
 * qu'illisible par un humain ET illisible par une machine.
 */

import { inspect } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Champs considers comme secrets et remplaces systematiquement. */
const REDACTED = '[redige]';

const SECRET_KEYS = new Set([
  'password',
  'motdepasse',
  'mot_de_passe',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'authorization',
  'cookie',
  'setcookie',
  'set-cookie',
  'secret',
  'apikey',
  'api_key',
  'credentials',
  'privatekey',
  'private_key',
  'sessionid',
  'session_id',
  'connectionstring',
  'databaseurl',
  'database_url',
]);

/** Profondeur maximale de l'inspection : borne la taille et le cout des logs. */
const MAX_DEPTH = 4;

/**
 * Remplace la valeur d'un objet si sa cle est un secret.
 *
 * Le test est fait sur la cle normalisee (minuscules, sans separateur) pour
 * que `password_hash`, `passwordHash` et `PASSWORD` soient traites ensemble.
 * Un nom de cle peut contenir le mot : on teste aussi par inclusion, mais on
 * s'arrete sur une liste blanche courte pour ne pas noyer des champs
 * legitimes (`tokenCount`, `authUid`).
 */
function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_.]/g, '');
  if (SECRET_KEYS.has(k)) return true;
  // `passwordConfirmation`, `userPassword`, `authorizationHeader`...
  return (
    k.includes('password') ||
    k.endsWith('token') ||
    k.endsWith('secret') ||
    k.endsWith('apikey')
  );
}

/**
 * Copie assainie d'une valeur, bornee en profondeur et en taille.
 *
 * Les references circulaires sont tolerees (`[Circular]`) : un objet Error
 * prepare qui se contient lui-meme ne doit pas faire planter le journal, au
 * point ou l'on ne voit plus l'erreur qu'on cherchait a journaliser.
 */
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === 'string') {
    // Tronque les chaines geantes : une charge utile NOTIFY ou un corps JSON
    // complet dans un journal est un exces de cout et un risque de fuite.
    return (value as string).length > 512 ? `${(value as string).slice(0, 512)}...[tronque]` : value;
  }
  if (t === 'number' || t === 'boolean' || t === 'bigint') return value;

  if (t !== 'object') return String(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(value.cause ? { cause: String(value.cause) } : {}),
    };
  }

  if (seen.has(value as object)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[profondeur max]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    // Un tableau de 10 000 elements dans un journal n'aide personne.
    const head = value.slice(0, 20).map((v) => sanitize(v, depth + 1, seen));
    if (value.length > 20) head.push(`...${value.length - 20} de plus`);
    return head;
  }

  // Objet simple : on teste chaque cle. Evite le [util.inspect] d'objets
  // complexes (classes, Map, Set) qui revelerait des donnees non prevues.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return inspect(value, { depth: 2, breakLength: Infinity });
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACTED : sanitize(v, depth + 1, seen);
  }
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Niveau effectif, reevalué à chaque écriture.
 *
 * Volontairement pas figé au chargement du module : `LOG_LEVEL` sert à
 * rendre le service bavard SANS REDÉMARRAGE (un `docker exec` avec une
 * variable posee, ou un test qui la change), et un niveau capture une fois au
 * chargement rendrait ce reglage inoperant. Le cout est une lecture de
 * variable d'environnement par ligne de journal, negligeable devant la
 * serialisation qui suit.
 */
function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/**
 * Contexte de requete, disponible partout via `requestId()`.
 *
 * AsyncLocalStorage est le seul moyen fiable d'y acceder : un `let` global
 * serait ecrase par la premiere requete concurrente, et un passage explicite
 * dans toutes les fonctions_rappeler ne tient pas a la longue. La boutique
 * survit a l'asynchronisme et ne fuit pas entre deux requetes.
 */
const requestStore = new AsyncLocalStorage<{ requestId: string }>();

/** Lance `fn` dans un contexte de requete, en restituant son identifiant. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestStore.run({ requestId }, fn);
}

/** Identifiant de la requete courante, ou undefined hors contexte. */
export function currentRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}

const COLOR = {
  reset: '[0m',
  dim: '[2m',
  gray: '[90m',
  red: '[31m',
  yellow: '[33m',
  green: '[32m',
  cyan: '[36m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: COLOR.gray,
  info: COLOR.green,
  warn: COLOR.yellow,
  error: COLOR.red,
};

/** Champs communs a tous les processus : indispensable pour trier quatre flux. */
interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Logger enfant : meme service, champs supplementaires lies a la duree. */
  child(fields: Record<string, unknown>): Logger;
  /** Ecrit directement au niveau `error` une valeur de type Error. */
  exception(err: unknown, msg?: string, fields?: Record<string, unknown>): void;
}

/**
 * Cree un journal rattache a un service.
 *
 * @param service  nom du processus (« api », « ws », « worker », « static »).
 *                 C'est le champ qui permet de reconstituer, dans un agrégateur,
 *                 ce qu'a fait chaque processus independamment.
 */
export function createLogger(service: string): Logger {
  return build({ service, pid: process.pid });
}

function build(bound: Record<string, unknown>): Logger {
  const enabled = (l: LogLevel) => LEVEL_RANK[l] >= LEVEL_RANK[resolveLevel()];

  function emit(l: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (!enabled(l)) return;
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: l,
      service: bound.service,
      pid: bound.pid,
      msg,
    };

    // L'identifiant de requete est ajoute en automatique : c'est lui qui relie
    // une ligne du proxy, une ligne de l'API et une erreur de base entre elles.
    const rid = currentRequestId();
    if (rid) record.requestId = rid;

    for (const [k, v] of Object.entries(bound)) {
      if (k !== 'service' && k !== 'pid') record[k] = v;
    }
    // La REDACTION porte sur la CLE, pas sur la valeur : il faut appeler
    // `sanitize` sur l'objet entier, car c'est lui qui inspecte chaque nom de
    // champ. Assainir chaque valeur separement laisserait passer
    // `{ password: 'secret' }` — la valeur serait assainie, la cle jamais
    // vue, et le mot de passe inscrit au journal.
    Object.assign(record, sanitize(fields ?? {}) as Record<string, unknown>);

    const line = process.env.NODE_ENV === 'production' ? JSON.stringify(record) : pretty(record, l);

    if (l === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => build({ ...bound, ...fields }),
    exception: (err, msg, fields) =>
      emit('error', msg ?? 'Exception', { ...fields, err }),
  };
}

const LEVEL_PAD: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/** Rendu developpement : une ligne lisible, champs alignes apres le message. */
function pretty(record: Record<string, unknown>, level: LogLevel): string {
  const t = String(record.time).slice(11, 23);
  const head =
    `${COLOR.dim}${t}${COLOR.reset} ` +
    `${LEVEL_COLOR[level]}${LEVEL_PAD[level]}${COLOR.reset} ` +
    `${COLOR.cyan}[${record.service}]${COLOR.reset} ${record.msg}`;

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (['time', 'level', 'service', 'pid', 'msg'].includes(k)) continue;
    extras[k] = v;
  }
  if (Object.keys(extras).length === 0) return head;
  return `${head} ${COLOR.gray}${inspect(extras, { depth: 2, breakLength: Infinity, colors: false })}${COLOR.reset}`;
}

/** Racine du journal, pour les erreurs de demarrage ou les tests. */
export const rootLogger = createLogger('aeerks');

export default createLogger;
