/**
 * Client HTTP unique pour toute la plateforme.
 *
 * Remplace les ~23 appels `fetch(...)` dispersés dans les trois apps, qui :
 *   - n'injectaient pas le jeton de façon fiable (6 des 9 appels de
 *     AdminDashboard.fetchData partaient sans en-tête Authorization) ;
 *   - n'avaient aucune gestion du statut HTTP : `if (res.ok)` sans branche
 *     `else` signifiait qu'un 401 ou un 400 produisait un échec *silencieux* ;
 *   - ne throwaient jamais, donc chaque appelant devait écarter le cas
 *     d'erreur et formater le message à la main ;
 *   - n'annulaient jamais la requête au démontage (aucun AbortSignal).
 *
 * Ce module centralise le jeton, normalise les erreurs, expose une annulation
 * et signale globalement les 401 (session expirée / compte désactivé).
 */

const TOKEN_STORAGE_KEY = 'aeerks_token';

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }

  /** 401 : session expirée ou révoquée -> il faut se reconnecter. */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** 403 : authentifié mais droits insuffisants. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** 429 : anti-double-clic ou quota dépassé. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** 409 : conflit métier (ex. publication bloquée par des matchs en cours). */
  get isConflict(): boolean {
    return this.status === 409;
  }
}

/** Jeton courant. Lu à chaque appel : jamais capturé dans une closure. */
export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* stockage indisponible (mode privé) : on continue sans persistance */
  }
}

// --- Gestionnaire 401 global -------------------------------------------------
// Un seul point d'enregistrement : AuthContext s'y inscrit et force la
// déconnexion. Sans cela, une session expirée laissait tous les écrans vides
// sans aucun message.
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /** Corps JSON : sérialisé automatiquement. */
  json?: unknown;
  /** Jeton explicite (défaut : jeton stocké). Passer `null` pour un appel public. */
  token?: string | null;
  /** Annulation (nettoyage au démontage). */
  signal?: AbortSignal;
}

const PUBLIC_PATHS = new Set(['/api/health', '/api/live', '/api/rankings', '/api/auth/login']);

/** Chemin public : pas de jeton, pas de déclenchement du handler 401. */
export function isPublicPath(path: string): boolean {
  const clean = path.split('?')[0];
  if (PUBLIC_PATHS.has(clean)) return true;
  return clean.startsWith('/api/events/') && clean.endsWith('/live');
}

async function extractErrorMessage(res: Response, path: string): Promise<ApiError> {
  let payload: unknown = null;
  let message = `Erreur ${res.status} sur ${path}`;

  try {
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
        const p = payload as { error?: unknown; message?: unknown };
        if (typeof p?.error === 'string' && p.error) message = p.error;
        else if (typeof p?.message === 'string' && p.message) message = p.message;
      } catch {
        payload = text;
        if (text.length < 200) message = text;
      }
    }
  } catch {
    /* corps illisible : on garde le message générique */
  }

  return new ApiError(res.status, message, payload);
}

/**
 * Requête JSON typée. Throw toujours une `ApiError` en cas d'échec — jamais
 * d'échec silencieux.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const { json, token, signal, headers, ...rest } = options;

  const finalHeaders = new Headers(headers);
  if (json !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
  }

  // Jeton : explicite > stocké. Les routes publiques n'en envoient pas.
  const effectiveToken = token === undefined ? getStoredToken() : token;
  if (effectiveToken && !isPublicPath(path)) {
    finalHeaders.set('Authorization', `Bearer ${effectiveToken}`);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: finalHeaders,
      signal,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch (err) {
    // Une annulation n'est pas une erreur applicative : on la propage telle
    // quelle pour que l'appelant l'ignore.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'Serveur injoignable. Vérifiez la connexion réseau.', err);
  }

  if (!res.ok) {
    const apiError = await extractErrorMessage(res, path);
    if (apiError.isUnauthorized && !isPublicPath(path)) {
      onUnauthorized?.();
    }
    throw apiError;
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'Réponse serveur illisible', text);
  }
}

/** Raccourcis typés. */
export const api = {
  get: <T>(path: string, opts: ApiRequestOptions = {}) =>
    apiFetch<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, json?: unknown, opts: ApiRequestOptions = {}) =>
    apiFetch<T>(path, { ...opts, method: 'POST', json }),
  patch: <T>(path: string, json?: unknown, opts: ApiRequestOptions = {}) =>
    apiFetch<T>(path, { ...opts, method: 'PATCH', json }),
  delete: <T>(path: string, opts: ApiRequestOptions = {}) =>
    apiFetch<T>(path, { ...opts, method: 'DELETE' }),
};

/** Message d'erreur destiné à l'utilisateur, quelle que soit l'origine. */
export function errorMessage(err: unknown, fallback = 'Une erreur est survenue'): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException && err.name === 'AbortError') return '';
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Vrai si l'erreur est une annulation : à ne jamais afficher à l'utilisateur. */
export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
