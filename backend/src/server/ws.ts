import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from '../middleware/auth.ts';
import { subscribe, type BusEvent } from './pubsub.ts';
import { CONFIG } from '../config.ts';

/**
 * Processus de diffusion temps réel.
 *
 * Isolé de l'API : il ne reçoit plus les `broadcast()` par rappel en mémoire,
 * mais par le bus PostgreSQL LISTEN/NOTIFY (`./pubsub.ts`). Conséquences :
 *  - un redémarrage de l'API n'interrompt pas les écrans ;
 *  - si ce serveur tombe, l'API continue de fonctionner et les clients se
 *    resynchronisent au retour de la connexion (`refreshLiveState`).
 *
 * Ce processus ne sert QUE `/ws` et une sonde de vivacité. Il ne touche
 * jamais aux données métier en écriture.
 */
const clients = new Set<WebSocket>();

/** Repli d'un événement à tous les clients connectés. */
function fanOut(event: string, data: unknown) {
  const payload = JSON.stringify({ type: event, data, timestamp: Date.now() });
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // Garde-fou de contre-pression : un client lent (réseau mobile) ferait
    // croître la file d'attente en mémoire sans limite. Au-delà d'un
    // mégaoctet en attente, on le déconnecte ; il se resynchronisera.
    if (client.bufferedAmount > 1024 * 1024) {
      client.terminate();
      continue;
    }
    client.send(payload);
  }
}

const PORT = Number(process.env.WS_PORT) || CONFIG.WS_PORT;

const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      status: 'ok',
      service: 'AEERKS — diffusion',
      clients: clients.size,
    })
  );
});

const wss = new WebSocketServer({
  server,
  maxPayload: CONFIG.WS_MAX_PAYLOAD_BYTES,
});

wss.on('error', (err) => console.error('Erreur WebSocketServer:', err));

wss.on('connection', (ws, req) => {
  ws.on('close', () => clients.delete(ws));
  ws.on('error', (err) => {
    console.error('Erreur WebSocket client:', err);
    clients.delete(ws);
  });

  // Authentification optionnelle : les flux publics (écran live) passent sans
  // jeton ; un jeton présent mais invalide est refusé.
  const url = new URL(req.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token');

  if (token) {
    verifyToken(token)
      .then((user) => {
        if (!user) {
          ws.close(CONFIG.WS_CLOSE_INVALID_AUTH, 'authentification invalide');
          return;
        }
        clients.add(ws);
        ws.send(
          JSON.stringify({ type: 'connected', authenticated: true, timestamp: Date.now() })
        );
      })
      .catch(() => {
        ws.close(CONFIG.WS_CLOSE_VERIFY_ERROR, 'erreur de vérification');
      });
    return;
  }

  clients.add(ws);
  ws.send(
    JSON.stringify({ type: 'connected', authenticated: false, timestamp: Date.now() })
  );
});

// Abonnement au bus : c'est lui qui remplace le rappel en mémoire.
const unsubscribe = subscribe(
  (event: BusEvent) => {
    fanOut(event.type, event.data);
  },
  (err) => console.error("Bus d'événements indisponible:", err.message)
);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[AEERKS ws] Diffusion temps réel sur ws://0.0.0.0:${PORT}/ws`);
});

const shutdown = (signal: string) => {
  console.log(`[AEERKS ws] Arrêt demandé (${signal}).`);
  unsubscribe();
  for (const client of clients) {
    try {
      client.close(1001, 'serveur en arrêt');
    } catch {
      /* ignore */
    }
  }
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => console.error('Promesse non gérée:', reason));
process.on('uncaughtException', (err) => console.error('Exception non interceptée:', err));
