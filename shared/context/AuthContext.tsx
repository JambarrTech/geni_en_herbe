import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { UserProfile } from '../types.ts';
// Aucun import Firebase : la connexion Google a été retirée de l'interface.
// Le chemin Firebase reste implémenté côté serveur (voir README § Sécurité).
import { api, setStoredToken, setUnauthorizedHandler } from '../lib/api.ts';

interface AuthContextType {
  user: UserProfile | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, pass: string) => Promise<UserProfile>;
  logout: () => void;
  isAdmin: boolean;
  isJury: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem('aeerks_token');
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  /** Nettoyage local sans appel réseau (déconnexion locale, 401, onglet croisé). */
  const clearLocalSession = useCallback(() => {
    setStoredToken(null);
    setToken(null);
    setUser(null);
  }, []);

  // Session expirée / compte désactivé / droits modifiés : un seul point de
  // déconnexion pour toute l'application. Avant, chaque écran se retrouvait
  // simplement vide et muet.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearLocalSession();
    });
    return () => setUnauthorizedHandler(null);
  }, [clearLocalSession]);

  // Déconnexion dans un autre onglet : le jeton révoqué ne doit pas rester
  // vivant dans les onglets restants.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'aeerks_token' && e.newValue === null) {
        clearLocalSession();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [clearLocalSession]);

  // Validate existing token on mount
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function checkCurrentAuth() {
      let storedToken: string | null = null;
      try {
        storedToken = localStorage.getItem('aeerks_token');
      } catch {
        storedToken = null;
      }
      if (!storedToken) {
        if (!cancelled) setIsLoading(false);
        return;
      }

      try {
        const data = await api.get<{ user: UserProfile }>('/api/auth/me', {
          headers: { Authorization: `Bearer ${storedToken}` },
          token: storedToken,
          signal: controller.signal,
        });
        if (cancelled) return;
        setUser(data.user);
        setToken(storedToken);
      } catch {
        if (cancelled) return;
        // Jeton invalide, expiré, ou compte désactivé : on purge.
        clearLocalSession();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    checkCurrentAuth();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [clearLocalSession]);

  const login = async (email: string, pass: string): Promise<UserProfile> => {
    const data = await api.post<{ token: string; user: UserProfile }>(
      '/api/auth/login',
      { email, password: pass },
      { token: null }
    );
    setUser(data.user);
    setToken(data.token);
    setStoredToken(data.token);
    return data.user;
  };

  const logout = () => {
    const currentToken = (() => {
      try {
        return localStorage.getItem('aeerks_token');
      } catch {
        return null;
      }
    })();

    // Révoque la session serveur (comptes email/mot de passe) avant nettoyage local.
    if (currentToken) {
      void api.post('/api/auth/logout', undefined, { token: currentToken }).catch(() => {
        /* déconnexion locale déjà effectuée : rien à signaler */
      });
    }
    clearLocalSession();
  };

  const isAdmin = user?.role === 'ADMIN';
  const isJury = user?.role === 'JURY' || user?.role === 'ADMIN';

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        login,
        logout,
        isAdmin,
        isJury,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
