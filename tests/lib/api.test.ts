import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  ApiError,
  apiFetch,
  isPublicPath,
  setStoredToken,
  getStoredToken,
  setUnauthorizedHandler,
  errorMessage,
  isAbort,
} from '@shared/lib/api';

describe('api — chemins publics', () => {
  it('exemptte les routes listées', () => {
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/api/rankings')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
  });

  it('exemptte les flux live d\'un événement', () => {
    expect(isPublicPath('/api/events/42/live')).toBe(true);
  });

  it('ne ridge pas les routes protégées', () => {
    expect(isPublicPath('/api/matches')).toBe(false);
    expect(isPublicPath('/api/users')).toBe(false);
    expect(isPublicPath('/api/auth/me')).toBe(false);
    // ...ni une route qui contient « live » mais n'est pas un flux public.
    expect(isPublicPath('/api/events/42')).toBe(false);
  });

  it('ignore la query string dans la décision', () => {
    expect(isPublicPath('/api/health?probe=1')).toBe(true);
  });
});

describe('api — stockage du jeton', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('fait l\'aller-retour du jeton', () => {
    expect(getStoredToken()).toBeNull();
    setStoredToken('abc');
    expect(getStoredToken()).toBe('abc');
    setStoredToken(null);
    expect(getStoredToken()).toBeNull();
  });
});

describe('apiFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    window.localStorage.clear();
  });

  it('injecte le jeton stocké sur une route privée', async () => {
    setStoredToken('secret-token');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}',
    });

    await apiFetch('/api/matches');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.get('Authorization')).toBe('Bearer secret-token');
  });

  it('n\'injecte PAS le jeton sur une route publique', async () => {
    setStoredToken('secret-token');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{}',
    });

    await apiFetch('/api/rankings');

    const [, init] = fetchMock.mock.calls[0];
    // Un jeton sur une route publique élargirait la surface d'un XSS : il
    // partirait vers un endpoint qui n'en a pas besoin.
    expect(init.headers.get('Authorization')).toBeNull();
  });

  it('lève une ApiError portant le message du serveur', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"Score invalide"}',
    });

    await expect(apiFetch('/api/matches/1/score')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'Score invalide',
    });
  });

  it('déclenche le handler 401 une seule fois, hors route publique', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"Session expirée"}',
    });

    await expect(apiFetch('/api/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    // Une route publique qui renvoie 401 ne doit PAS appeler le handler : sinon
    // un simple écran public qui n'est pas connecté déconnecterait tout le monde.
    onUnauthorized.mockClear();
    await expect(apiFetch('/api/rankings')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('remonte une ApiError de statut 0 quand le serveur est injoignable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(apiFetch('/api/matches')).rejects.toMatchObject({
      status: 0,
      message: /injoignable/i,
    });
  });

  it('renvoie undefined sur 204 sans corps', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
    });

    await expect(apiFetch('/api/matches/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('api — classification des erreurs', () => {
  it('reconnaît les statuts métier', () => {
    expect(new ApiError(401, 'x').isUnauthorized).toBe(true);
    expect(new ApiError(403, 'x').isForbidden).toBe(true);
    expect(new ApiError(429, 'x').isRateLimited).toBe(true);
    expect(new ApiError(409, 'x').isConflict).toBe(true);
    expect(new ApiError(500, 'x').isUnauthorized).toBe(false);
  });

  it('extrait le message d\'une ApiError', () => {
    expect(errorMessage(new ApiError(400, 'Champ requis'))).toBe('Champ requis');
  });

  it('retombe sur le libellé par défaut pour une erreur inconnue', () => {
    // Une rejection non-typée ne doit jamais afficher « undefined » à
    // l'utilisateur.
    expect(errorMessage({}, 'fallback')).toBe('fallback');
  });

  it('reconnaît une annulation', () => {
    const abort = new DOMException('aborted', 'AbortError');
    expect(isAbort(abort)).toBe(true);
    // Une annulation ne doit jamais être signalée à l'utilisateur : elle n'est
    // pas une erreur, c'est un démontage.
    expect(errorMessage(abort)).toBe('');
  });
});
