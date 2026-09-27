import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { setBroadcastCallback } from './matchEngine.ts';
import { verifyToken } from '../middleware/auth.ts';
import { CONFIG } from '../config.ts';

const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

export function getConnectedClients(): Set<WebSocket> {
  return clients;
}

export function closeWebSocketServer() {
  if (wss) {
    for (const client of clients) {
      try {
        client.close(1001, 'serveur en arrêt');
      } catch {
        /* ignore */
      }
    }
    wss.close();
    wss = null;
  }
}

export function initWebSocketServer(server: Server) {
  wss = new WebSocketServer({ server, maxPayload: CONFIG.WS_MAX_PAYLOAD_BYTES });

  // Sans ce listener, ws re-émet sur son instance une éventuelle erreur HTTP du
  // serveur (ex. EADDRINUSE) et interrompt l'émission des autres écouteurs.
  wss.on('error', (err) => {
    console.error('Erreur WebSocketServer:', err);
  });

  wss.on('connection', (ws, req) => {
    // Toujours nettoyer le socket (public ET authentifié) à la fermeture
    ws.on('close', () => {
      clients.delete(ws);
    });
    ws.on('error', (err) => {
      console.error('Erreur WebSocket client:', err);
      clients.delete(ws);
    });

    // Authentification optionnelle : les flux publics (écran live) passent sans token,
    // mais un token présent et invalide est refusé (défense en profondeur).
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token');

    if (token) {
      verifyToken(token)
        .then((user) => {
          if (!user) {
            ws.close(CONFIG.WS_CLOSE_INVALID_AUTH, 'authentification invalide');
            return;
          }
          (ws as WebSocket & { authedUser?: unknown }).authedUser = user;
          clients.add(ws);
          ws.send(JSON.stringify({ type: 'connected', authenticated: true, timestamp: Date.now() }));
        })
        .catch(() => {
          ws.close(CONFIG.WS_CLOSE_VERIFY_ERROR, 'erreur de vérification');
        });
      return;
    }

    // Client public
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'connected', authenticated: false, timestamp: Date.now() }));
  });

  // Connect broadcast hook to all connected clients
  setBroadcastCallback((event: string, data: any) => {
    const payload = JSON.stringify({ type: event, data, timestamp: Date.now() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });
}