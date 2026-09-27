// Configuration centralisée des constantes métier et techniques.
// Toute valeur réutilisée doit venir d'ici (ou de competition_settings).
export const CONFIG = {
  // --- Match & déroulé ---
  DEFAULT_MATCH_SIZE: 10,
  DEFAULT_PHASE: 'Phase qualificative',
  DEFAULT_TIMER_SECONDS: 15,
  MIN_TIMER_SECONDS: 1,
  MAX_TIMER_SECONDS: 600,

  // --- Questions ---
  DEFAULT_QUESTION_POINTS: 10,
  MIN_QUESTION_POINTS: 1,
  MAX_QUESTION_POINTS: 500,
  MIN_QUESTION_TIME_SECONDS: 5,
  MAX_QUESTION_TIME_SECONDS: 600,

  // --- Score / ajustement ---
  MAX_ADJUST_POINTS: 1000,

  // --- Équipes ---
  DEFAULT_MAX_TEAM_MEMBERS: 4,

  // --- Auth & sessions ---
  MAX_LOGIN_ATTEMPTS: 5,
  LOGIN_WINDOW_MS: 15 * 60 * 1000,
  TOKEN_PREFIX: 'aeerks_',
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,
  SESSION_SWEEP_INTERVAL_MS: 60 * 60 * 1000,
  ORG_EMAIL_DOMAINS: ['@aeerks.sn', '@ksm.edu.sn'],

  // --- Temps réel ---
  TIMER_LOOP_INTERVAL_MS: 1000,
  // Backoff (2^n) appliqué quand la base est injoignable pour ne pas inonder
  // la console ni marteler la DB : la boucle reste auto-récupérable.
  TIMER_LOOP_MAX_BACKOFF_MS: 30 * 1000,
  TIMER_LOOP_MAX_BACKOFF_STEPS: 5,
  ANTI_DOUBLE_CLICK_MS: 1500,

  // --- Base de données ---
  DB_CONNECT_TIMEOUT_MS: 15 * 1000,
  DB_POOL_MAX: 10,

  // --- Serveurs HTTP (processus séparés) ---
  // L'application est découpée en quatre processus indépendants, chacun sur
  // son port, surchargeable par variable d'environnement. Objectif : qu'un
  // blocage, un crash ou un redéploiement de l'un n'affecte pas les autres.
  //   API      : routes REST /api            -> API_PORT       (ou PORT)
  //   WS       : diffusion temps réel /ws     -> WS_PORT
  //   WORKER   : boucle de chrono (tâche de fond) -> WORKER_PORT (écoute /health)
  //   STATIC   : sert apps/*/dist             -> STATIC_PORT
  API_PORT: 4000,
  WS_PORT: 4001,
  WORKER_PORT: 4002,
  STATIC_PORT: 4003,
  JSON_BODY_LIMIT: '1mb',
  // TTL de cache des assets versionnés par hash (immuables)
  STATIC_IMMUTABLE_MAX_AGE_MS: 365 * 24 * 60 * 60 * 1000, // 1 an

  // --- Bus d'événements inter-processus ---
  // L'API produit les événements, le serveur WS les consomme. Le transport est
  // PostgreSQL LISTEN/NOTIFY : aucune infrastructure supplémentaire, et la
  // livraison n'a lieu qu'au commit de la transaction émettrice.
  PUBSUB_CHANNEL: 'aeerks_events',
  PUBSUB_RECONNECT_MS: 3000,
  // Intervalle du heartbeat WebSocket. Sans lui, un écran public inactif ne
  // reçoit rien du serveur et le watchdog client (8 s) boucle en reconnexion.
  WS_HEARTBEAT_MS: 5000,

  // --- Limitation de débit ---
  // La protection anti-double-clic du client n'est pas une sécurité : il suffit
  // de ne pas utiliser le client, ou d'en ouvrir plusieurs en parallèle. Ces
  // quotas protègent le journal de score et l'état du chrono.
  //
  // Volontairement larges pour ne jamais gêner un usage humain : un membre du
  // jury qui attribue des points en continu reste très en dessous, tandis
  // qu'un script de flood sature immediatement.
  RATE_LIMIT: {
    // Attribution et ajustement de score : l'opération la plus sensible.
    SCORE: { limit: 30, windowMs: 10_000 },
    // Pilotage du chrono et de la progression : actions délibérées, peu fréquentes.
    MATCH_CONTROL: { limit: 20, windowMs: 10_000 },
    // Création / modification / suppression côté comité.
    ADMIN_WRITE: { limit: 30, windowMs: 10_000 },
    // Connexion : serré, et par couple email + IP (et non par IP seule, sinon
    // toute la salle de compétition se bloque mutuellement).
    LOGIN: { limit: 5, windowMs: 15 * 60_000 },
  },

  // --- WebSocket ---
  WS_CLOSE_INVALID_AUTH: 1008,
  WS_CLOSE_VERIFY_ERROR: 1011,
  WS_MAX_PAYLOAD_BYTES: 1024 * 1024, // 1 Mo
} as const;

// Enums métier : évitent les chaînes en dur dispersées dans la logique
export const FLOW = {
  MATCH_STATUS: {
    SCHEDULED: 'SCHEDULED',
    READY: 'READY',
    LIVE: 'LIVE',
    PAUSED: 'PAUSED',
    FINISHED: 'FINISHED',
    CANCELLED: 'CANCELLED',
  } as const,
  QUESTION_STATUS: {
    PENDING: 'PENDING',
    ACTIVE: 'ACTIVE',
    ANSWERED: 'ANSWERED',
    SKIPPED: 'SKIPPED',
  } as const,
  SCORE_TYPE: {
    ANSWER: 'ANSWER',
    BONUS: 'BONUS',
    PENALTY: 'PENALTY',
    ADJUSTMENT: 'ADJUSTMENT',
  } as const,
  QUESTION_TYPE: {
    DIRECT: 'DIRECT',
    QCM: 'QCM',
    TRUE_FALSE: 'TRUE_FALSE',
    RAPID: 'RAPID',
    BONUS: 'BONUS',
  } as const,
  DIFFICULTY: {
    FACILE: 'FACILE',
    MOYEN: 'MOYEN',
    DIFFICILE: 'DIFFICILE',
  } as const,
  TEAM_ROLE: {
    CAPTAIN: 'CAPTAIN',
    MEMBER: 'MEMBER',
  } as const,
  TEAM_STATUS: {
    ACTIVE: 'ACTIVE',
    DISQUALIFIED: 'DISQUALIFIED',
    INACTIVE: 'INACTIVE',
  } as const,
  EVENT_STATUS: {
    DRAFT: 'DRAFT',
    REGISTRATION: 'REGISTRATION',
    READY: 'READY',
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    FINISHED: 'FINISHED',
    RESULTS_PENDING: 'RESULTS_PENDING',
    RESULTS_PUBLISHED: 'RESULTS_PUBLISHED',
    ARCHIVED: 'ARCHIVED',
  } as const,
} as const;
