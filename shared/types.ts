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

export interface MatchItem {
  id: number;
  eventId: number;
  phase: string;
  matchNumber: number;
  teamAId: number;
  teamBId: number;
  teamA?: TeamItem;
  teamB?: TeamItem;
  juryId?: number | null;
  juryName?: string | null;
  status: MatchStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  currentQuestionIndex: number;
  currentQuestionId?: number | null;
  currentQuestion?: QuestionItem | null;
  scoreA: number;
  scoreB: number;
  timerSecondsLeft: number;
  timerIsRunning: boolean;
  timerStartedAt?: string | null;
  timerDuration: number;
  activeTeamTurn?: 'team_a' | 'team_b' | 'all' | null;
  matchQuestions?: MatchQuestionItem[];
}

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
