/**
 * Répartition des ports entre les processus supervisés.
 *
 * POURQUOI CE MODULE EST ISOLÉ
 * ----------------------------
 * `supervisor.ts` lance des processus et surveille leur arrêt : il est difficile
 * à éprouver. La répartition des ports, en revanche, est une fonction pure — et
 * c'est celle qui a fait échouer un déploiement réel.
 *
 * LE DÉFAUT QU'IL EMPÊCHE
 * -----------------------
 * L'hébergeur (Render, Railway, Heroku) injecte `PORT` pour le service qu'il
 * expose. Cet héritage atteint tous les processus, et `index.ts` lit
 * `API_PORT || PORT`. L'API tentait donc d'écouter sur le port public, déjà pris
 * par `static`, et mourait sur `EADDRINUSE` — après une construction réussie,
 * donc avec un déploiement qui « réussissait » puis ne servait rien.
 *
 * Aucun test ne l'aurait attrapé avant l'exécution : il faut lancer le
 * superviseur pour que deux processus se disputent un port.
 */
import { CONFIG } from '../config.ts';

/** Port imposé par la plateforme au service public. */
export const PLATFORM_PORT = process.env.PORT;

/**
 * Environnement du service public : il prend le port imposé par la plateforme.
 *
 * Le repli sur `CONFIG.STATIC_PORT` sert au développement local, où aucun
 * `PORT` n'est injecté.
 *
 * Une valeur NON NUMÉRIQUE retombe aussi sur le repli. Ce n'est pas une
 * prudence théorique : `PORT=abc` — une faute de frappe dans le tableau de bord
 * — produirait `server.listen('abc')`, qui lève, et le conteneur mourrait au
 * démarrage. Le repli le fait démarrer sur son port de développement, visible
 * dans les journaux, au lieu d'un échec opaque.
 */
export function publicPortEnv(platformPort: string | undefined = PLATFORM_PORT): {
  STATIC_PORT: string;
} {
  const port = Number(platformPort);
  return { STATIC_PORT: String(Number.isInteger(port) && port > 0 ? port : CONFIG.STATIC_PORT) };
}

/**
 * Variables de port d'un service privé.
 *
 * `PORT` doit être ABSENT, pas vide : `Number('')` vaut `0`, et le port `0` est
 * valide — il demande au système d'attribuer un port au hasard. Un service
 * démarré ainsi est vivant et injoignable par le relais de `static` : un défaut
 * silencieux, le pire genre.
 *
 * D'où le `delete` explicite, plutôt qu'un `PORT: ''`.
 */
export function privatePortEnv(): Record<string, never> {
  return {} as Record<string, never>;
}

/**
 * Construit l'environnement d'un service.
 *
 * @param platformPort  Valeur de `PORT` injectée par la plateforme.
 * @param isPublic      Le service est-il celui qui reçoit le trafic ?
 */
export function envForService(options: {
  platformPort: string | undefined;
  isPublic: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const { platformPort, isPublic, baseEnv } = options;

  const env: NodeJS.ProcessEnv = { ...(baseEnv ?? {}) };

  if (isPublic) {
    Object.assign(env, publicPortEnv(platformPort));
    return env;
  }

  // Un service privé garde ses ports par défaut (CONFIG.*), qui ne dépendent
  // pas de `PORT`. On retire donc la variable qui pourrait les contaminer.
  delete env.PORT;
  return env;
}

/**
 * Vérifie qu'aucun port ne peut être attribué à deux services.
 *
 * Fonction de TEST, volontairement exportée : c'est une garantie structurelle
 * du déploiement, pas une règle de production. `EADDRINUSE` ne se détecte
 * qu'au moment d'écouter — c'est-à-dire dans le conteneur, sur Render, quand le
 * déploiement est déjà lancé.
 */
export function portsCollide(ports: Record<string, number>): string | null {
  const seen = new Map<number, string>();

  for (const [name, port] of Object.entries(ports)) {
    // Le port 0 est un cas particulier : il n'est pas en collision avec
    // lui-même, le système attribuant un port libre à chaque écoute.
    if (port === 0) continue;

    const dejaLa = seen.get(port);
    if (dejaLa !== undefined) return `${dejaLa} et ${name} utilisent le port ${port}`;
    seen.set(port, name);
  }
  return null;
}