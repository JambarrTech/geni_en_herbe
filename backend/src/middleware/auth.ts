import { type Request, type Response, type NextFunction } from 'express';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { type AuthenticatedUser, type UserRole } from '../types.ts';
import {
  createSession,
  verifySession,
  revokeSession,
  revokeAllSessionsForUser as revokeAllSessionsForUserStore,
  startSessionPurge,
} from '../lib/sessions.ts';

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

// Les sessions vivent desormais en base (lib/sessions.ts). Les fonctions
// ci-dessous sont le seul point de contact du reste du code avec ce stockage :
// le repli vers une implementation memoire serait tentant, mais il
// reintroduirait exactement le defaut que la table corrige (sessions perdues
// au redemarrage). Elles sont donc asynchrones et propagent leurs erreurs.
export { verifySession };

/** Ouvre une session pour un utilisateur authentifie. */
export async function registerSessionToken(
  user: AuthenticatedUser,
  context: { ip?: string | null; userAgent?: string | null } = {}
): Promise<string> {
  return createSession(user, context);
}

export async function revokeSessionToken(token: string): Promise<void> {
  await revokeSession(token);
}

/**
 * Revoque immediatement toutes les sessions d'un utilisateur.
 * A appeler des qu'un compte est desactive, retrograde ou supprime : sans cela,
 * une session ouverte conserverait ses droits jusqu'a l'expiration (12 h).
 */
export async function revokeAllSessionsForUser(userId: number): Promise<number> {
  return revokeAllSessionsForUserStore(userId);
}

// La purge des sessions echues n'est plus un balayage en memoire : c'est un
// DELETE par tranches sur la table (voir lib/sessions.ts). Elle demarre a
// l'import du module, donc dans chacun des quatre processus — sans effet
// notable, chacun n'ayant qu'une ligne de purge a executer par heure.
startSessionPurge();

/**
 * Resout un jeton sans effet de bord.
 * Retourne l'utilisateur authentifie, ou null. Utilise par le WebSocket.
 */
export async function verifyToken(token: string): Promise<AuthenticatedUser | null> {
  if (!token) return null;
  return verifySession(token);
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autorisé : Jeton d\'authentification manquant' });
  }

  const token = authHeader.split('Bearer ')[1].trim();

  // Une session invalide se distingue ici entre « echue » et « compte
  // desactive », parce que les deux ne demandent pas la meme chose a
  // l'utilisateur : la premiere se resout en se reconnectant, la seconde
  // exige de contacter un administrateur.
  const user = await verifySession(token);
  if (!user) {
    return res.status(401).json({
      error: 'Session invalide ou expiree, veuillez vous reconnecter',
    });
  }

  req.user = user;
  return next();
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs AEERKS' });
  }
  next();
};

export const requireJuryOrAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user || (req.user.role !== 'JURY' && req.user.role !== 'ADMIN')) {
    return res.status(403).json({ error: 'Accès réservé au jury et administrateurs' });
  }
  next();
};

/**
 * Recharge un compte actif — exporte pour les tests d'integration.
 * Colonnes explicitement listees : on ne charge jamais `password_hash` pour
 * trancher une simple question d'acces.
 */
export async function loadActiveUserById(id: number): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      uid: users.uid,
      name: users.name,
      email: users.email,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row || !row.active) return null;
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    email: row.email,
    role: row.role as UserRole,
    active: row.active,
  };
}