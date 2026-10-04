import { boolean, date, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// 0. Schools (établissements de rattachement des participants)
//    La table existe déjà en base (migration 0000) : elle est déclarée ici afin que
//    `drizzle-kit generate` n'ait plus à produire de DROP TABLE.
export const schools = pgTable('schools', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  location: text('location'),
  contactName: text('contact_name'),
  contactPhone: text('contact_phone'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 1. Users (Admins and Jurys)
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull().default('JURY'), // 'ADMIN' | 'JURY'
  passwordHash: text('password_hash'), // scrypt: '<salt>:<hash>'
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 2. Events (Editions of Journée d'Excellence)
export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  edition: text('edition').notNull(), // e.g. "Édition 2026"
  description: text('description'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  location: text('location').notNull().default('Keur Salla Mbatta'),
  status: text('status').notNull().default('READY'), // 'DRAFT' | 'REGISTRATION' | 'READY' | 'RUNNING' | 'PAUSED' | 'FINISHED' | 'RESULTS_PENDING' | 'RESULTS_PUBLISHED' | 'ARCHIVED'
  resultsPublished: boolean('results_published').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// 3. Participants (Membres AEERKS : élèves et étudiants)
export const participants = pgTable(
  'participants',
  {
    id: serial('id').primaryKey(),
    schoolId: integer('school_id').references(() => schools.id),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    gender: text('gender').default('M'), // 'M' | 'F'
    dateOfBirth: date('date_of_birth'),
    phone: text('phone'),
    email: text('email'),
    photo: text('photo'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('participants_school_id_idx').on(t.schoolId)]
);

// 4. Teams (Équipes de membres AEERKS)
export const teams = pgTable(
  'teams',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .references(() => events.id)
      .notNull(),
    schoolId: integer('school_id').references(() => schools.id),
    name: text('name').notNull(),
    code: text('code').notNull(),
    logo: text('logo'),
    status: text('status').notNull().default('ACTIVE'), // 'ACTIVE' | 'DISQUALIFIED' | 'INACTIVE'
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('teams_event_id_idx').on(t.eventId), index('teams_school_id_idx').on(t.schoolId)]
);

// 5. Team Members (Relation Participants <-> Équipes)
export const teamMembers = pgTable(
  'team_members',
  {
    id: serial('id').primaryKey(),
    teamId: integer('team_id')
      .references(() => teams.id, { onDelete: 'cascade' })
      .notNull(),
    participantId: integer('participant_id')
      .references(() => participants.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull().default('MEMBER'), // 'CAPTAIN' | 'MEMBER'
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('team_members_team_id_idx').on(t.teamId),
    index('team_members_participant_id_idx').on(t.participantId),
    // Un participant ne peut appartenir qu'à une seule équipe (invariant appliqué côté serveur)
    uniqueIndex('team_members_participant_id_unique').on(t.participantId),
  ]
);

// 6. Categories (Matières / Domaines)
export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  // Ordre d'affichage : 1 = première catégorie à l'écran public et dans la
  // banque groupée. Modifiable par l'admin (réorganisation des catégories).
  position: integer('position').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 7. Questions
export const questions = pgTable(
  'questions',
  {
    id: serial('id').primaryKey(),
    categoryId: integer('category_id')
      .references(() => categories.id)
      .notNull(),
    eventId: integer('event_id').references(() => events.id),
    text: text('text').notNull(),
    answer: text('answer').notNull(),
    type: text('type').notNull().default('DIRECT'), // 'DIRECT' | 'QCM' | 'TRUE_FALSE' | 'RAPID' | 'BONUS'
    difficulty: text('difficulty').notNull().default('MOYEN'), // 'FACILE' | 'MOYEN' | 'DIFFICILE'
    points: integer('points').notNull().default(10),
    timeLimitSeconds: integer('time_limit_seconds').notNull().default(15),
    options: text('options'), // JSON string format for QCM: ["Option A", "Option B", ...]
    explanation: text('explanation'),
    mediaUrl: text('media_url'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('questions_category_id_idx').on(t.categoryId),
    index('questions_event_id_idx').on(t.eventId),
    // Piloté par la sélection de questions : filtre sur active
    index('questions_active_idx').on(t.active),
  ]
);

// 8. Matches
export const matches = pgTable(
  'matches',
  {
    id: serial('id').primaryKey(),
    eventId: integer('event_id')
      .references(() => events.id)
      .notNull(),
    phase: text('phase').notNull().default('Phase de poule'), // e.g. "Poule A", "Quart de finale", "Demi-finale", "Finale"
    matchNumber: integer('match_number').notNull().default(1),
    teamAId: integer('team_a_id')
      .references(() => teams.id)
      .notNull(),
    teamBId: integer('team_b_id')
      .references(() => teams.id)
      .notNull(),
    juryId: integer('jury_id').references(() => users.id),
    status: text('status').notNull().default('SCHEDULED'), // 'SCHEDULED' | 'READY' | 'LIVE' | 'PAUSED' | 'FINISHED' | 'CANCELLED'
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    currentQuestionIndex: integer('current_question_index').notNull().default(0),
    currentQuestionId: integer('current_question_id').references(() => questions.id),
    scoreA: integer('score_a').notNull().default(0),
    scoreB: integer('score_b').notNull().default(0),
    timerSecondsLeft: integer('timer_seconds_left').notNull().default(15),
    timerIsRunning: boolean('timer_is_running').notNull().default(false),
    timerStartedAt: timestamp('timer_started_at'),
    timerDuration: integer('timer_duration').notNull().default(15),
    activeTeamTurn: text('active_team_turn').default('all'), // 'team_a' | 'team_b' | 'all'
    // Étape du scénario de diffusion sur écran public (cf. lib/broadcastFlow.ts).
    //
    // CETTE COLONNE EST UNE PORTE DE SÉCURITÉ, pas un simple libellé d'interface :
    // `getLiveState` n'envoie la réponse officielle au public que si elle vaut
    // 'REVEAL', et l'effectif des équipes que si elle vaut 'ROSTER'. Elle n'est
    // écrite que par la route jury/admin `POST /:id/broadcast-step`.
    //
    // La valeur par défaut est 'ROSTER' : un match qui démarre et dont le jury
    // n'a encore rien diffusé montre l'effectif, ce qui est la première étape du
    // déroulé. Elle est aussi la valeur de repli pour une ligne dont l'étape a
    // été corrompue (cf. `normalizeCursor`).
    broadcastStage: text('broadcast_stage').notNull().default('ROSTER'), // 'ROSTER' | 'QUESTION' | 'ANSWER_A' | 'ANSWER_B' | 'REVEAL' | 'FINAL'
    // Instant limiteau de l'etape `ROSTER`.
    //
    // L'effectif des equipes est la SEULE etape minutee du scenario : au-dela,
    // chaque cran attend le jury, parce que c'est lui qui parle. Au lancement, en
    // revanche, personne n'a encore pris la main — le jury vient d'appuyer sur
    // « Demarrer » et se tourne vers le micro. L'ecranpublic doit donc enchainer
    // tout seul, sans qu'il ait a revenir sur l'ordinateur.
    //
    // Une date, et non un compteur : elle est verifiee par la boucle serveur
    // existante (`timerLoopTick`), qui tourne deja une fois par seconde, et elle
    // survit a un redemarrage. Un `setTimeout` en memoire, lui, perdrait l'effet
    // de la bascule au moindre redemarrage du worker en cours de concours.
    //
    // Invariant : cette date n'existe QUE pendant que l'etape vaut `ROSTER` — elle
    // est posee a l'entree et effacee a la sortie. Sans ca, revenir en arriere
    // sur l'effectif ressusciterait une echeance deja passee, et l'ecran
    // quitterait l'effectif dans la meme seconde ou le jury y revient.
    // Meme convention que `timer_started_at` (timestamp sans fuseau) : la
    // comparaison se fait en JavaScript contre l'horloge murale du serveur, et
    // un melange de `timestamp` et `timestamptz` dans une meme table rendrait
    // cette comparaison dependante d'un decalage silencieux.
    broadcastRosterUntil: timestamp('broadcast_roster_until'),
    // Dernier événement de score que le public a le droit de voir (cf.
    // migration 0009). `null` = rien n'a été diffusé : pendant le match,
    // l'écran masque les scores dès qu'un point est attribué, jusqu'à ce que
    // le jury (ou l'admin) diffuse explicitement.
    //
    // Entier simple SANS clé étrangère, volontairement : `score_events` est
    // déjà en ON DELETE CASCADE depuis `matches`, et une FK croisée rendrait
    // la suppression d'un match dépendante de l'ordre de suppression des
    // événements. L'appartenance au match est vérifiée en code.
    diffusedScoreEventId: integer('diffused_score_event_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('matches_event_id_idx').on(t.eventId),
    index('matches_team_a_id_idx').on(t.teamAId),
    index('matches_team_b_id_idx').on(t.teamBId),
    index('matches_jury_id_idx').on(t.juryId),
    // Boucle de chrono authoritative : SELECT ... WHERE timer_is_running = true / seconde
    index('matches_timer_is_running_idx').on(t.timerIsRunning),
    // getLiveState : filtre par event puis tri sur match_number
    index('matches_event_match_number_idx').on(t.eventId, t.matchNumber),
  ]
);

// 9. Match Questions (Sequence in match)
export const matchQuestions = pgTable(
  'match_questions',
  {
    id: serial('id').primaryKey(),
    matchId: integer('match_id')
      .references(() => matches.id, { onDelete: 'cascade' })
      .notNull(),
    questionId: integer('question_id')
      .references(() => questions.id)
      .notNull(),
    orderNumber: integer('order_number').notNull(),
    status: text('status').notNull().default('PENDING'), // 'PENDING' | 'ACTIVE' | 'ANSWERED' | 'SKIPPED'
    pointsAwarded: integer('points_awarded').notNull().default(0),
    winningTeamId: integer('winning_team_id').references(() => teams.id),
    startedAt: timestamp('started_at'),
    answeredAt: timestamp('answered_at'),
  },
  (t) => [
    index('match_questions_match_id_idx').on(t.matchId),
    index('match_questions_question_id_idx').on(t.questionId),
    // Accès par (match, question) : verrou "question déjà validée" + anti-doublon bonus
    uniqueIndex('match_questions_match_question_unique').on(t.matchId, t.questionId),
    index('match_questions_winning_team_id_idx').on(t.winningTeamId),
  ]
);

// 10. Score Events (Full Audit & Recalculation Trail)
export const scoreEvents = pgTable(
  'score_events',
  {
    id: serial('id').primaryKey(),
    matchId: integer('match_id')
      .references(() => matches.id, { onDelete: 'cascade' })
      .notNull(),
    teamId: integer('team_id')
      .references(() => teams.id)
      .notNull(),
    questionId: integer('question_id').references(() => questions.id),
    points: integer('points').notNull(),
    type: text('type').notNull(), // 'ANSWER' | 'BONUS' | 'PENALTY' | 'ADJUSTMENT'
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(), // user name or email
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    // recalculateMatchScore : SELECT * WHERE match_id = ? (à chaque point)
    index('score_events_match_id_idx').on(t.matchId),
    index('score_events_team_id_idx').on(t.teamId),
    index('score_events_question_id_idx').on(t.questionId),
    // Détection du doublon de bonus : (match, team, question, type)
    index('score_events_bonus_lookup_idx').on(t.matchId, t.teamId, t.questionId, t.type),
  ]
);

// 11. Audit Logs
export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  userId: text('user_id'),
  userEmail: text('user_email'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  metadata: text('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// 12. Competition Settings (Configurable Rules)
export const competitionSettings = pgTable('competition_settings', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value').notNull(),
  description: text('description'),
});

// 13. Sessions (table)
//     Les sessions vivaient dans un Map mémoire du processus API. Deux
//     conséquences, toutes deux annoncees lors d'incidents reels :
//       - un redemarrage, un deploiement ou un worker qui bascule invalide
//         toutes les sessions : le jury doit se reconnecter en pleine
//         competition, sur plusieurs dizaines de postes ;
//       - rien n'est partage entre les instances, donc le deploiement
//         horizontal exige un sticky session, ce qui rend le processus API
//         lui-meme non remplacable.
//     La table supprime les deux contraintes : l'etat est dans PostgreSQL,
//     deja partage, deja sauvegarde, deja repliqueable.
//     CHOLEUR CENTRALE : on stocke l'EMPREINTE du jeton, jamais le jeton.
//     Une lecture de la table (sauvegarde, dump, journal SQL, attaquant
//     ayant obtenu un acces en lecture) ne doit pas pouvoir se transformer en
//     sessions volables. Le client detient le jeton ; la base ne detient que
//     ce qui permet de le recomparer.
export const sessions = pgTable(
  'sessions',
  {
    // hex(sha256(jeton)) : index unique, et le seul moyen de retrouver la
    // ligne d'un jeton presente.
    tokenHash: text('token_hash').notNull().unique(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // Recherche de la ligne par jeton : filtre sur expires_at.
    expiresAt: timestamp('expires_at').notNull(),
    // Dernier usage observe. Sert a la purge (inactivite) et au diagnostic
    // (« cette session est-elle encore utilisee ? »).
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    // Contexte de connexion, pour l'audit : des sessions orphelines se
    // diagnostiquent bien mieux avec une adresse et un user-agent.
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    // Verification d'un jeton : lecture par token_hash (unique, donc deja
    // indexe) — pas besoin d'un second index.
    // Purge periodique : balayage des sessions echues.
    index('sessions_expires_at_idx').on(t.expiresAt),
    // Revocation d'un coup de toutes les sessions d'un compte (desactivation,
    // retrogradation, suppression).
    index('sessions_user_id_idx').on(t.userId),
  ]
);

// Relations
export const eventsRelations = relations(events, ({ many }) => ({
  teams: many(teams),
  matches: many(matches),
  questions: many(questions),
}));

export const participantsRelations = relations(participants, ({ one, many }) => ({
  school: one(schools, {
    fields: [participants.schoolId],
    references: [schools.id],
  }),
  teamMembers: many(teamMembers),
}));

export const schoolsRelations = relations(schools, ({ many }) => ({
  participants: many(participants),
  teams: many(teams),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  event: one(events, {
    fields: [teams.eventId],
    references: [events.id],
  }),
  school: one(schools, {
    fields: [teams.schoolId],
    references: [schools.id],
  }),
  members: many(teamMembers),
  scoreEvents: many(scoreEvents),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
  participant: one(participants, {
    fields: [teamMembers.participantId],
    references: [participants.id],
  }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  questions: many(questions),
}));

export const questionsRelations = relations(questions, ({ one, many }) => ({
  category: one(categories, {
    fields: [questions.categoryId],
    references: [categories.id],
  }),
  event: one(events, {
    fields: [questions.eventId],
    references: [events.id],
  }),
  matchQuestions: many(matchQuestions),
  scoreEvents: many(scoreEvents),
}));

export const matchesRelations = relations(matches, ({ one, many }) => ({
  event: one(events, {
    fields: [matches.eventId],
    references: [events.id],
  }),
  teamA: one(teams, {
    fields: [matches.teamAId],
    references: [teams.id],
  }),
  teamB: one(teams, {
    fields: [matches.teamBId],
    references: [teams.id],
  }),
  jury: one(users, {
    fields: [matches.juryId],
    references: [users.id],
  }),
  matchQuestions: many(matchQuestions),
  scoreEvents: many(scoreEvents),
}));

export const matchQuestionsRelations = relations(matchQuestions, ({ one }) => ({
  match: one(matches, {
    fields: [matchQuestions.matchId],
    references: [matches.id],
  }),
  question: one(questions, {
    fields: [matchQuestions.questionId],
    references: [questions.id],
  }),
}));

export const scoreEventsRelations = relations(scoreEvents, ({ one }) => ({
  match: one(matches, {
    fields: [scoreEvents.matchId],
    references: [matches.id],
  }),
  team: one(teams, {
    fields: [scoreEvents.teamId],
    references: [teams.id],
  }),
}));
