import { Client } from 'pg';
import { CONFIG } from '../config.ts';
import { createLogger } from '../lib/logger.ts';

const log = createLogger('bus');

/**
 * Bus d'événements inter-processus, adossé à PostgreSQL LISTEN/NOTIFY.
 *
 * Pourquoi ce mécanisme : la diffusion temps réel était produite par les
 * routes de l'API, via un rappel en mémoire (`setBroadcastCallback`). Depuis
 * que l'API et le serveur WebSocket sont deux processus distincts, ce rappel
 * n'atteint plus personne. Plutôt que d'ajouter un bus externe (Redis…) ou un
 * endpoint interne HTTP à sécuriser, on utilise ce dont on dispose déjà :
 *
 *  - l'API publie `NOTIFY aeerks_events, <json>` après chaque action métier ;
 *  - le serveur WS écoute `LISTEN aeerks_events` et relaie aux clients.
 *
 * Propriétés utiles ici :
 *  - la notification n'est délivrée qu'AU COMMIT de la transaction émettrice,
 *    donc on ne diffuse jamais un score qui n'est pas encore validé ;
 *  - si le serveur WS est arrêté, l'API continue de fonctionner normalement et
 *    les clients se resynchronisent à la reconnexion (`refreshLiveState`) ;
 *  - aucun nouveau service à exploiter, aucun secret à distribuer.
 *
 * Limite assumée : le payload est un texte, PostgreSQL le tronque à 8 000
 * octets. Un `liveState` complet tient largement dedans, mais un envoi trop
 * volumineux serait silencieusement tronqué — `publish` lève dans ce cas.
 */

export interface BusEvent {
  /** Type d'événement, tel qu'attendu par le client (`score_updated`…). */
  type: string;
  data: unknown;
  /** Horodatage d'émission (ms epoch). */
  ts?: number;
}

// 8 Ko : limite documentée de PostgreSQL pour la charge utile de NOTIFY.
const MAX_PAYLOAD_BYTES = 7900;

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL est requis pour le bus d\'événements inter-processus ' +
        '(LISTEN/NOTIFY). Vérifiez backend/.env.'
    );
  }
  return url;
}

/**
 * Publie un événement sur le canal.
 *
 * Si un `client` dédié est fourni (transaction en cours), le NOTIFY part dans
 * cette transaction : la livraison n'aura lieu qu'au commit, ce qui évite de
 * diffuser un score non validé. Sinon il part immédiatement sur le pool.
 */
export async function publish(event: BusEvent, client?: Client): Promise<void> {
  const payload = JSON.stringify({ ...event, ts: event.ts ?? Date.now() });
  const size = Buffer.byteLength(payload, 'utf8');
  if (size > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Événement « ${event.type} » trop volumineux pour NOTIFY (${size} octets > ${MAX_PAYLOAD_BYTES}).`
    );
  }

  if (client) {
    await client.query('SELECT pg_notify($1, $2)', [CONFIG.PUBSUB_CHANNEL, payload]);
    return;
  }

  const { db } = await import('../db/index.ts');
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`SELECT pg_notify(${CONFIG.PUBSUB_CHANNEL}, ${payload})`);
}

/**
 * Abonne un callback au bus et maintient la connexion LISTEN vivante.
 * Rend une fonction de fermeture.
 */
export function subscribe(
  onEvent: (event: BusEvent) => void,
  onError?: (err: Error) => void
): () => void {
  let client: Client | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    try {
      client = new Client({
        connectionString: getConnectionString(),
        ssl: { rejectUnauthorized: true },
      });

      client.on('error', (err) => {
        onError?.(err instanceof Error ? err : new Error(String(err)));
        scheduleReconnect();
      });

      client.on('notification', (msg) => {
        if (msg.channel !== CONFIG.PUBSUB_CHANNEL || !msg.payload) return;
        try {
          onEvent(JSON.parse(msg.payload) as BusEvent);
        } catch (err) {
          log.error('Événement de bus illisible', { err });
        }
      });

      client.connect().then(
        () => client?.query(`LISTEN ${CONFIG.PUBSUB_CHANNEL}`),
        (err) => {
          onError?.(err instanceof Error ? err : new Error(String(err)));
          scheduleReconnect();
        }
      );
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    // Le client LISTEN est dédié : il doit être reconstruit à chaque reconnexion.
    try {
      client?.removeAllListeners();
      void client?.end().catch(() => undefined);
    } catch {
      /* déjà fermé */
    }
    client = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, CONFIG.PUBSUB_RECONNECT_MS);
    reconnectTimer.unref?.();
  }

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      client?.removeAllListeners();
      void client?.end().catch(() => undefined);
    } catch {
      /* déjà fermé */
    }
    client = null;
  };
}
