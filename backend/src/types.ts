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

export interface LiveStatePayload {
  event: any | null;
  activeMatch: any | null;
  upcomingMatches: any[];
  completedMatches: any[];
  rankings: TeamRanking[];
  resultsPublished: boolean;
  serverTimestamp: number;
}