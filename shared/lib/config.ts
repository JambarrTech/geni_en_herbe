// Configuration centralisée côté client : valeurs métier et UI réutilisables.
export const APP_CONFIG = {
  // Déroulé / match
  DEFAULT_TIMER_SECONDS: 15,
  DEFAULT_QUESTION_POINTS: 10,
  BONUS_POINTS: 5,
  TIMER_WARNING_SECONDS: 5,

  // Réglage d'ajustement
  DEFAULT_ADJUST_POINTS: 5,
  ADJUST_QUICK_VALUES: [-10, -5, 5, 10],

  // Événement
  DEFAULT_EVENT_LOCATION: 'Keur Salla Mbatta',
  DEFAULT_EVENT_EDITION: 'Édition 2026',
  DEFAULT_MATCH_PHASE: 'Phase qualificative',

  // Réseau (WebSocket)
  WS_RECONNECT_DELAY_MS: 2000,
  WS_RECONNECT_MAX_DELAY_MS: 15000,
  // Au-delà de ce silence, la connexion est présumée morte (portable en veille,
  // routeur qui coupe) : resynchronisation forcée + reconnexion.
  WS_STALE_AFTER_MS: 8000,
  // Codes de fermeture « définitifs » : on ne reconnecte pas.
  WS_CLOSE_INVALID_AUTH: 1008,
  WS_CLOSE_VERIFY_ERROR: 1011,

  // Feedback UI
  FEEDBACK_DISMISS_MS: 3500,
  // Doit rester >= au CONFIG.ANTI_DOUBLE_CLICK_MS du serveur : sinon
  // l'interface se déverrouille avant la fin de la protection et le jury
  // peut re-cliquer pour déclencher un refus 429.
  ANTI_DOUBLE_CLICK_MS: 1500,
} as const;