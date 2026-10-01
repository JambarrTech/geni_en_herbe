import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from '../middleware/auth.ts';
import { subscribe, type BusEvent } from './pubsub.ts';
import { CONFIG } from '../config.ts';
import { createLogger } from '../lib/logger.ts';
import { metrics, renderMetrics } from '../lib/metrics.ts';
import { checkWebSocketOrigin, parseAllowedOrigins } from '../lib/wsOrigin.ts';

const log = createLogger('ws');

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
      metrics.wsBackpressureDrops.inc();
      continue;
    }
    client.send(payload);
    metrics.wsMessages.inc();
  }
}

const PORT = Number(process.env.WS_PORT) || CONFIG.WS_PORT;

const server = http.createServer((req, res) => {
  // Sonde de métriques : cet écran est celui qui expose au scraping le nombre
  // de clients connectés. Doit être traité AVANT la sonde de vivacité, sinon la
  // jauge de connexion n'apparaît qu'après la première connexion.
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderMetrics('ws'));
    return;
  }

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
  // Origine contrôlée AVANT la poignée de main.
  //
  // Le refus doit survenir ici, et pas dans `connection` : une connexion
  // acceptée puis fermée immédiatement se voit comme un succès par le client,
  // qui se reconnecte — boucle de reconnexion sur une origine legitimately
  // refusée, saturation du serveur et bruit dans les journaux. En amont, le
  // navigateur reçoit un refus net et ne retente pas.
  //
  // `verifyClient` est marqué déprécié par la bibliothèque `ws` au profit d'un
  // `upgrade` manuel, mais il reste le seul moyen de refuser avant la
  // poignée de main sans réécrire le câblage HTTP de ce processus. Le
  // déprécié est ici un détail de bibliothèque ; la réécriture, non.
  // Le type est ecrit explicitement : la declaration de la bibliotheque expose
  // un union (sync / async) que l'inference ne resout pas, ce qui laisse les
  // parametres en `any` implicite.
  verifyClient: ({ origin, req }: { origin: string | undefined; req: http.IncomingMessage }) => {
    const decision = checkWebSocketOrigin(
      origin,
      parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS),
      req.headers.host
    );
    if (!decision.allowed) {
      // Journalisé : un refus d'origine est une tentative d'accès, pas un bruit.
      // Le compteur reste à zéro, ce qui alarme plus qu'un compteur
      // d'erreurs techniques.
      log.warn('Connexion WebSocket refusée', {
        origin: decision.origin,
        raison: decision.reason,
      });
      metrics.wsOriginRejected.inc();
    }
    return decision.allowed;
  },
});

wss.on('error', (err) => log.error('Erreur WebSocketServer', { err }));

wss.on('connection', (ws, req) => {
  ws.on('close', () => {
    if (clients.delete(ws)) metrics.wsClients.dec();
  });
  ws.on('error', (err) => {
    log.warn('Erreur WebSocket client', { err });
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
        metrics.wsClients.inc();
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
  metrics.wsClients.inc();
  ws.send(
    JSON.stringify({ type: 'connected', authenticated: false, timestamp: Date.now() })
  );
});

// Abonnement au bus : c'est lui qui remplace le rappel en mémoire.
const unsubscribe = subscribe(
  (event: BusEvent) => {
    fanOut(event.type, event.data);
  },
  (err) => log.error("Bus d'evenements indisponible", { err: err.message })
);

// Heartbeat : sans lui, un écran public inactif ne reçoit rien du serveur, et
// le watchdog client (8 s) ferme et rouvre la connexion en boucle — deux
// requêtes /api/live et un handshake toutes les ~10 s, par client, pour rien.
// Un ping toutes les 5 s maintient la connexion sans trafic d'application.
const heartbeat = setInterval(() => {
  fanOut('ping', { ts: Date.now() });
}, CONFIG.WS_HEARTBEAT_MS);
heartbeat.unref();

server.listen(PORT, '0.0.0.0', () => {
  log.info(`Diffusion temps reel sur ws://0.0.0.0:${PORT}/ws`);
});

const shutdown = (signal: string) => {
  log.info(`Arret demande (${signal}).`);
  unsubscribe();
  clearInterval(heartbeat);
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

process.on('unhandledRejection', (reason) => log.error('Promesse non geree', { err: reason }));
process.on('uncaughtException', (err) => log.error('Exception non interceptee', { err }));
