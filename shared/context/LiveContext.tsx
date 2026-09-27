import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { LiveStatePayload } from '../types.ts';
import { APP_CONFIG } from '../lib/config.ts';
import { api, getStoredToken, isAbort } from '../lib/api.ts';

interface LiveContextType {
  liveState: LiveStatePayload | null;
  isConnected: boolean;
  refreshLiveState: () => Promise<void>;
  timerLeft: number;
  timerRunning: boolean;
  /** Âge (ms) du dernier état reçu : permet d'afficher un état périmé. */
  lastUpdateAt: number | null;
}

const LiveContext = createContext<LiveContextType | undefined>(undefined);

/**
 * Au-delà de ce délai sans message du serveur, la connexion est considérée
 * comme morte. Sans ça, un portable en veille garde `readyState === OPEN` sur
 * une connexion TCP morte : l'écran affiche un chrono figé avec la pastille
 * « Direct » au vert.
 */
const STALE_AFTER_MS = APP_CONFIG.WS_STALE_AFTER_MS;

export const LiveProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [liveState, setLiveState] = useState<LiveStatePayload | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [timerLeft, setTimerLeft] = useState<number>(APP_CONFIG.DEFAULT_TIMER_SECONDS);
  const [timerRunning, setTimerRunning] = useState<boolean>(false);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);

  // Dernier message reçu, pour le watchdog d'obsolescence.
  const lastMessageAt = useRef<number>(Date.now());

  const refreshLiveState = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await api.get<LiveStatePayload>('/api/live', { signal });
      setLiveState(data);
      setLastUpdateAt(Date.now());
      if (data.activeMatch) {
        setTimerLeft(data.activeMatch.timerSecondsLeft);
        setTimerRunning(data.activeMatch.timerIsRunning);
      }
    } catch (err) {
      if (!isAbort(err)) {
        console.error('Erreur actualisation état live:', err);
      }
    }
  }, []);

  // Initial load
  useEffect(() => {
    const controller = new AbortController();
    void refreshLiveState(controller.signal);
    return () => controller.abort();
  }, [refreshLiveState]);

  // WebSocket connection (reconnexion avec backoff exponentiel borné)
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelay: number = APP_CONFIG.WS_RECONNECT_DELAY_MS;
    let disposed = false;

    function connect() {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Jeton transmis : le serveur peut alors distinguer un client staff
      // authentifié du flux public. (Absent => flux public, inchangé.)
      const token = getStoredToken();
      const wsUrl = token
        ? `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`
        : `${protocol}//${window.location.host}/ws`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        reconnectDelay = APP_CONFIG.WS_RECONNECT_DELAY_MS;
        setIsConnected(true);
        // Re-synchronisation : sans elle, un coupure réseau laisse l'écran
        // public reconnecté sur un chrono figé et des scores périmés, avec la
        // pastille « Direct » revenue au vert. On repart de l'état serveur.
        lastMessageAt.current = Date.now();
        void refreshLiveState();
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        if (disposed) return;
        // Une fermeture volontaire du serveur (1000) ou un refus d'authentification
        // (1008/1011) ne se répare pas en reconnectant : on arrête la boucle
        // plutôt que de marteler le serveur toutes les 2 s pendant 12 heures.
        const terminal =
          event.code === 1000 ||
          event.code === APP_CONFIG.WS_CLOSE_INVALID_AUTH ||
          event.code === APP_CONFIG.WS_CLOSE_VERIFY_ERROR;
        if (terminal) {
          console.warn(`WebSocket fermé définitivement (code ${event.code}) : pas de reconnexion.`);
          return;
        }
        reconnectTimeout = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(
          reconnectDelay * 2,
          APP_CONFIG.WS_RECONNECT_MAX_DELAY_MS
        );
      };

      ws.onerror = () => {
        // L'erreur est suivie de `close` : on se contente de fermer.
        ws?.close();
      };

      ws.onmessage = (event) => {
        lastMessageAt.current = Date.now();
        setLastUpdateAt(Date.now());
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'connected') {
            return;
          }

          if (message.type === 'timer_tick') {
            setTimerLeft(message.data.timerSecondsLeft);
            setTimerRunning(message.data.timerIsRunning);
          } else if (message.type === 'timer_expired') {
            setTimerLeft(0);
            setTimerRunning(false);
          } else if (
            message.type === 'score_updated' ||
            message.type === 'question_changed' ||
            message.type === 'timer_synced' ||
            message.type === 'match_started' ||
            message.type === 'match_paused' ||
            message.type === 'match_resumed' ||
            message.type === 'match_finished' ||
            message.type === 'results_published' ||
            message.type === 'results_unpublished'
          ) {
            if (message.data?.liveState) {
              setLiveState(message.data.liveState);
              if (message.data.liveState.activeMatch) {
                setTimerLeft(message.data.liveState.activeMatch.timerSecondsLeft);
                setTimerRunning(message.data.liveState.activeMatch.timerIsRunning);
              }
            } else {
              // Full refresh
              void refreshLiveState();
            }
          }
        } catch (e) {
          console.error('Erreur parsing WebSocket message:', e);
        }
      };
    }

    connect();

    // Watchdog : si rien n'arrive depuis trop longtemps, la connexion est
    // présumée morte. Force une resynchronisation et laisse le cycle de
    // reconnexion normal reprendre la main si le socket est réellement mort.
    const watchdog = setInterval(() => {
      if (Date.now() - lastMessageAt.current > STALE_AFTER_MS) {
        console.warn('WebSocket silencieux : resynchronisation forcée.');
        lastMessageAt.current = Date.now();
        void refreshLiveState();
        try {
          ws?.close();
        } catch {
          /* déjà fermé */
        }
      }
    }, Math.max(2000, Math.floor(STALE_AFTER_MS / 3)));

    // Retour de suspension / reprise réseau : le socket est souvent mort sans
    // qu'aucun événement ne soit émis.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        lastMessageAt.current = Date.now();
        void refreshLiveState();
        if (ws && ws.readyState !== WebSocket.OPEN) {
          clearTimeout(reconnectTimeout);
          connect();
        }
      }
    };
    const onOnline = () => {
      lastMessageAt.current = Date.now();
      void refreshLiveState();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    return () => {
      disposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (watchdog) clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      if (ws) ws.close();
    };
  }, [refreshLiveState]);

  return (
    <LiveContext.Provider
      value={{
        liveState,
        isConnected,
        refreshLiveState,
        timerLeft,
        timerRunning,
        lastUpdateAt,
      }}
    >
      {children}
    </LiveContext.Provider>
  );
};

export function useLive() {
  const context = useContext(LiveContext);
  if (!context) {
    throw new Error('useLive must be used within a LiveProvider');
  }
  return context;
}
