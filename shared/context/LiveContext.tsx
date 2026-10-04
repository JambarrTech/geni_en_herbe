import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { LiveStatePayload } from '../types.ts';
import { APP_CONFIG } from '../lib/config.ts';
import { api, getStoredToken, isAbort } from '../lib/api.ts';
import { resolveWsUrl } from '../lib/wsUrl.ts';
import { delaiDeReconnexion, estFermetureDefinitive } from '../lib/wsLifecycle.ts';

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

interface LiveProviderProps {
  children: React.ReactNode;
  /**
   * Joindre le jeton de session à l'URL du WebSocket ?
   *
   * Par défaut `true` (jury, admin). L'écran public passe `false` : il diffuse
   * exactement le même contenu qu'un client authentifié — le serveur se sert du
   * jeton uniquement pour répondre `authenticated: true/false` dans son message
   * `connected`, que ce module ignore — et n'a donc rien à y gagner.
   *
   * Ce n'est pas qu'une économie : `/` et `/jury` partagent la même origine,
   * donc le même `localStorage`. Un poste qui a arbitré conserve son jeton, et
   * l'écran projeté le renvoyait ensuite dans la chaîne de requête du socket —
   * où il atterrit dans les journaux d'accès, les historiques et les outils de
   * diagnostic, pour rien.
   */
  sendToken?: boolean;
}

export const LiveProvider: React.FC<LiveProviderProps> = ({ children, sendToken = true }) => {
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
      // Jeton transmis : le serveur peut alors distinguer un client staff
      // authentifié du flux public. (Absent => flux public, inchangé.)
      // L'écran public demande explicitement l'absence de jeton — cf. le
      // commentaire sur `sendToken`.
      const token = sendToken ? getStoredToken() : null;
      // Par défaut le socket suit l'origine de la page (auto-hébergement, le
      // processus `static` relaie `/ws`). `VITE_WS_URL` ne sert que lorsque
      // l'interface est déployée ailleurs que l'API — le CDN ne relaie pas de
      // WebSocket. Le calcul est isolé et éprouvé dans `lib/wsUrl.ts`.
      const wsUrl = resolveWsUrl({
        host: window.location.host,
        protocol: window.location.protocol,
        token,
        override: import.meta.env.VITE_WS_URL,
      });

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        // Le backoff n'est PAS remis à zéro ici : une socket ouverte puis
        // refermée aussitôt par le serveur n'a rien prouvé de sain, et
        // réinitialiser ici donnerait un essai toutes les 2 s, sans ralentir.
        // La remise à zéro se fait sur le premier message (cf. `onmessage`),
        // qui est la preuve que la connexion fonctionne réellement.
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
        // Une fermeture définitive ne se répare pas en reconnectant : on arrête
        // la boucle plutôt que de marteler le serveur toutes les 2 s pendant
        // 12 heures. La liste est dans `wsLifecycle.ts`, qui la documente —
        // et 1011 (erreur de vérification, donc base injoignable) n'y est pas :
        // cette panne-là se répare en réessayant.
        if (estFermetureDefinitive(event.code)) {
          console.warn(`WebSocket fermé définitivement (code ${event.code}) : pas de reconnexion.`);
          return;
        }
        reconnectTimeout = setTimeout(connect, reconnectDelay);
        reconnectDelay = delaiDeReconnexion(reconnectDelay);
      };

      ws.onerror = () => {
        // L'erreur est suivie de `close` : on se contente de fermer.
        ws?.close();
      };

      ws.onmessage = (event) => {
        // Premier message reçu = connexion réellement fonctionnelle : c'est
        // ici, et seulement ici, que le backoff repart de sa valeur de départ.
        // Une reconnexion réussie doit rester rapide ; une connexion que le
        // serveur referme sans rien envoyer, elle, doit continuer de ralentir.
        reconnectDelay = APP_CONFIG.WS_RECONNECT_DELAY_MS;
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
            message.type === 'score_diffused' ||
            message.type === 'question_changed' ||
            message.type === 'timer_synced' ||
            message.type === 'match_started' ||
            message.type === 'match_paused' ||
            message.type === 'match_resumed' ||
            message.type === 'match_finished' ||
            message.type === 'match_deleted' ||
            message.type === 'match_cancelled' ||
            message.type === 'match_restored' ||
            message.type === 'broadcast_step' ||
            message.type === 'questions_reordered' ||
            message.type === 'team_deleted' ||
            message.type === 'results_published' ||
            message.type === 'results_unpublished'
          ) {
            if (message.data?.liveState) {
              const incoming = message.data.liveState;
              // Fusion plutôt que remplacement : les diffusions qui ne portent
              // pas de classement (score_updated, question_changed…) ne doivent
              // PAS effacer le podium. En remplaçant le state entier, chaque
              // point attribué vidait le classement de l'écran public.
              setLiveState((prev) => {
                if (!prev) return incoming;
                return {
                  ...incoming,
                  // Conserve le classement précédent si la diffusion n'en apporte
                  // pas (tableau vide = absence, pas "pas de classement").
                  rankings:
                    incoming.rankings.length > 0 ? incoming.rankings : prev.rankings,
                };
              });
              if (incoming.activeMatch) {
                setTimerLeft(incoming.activeMatch.timerSecondsLeft);
                setTimerRunning(incoming.activeMatch.timerIsRunning);
              } else if (incoming.event === null) {
                // Aucun match actif : le chrono est à l'arrêt.
                setTimerRunning(false);
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
  }, [refreshLiveState, sendToken]);

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
