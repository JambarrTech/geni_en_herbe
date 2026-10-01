/**
 * Résolution de l'URL du canal temps réel.
 *
 * POURQUOI CE MODULE EXISTE
 * ------------------------
 * L'URL du WebSocket était calculée en dur dans `LiveContext` :
 *
 *     `${protocol}//${window.location.host}/ws`
 *
 * Ce qui suppose que le navigateur et le serveur de diffusion sont SUR LA MÊME
 * ORIGINE. C'est vrai de l'hébergement actuel (le processus `static` sert les
 * trois apps ET relaie `/ws`). Mais dès lors que l'interface est déployée sur
 * un CDN et l'API ailleurs — ce que fait Vercel — cette ligne devient fausse :
 * le socket se connecterait au CDN, qui ne relaie pas de WebSocket.
 *
 * Extraire le calcul le rend testable ET permet de rester sur le comportement
 * actuel par défaut : sans `override`, la chaîne produite est exactement celle
 * d'aujourd'hui, au caractère près. L'auto-hébergement ne change donc rien.
 *
 * Note sur le schéma (`wss:` vs `ws:`)
 * -----------------------------------
 * La page décide du schéma, sauf si l'hôte distant en impose un autre. Écrire
 * `wss:` en dur serait plus simple, mais casserait le développement en
 * `http://localhost` — le navigateur refuse un socket sécurisé sur une page
 * non sécurisée.
 */
export interface WsUrlParams {
  /** Hôte de la page, tel que `window.location.host`. */
  host: string;
  /** Protocole de la page : `'https:'` ou `'http:'`. */
  protocol: string;
  /** Jeton de session, ou `null` pour le flux public. */
  token: string | null;
  /**
   * Origine distante du canal, sans chemin.
   *
   * Formes acceptées : `wss://api.exemple.sn`, `https://api.exemple.sn`, ou
   * `api.exemple.sn` (le schéma est alors déduit du protocole de la page).
   * La valeur vide ou absente signifie « même origine que la page ».
   */
  override?: string | undefined;
}

/** Retire les barres obliques finales : `wss://h/` et `wss://h` sont équivalents. */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Construit l'URL du canal.
 *
 * Le jeton passe en paramètre de requête, jamais en en-tête : le navigateur
 * n'autorise pas d'en-tête `Authorization` sur un WebSocket, et le serveur
 * s'en sert pour distinguer un client authentifié (jury/admin) du flux public
 * (écran live). Il est donc encodé — un jeton contenant `&` ou `=` ne peut pas
 * casser la requête.
 */
export function resolveWsUrl({ host, protocol, token, override }: WsUrlParams): string {
  const secure = protocol === 'https:';
  const target = override?.trim() ? stripTrailingSlash(override.trim()) : `${secure ? 'wss' : 'ws'}://${host}`;

  // Un override sans schéma (« api.exemple.sn ») reçoit celui de la page.
  // Avec schéma explicite, celui-ci est respecté : c'est le cas d'un backend
  // accessible en TLS alors que la page l'est aussi, ou l'inverse.
  const base = target.includes('://')
    ? target
    : `${secure ? 'wss' : 'ws'}://${target}`;

  const path = `${base}/ws`;
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

/**
 * Origine à annoncer au serveur de diffusion, pour le contrôle d'accès.
 *
 * Sert à configurer la liste `WS_ALLOWED_ORIGINS` du backend sans avoir à
 * deviner la mise en forme de l'URL du socket.
 */
export function wsOriginOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
