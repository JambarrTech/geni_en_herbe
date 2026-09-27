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

  // --- Serveur HTTP ---
  // Port par défaut du backend. Surchargeable par la variable d'environnement
  // PORT (cf. backend/src/index.ts). Doit rester aligné sur la valeur par
  // défaut des trois vite.config.ts et de scripts/dev.mjs.
  PORT_DEFAULT: 4000,
  JSON_BODY_LIMIT: '1mb',
  // TTL de cache des assets versionnés par hash (immuables)
  STATIC_IMMUTABLE_MAX_AGE_MS: 365 * 24 * 60 * 60 * 1000, // 1 an

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