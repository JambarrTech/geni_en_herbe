export type UserRole = 'ADMIN' | 'JURY';

export interface UserProfile {
  id: number;
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export type EventStatus =
  | 'DRAFT'
  | 'REGISTRATION'
  | 'READY'
  | 'RUNNING'
  | 'PAUSED'
  | 'FINISHED'
  | 'RESULTS_PENDING'
  | 'RESULTS_PUBLISHED'
  | 'ARCHIVED';

export interface EventItem {
  id: number;
  name: string;
  edition: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  location: string;
  status: EventStatus;
  resultsPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantItem {
  id: number;
  firstName: string;
  lastName: string;
  gender: string;
  dateOfBirth?: string | null;
  phone?: string | null;
  email?: string | null;
  photo?: string | null;
  active: boolean;
  createdAt: string;
}

export interface TeamMemberItem {
  id: number;
  teamId: number;
  participantId: number;
  role: 'CAPTAIN' | 'MEMBER';
  participant?: ParticipantItem;
}

export interface TeamItem {
  id: number;
  eventId: number;
  name: string;
  code: string;
  logo?: string | null;
  status: 'ACTIVE' | 'DISQUALIFIED' | 'INACTIVE';
  createdAt: string;
  membersCount?: number;
  members?: TeamMemberItem[];
}

export interface CategoryItem {
  id: number;
  name: string;
  description?: string | null;
  /** Ordre d'affichage : 1 = première catégorie (écran public, banque groupée). */
  position: number;
  active: boolean;
  createdAt: string;
  questionsCount?: number;
}

export type QuestionType = 'DIRECT' | 'QCM' | 'TRUE_FALSE' | 'RAPID' | 'BONUS';
export type QuestionDifficulty = 'FACILE' | 'MOYEN' | 'DIFFICILE';

export interface QuestionItem {
  id: number;
  categoryId: number;
  categoryName?: string;
  eventId?: number | null;
  text: string;
  answer: string;
  type: QuestionType;
  difficulty: QuestionDifficulty;
  points: number;
  timeLimitSeconds: number;
  /** Ordre dans la catégorie : 1 = première question du groupe. */
  position: number;
  options?: string[] | null;
  explanation?: string | null;
  mediaUrl?: string | null;
  active: boolean;
  createdAt: string;
}

export type MatchStatus = 'SCHEDULED' | 'READY' | 'LIVE' | 'PAUSED' | 'FINISHED' | 'CANCELLED';

export interface MatchQuestionItem {
  id: number;
  matchId: number;
  questionId: number;
  orderNumber: number;
  status: 'PENDING' | 'ACTIVE' | 'ANSWERED' | 'SKIPPED';
  pointsAwarded: number;
  winningTeamId?: number | null;
  question?: QuestionItem;
}

/**
 * Étape du scénario de diffusion sur l'écran public.
 *
 * Doublon assumé de `backend/src/lib/broadcastFlow.ts` : le backend et les
 * frontends sont des paquets distincts (`shared/` n'est pas importable depuis
 * `backend/src/`), donc l'énumération est écrite deux fois. Elle ne doit pas
 * être dérivée d'un `typeof` côté backend — le front ne compile pas le backend.
 * Toute evolution doit être répercutée dans les deux fichiers ; les tests de
 * `backend/test/broadcastFlow.test.mjs` verrouillent la séquence côté serveur.
 */
export type BroadcastStage = 'ROSTER' | 'QUESTION' | 'ANSWER_A' | 'ANSWER_B' | 'REVEAL' | 'FINAL';

/**
 * Membre d'équipe dans la forme diffusée publiquement.
 *
 * Trois champs, et rien d'autre : ni identifiant de participant, ni genre, ni
 * photo, ni coordonnées. Le typage interdit ici ce que la requête
 * `loadPublicRosters` n'exporte pas — voir `backend/src/lib/publicRoster.ts`.
 */
export interface PublicTeamMember {
  firstName: string;
  lastName: string;
  role: string;
}

/** Position du scénario de diffusion, telle que calculée par le serveur. */
export interface MatchBroadcast {
  stage: BroadcastStage;
  /** Index 0-based de la question sur laquelle se pose l'étape. */
  questionIndex: number;
  questionCount: number;
  /** Rang de l'étape dans le scénario, 1-based. */
  stepNumber: number;
  totalSteps: number;
  /** Une étape existe-t-elle après celle-ci ? */
  canAdvance: boolean;
  /** Une étape existe-t-elle avant celle-ci ? */
  canRewind: boolean;
  /** La bonne réponse est-elle diffusée à cette étape ? */
  revealsAnswer: boolean;
  /** L'effectif des équipes est-il diffusé à cette étape ? */
  showsRoster: boolean;
  /**
   * Instantan où l'écran quittera seul l'effectif des équipes.
   *
   * `null` quand aucune bascule n'est programmée : soit l'étape courante n'est
   * pas l'effectif, soit le jury a pris le contrôle (relance d'un match déjà
   * entamé).
   *
   * Envoyé pour que le jury VOIE que l'écran va bouger sans lui. Une bascule
   * automatique qu'il ne voit pas venir est pire qu'une absence de bascule : au
   * milieu d'une phrase, l'écran change sous ses yeux et il ne sait pas si c'est
   * prévu.
   */
  rosterUntil?: string | null;
}

export interface MatchItem {
  id: number;
  eventId: number;
  phase: string;
  matchNumber: number;
  teamAId: number;
  teamBId: number;
  teamA?: PublicTeamItem;
  teamB?: PublicTeamItem;
  juryId?: number | null;
  juryName?: string | null;
  status: MatchStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  currentQuestionIndex: number;
  currentQuestionId?: number | null;
  /**
   * Question affichée publiquement.
   *
   * `answer` n'est présent QUE si le scénario est à l'étape `REVEAL` : la
   * réponse officielle est retirée par `publicQuestion()` sur toutes les autres
   * étapes. Ne pas la reconstruire côté client — elle n'y est pas.
   */
  currentQuestion?: (QuestionItem & { answer?: string }) | null;
  scoreA: number;
  scoreB: number;
  timerSecondsLeft: number;
  timerIsRunning: boolean;
  timerStartedAt?: string | null;
  timerDuration: number;
  activeTeamTurn?: 'team_a' | 'team_b' | 'all' | null;
  matchQuestions?: MatchQuestionItem[];
  /** Scénario de diffusion du match — absent sur les matchs non diffusés. */
  broadcast?: MatchBroadcast;
  /**
   * Le public voit-il les scores pendant ce match ?
   *
   * `false` (défaut pendant le match) = totaux affichés = totaux approuvés
   * par le jury. `true` = des points ont été attribués depuis la dernière
   * diffusion : l'écran masque les scores jusqu'à la prochaine diffusion.
   */
  scoresHidden?: boolean;
  /** Dernière annonce de points diffusée — `null` si rien à montrer. */
  diffusedScore?: DiffusedScore | null;
}

/**
 * Équipe dans la forme renvoyée publiquement.
 *
 * `members` est REMPLACÉ, pas étendu : `TeamItem.members` est de type
 * `TeamMemberItem[]`, c'est-à-dire la forme staff — elle porte l'identifiant du
 * participant et l'objet `participant`. Un élément de ce type ne peut donc pas
 * être affecté à un `PublicTeamItem[]`, et l'erreur de type Protège l'écran
 * public d'y faire glisser par erreur la forme riche.
 *
 * Le champ n'est peuplé qu'à l'étape `ROSTER` du scénario ; voir
 * `loadPublicRosters` côté serveur.
 */
export type PublicTeamItem = Omit<TeamItem, 'members'> & {
  members?: PublicTeamMember[];
};

export interface ScoreEventItem {
  id: number;
  matchId: number;
  teamId: number;
  teamName?: string;
  questionId?: number | null;
  points: number;
  type: 'ANSWER' | 'BONUS' | 'PENALTY' | 'ADJUSTMENT';
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface TeamRanking {
  position: number;
  teamId: number;
  teamName: string;
  teamCode: string;
  matchesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  pointsScored: number;
  pointsConceded: number;
  pointsDifference: number;
  totalScore: number;
}

/**
 * Classement d'une équipe pour UNE catégorie : points marqués sur les
 * questions de cette catégorie (matchs clôturés uniquement, comme le
 * classement général). Les ajustements manuels sans question rattachée ne
 * comptent dans aucune catégorie.
 */
export interface CategoryStanding {
  position: number;
  teamId: number;
  teamName: string;
  teamCode: string;
  points: number;
  questionsAnswered: number;
}

export interface CategoryRankings {
  categoryId: number;
  categoryName: string;
  categoryPosition: number;
  standings: CategoryStanding[];
}

/**
 * Annonce de points diffusée à l'écran public (voir backend `types.ts`).
 */
export interface DiffusedScore {
  eventId: number;
  teamId: number;
  teamName: string;
  teamCode: string;
  points: number;
  type: string;
  reason: string;
  questionId: number | null;
  /** Index 0-based de la question dans la série du match, `null` si hors série. */
  questionIndex: number | null;
  createdAt: string;
}

export interface AuditLogItem {
  id: number;
  userId?: string | null;
  userEmail?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: string | null;
  createdAt: string;
}

export interface UserItem {
  id: number;
  uid: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'JURY';
  active: boolean;
  createdAt: string;
}

export interface LiveStatePayload {
  event: EventItem | null;
  activeMatch: MatchItem | null;
  upcomingMatches: MatchItem[];
  completedMatches: MatchItem[];
  rankings: TeamRanking[];
  resultsPublished: boolean;
  serverTimestamp: number;
}
