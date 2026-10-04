// Configuration centralisée côté client : valeurs métier et UI réutilisables.
export const APP_CONFIG = {
  // Déroulé / match
  DEFAULT_TIMER_SECONDS: 15,
  DEFAULT_QUESTION_POINTS: 10,
  BONUS_POINTS: 5,
  // Taille par défaut d'une série de match (sélection automatique). Miroir
  // de `CONFIG.DEFAULT_MATCH_SIZE` côté serveur : l'admin peut la relever à
  // la création pour faire jouer TOUTE la banque.
  DEFAULT_MATCH_SIZE: 10,
  // Droit de réplique du vis-à-vis : quand une équipe manque sa réponse sur
  // la question courante, SEULE l'équipe adverse peut répliquer, pour ces
  // points (règle collective 20 pts, réplique 10 pts). Distinct du bonus, qui
  // ne suppose aucun échec préalable. Miroir de `CONFIG` côté serveur : le
  // serveur ne connaît que des points, c'est l'interface qui porte la règle.
  REPLIQUE_POINTS: 10,
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
  // Codes de fermeture émis par le serveur (cf. `lib/wsLifecycle.ts`, qui
  // décide lequel est définitif).
  //
  // 1011 n'est PAS définitif malgré son numéro d'erreur interne : le serveur
  // l'emploie quand la vérification du jeton a échoué, donc quand la base n'a
  // pas répondu. Cette panne se répare en réessayant. C'est précisément pour
  // cette raison que la liste des codes à ne pas réessayer vit dans
  // `wsLifecycle.ts` et non dans cette constante.
  WS_CLOSE_INVALID_AUTH: 1008,
  WS_CLOSE_VERIFY_ERROR: 1011,

  // Feedback UI
  FEEDBACK_DISMISS_MS: 3500,
  // Doit rester >= au CONFIG.ANTI_DOUBLE_CLICK_MS du serveur : sinon
  // l'interface se déverrouille avant la fin de la protection et le jury
  // peut re-cliquer pour déclencher un refus 429.
  ANTI_DOUBLE_CLICK_MS: 1500,
} as const;