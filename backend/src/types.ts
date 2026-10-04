export type UserRole = 'ADMIN' | 'JURY';

export interface AuthenticatedUser {
  id: number;
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
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
 * Classement d'une équipe pour UNE catégorie (points marqués sur les
 * questions de cette catégorie, matchs clôturés uniquement).
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
 * Annonce de points diffusée à l'écran public.
 *
 * C'est LA SEULE chose que le public voit des points attribués pendant le
 * match : les totaux affichés sont ceux approuvés par le jury (somme des
 * événements jusqu'à `eventId` inclus), jamais les totaux en direct.
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

export interface LiveStatePayload {
  event: any | null;
  activeMatch: any | null;
  upcomingMatches: any[];
  completedMatches: any[];
  rankings: TeamRanking[];
  resultsPublished: boolean;
  serverTimestamp: number;
}