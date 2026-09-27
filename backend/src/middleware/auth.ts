import { type Request, type Response, type NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { eq, count } from 'drizzle-orm';
import { type AuthenticatedUser, type UserRole } from '../types.ts';
import { CONFIG } from '../config.ts';

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

// In-memory sessions (issued on successful email/password login)
const SESSION_TTL_MS = CONFIG.SESSION_TTL_MS;
interface SessionEntry {
  user: AuthenticatedUser;
  expiresAt: number;
}
const sessionTokens = new Map<string, SessionEntry>();
// Index secondaire user.id -> tokens, pour pouvoir révoquer d'un coup toutes les
// sessions d'un compte (désactivation, rétrogradation, suppression).
const sessionsByUser = new Map<number, Set<string>>();

export function registerSessionToken(token: string, user: AuthenticatedUser) {
  sessionTokens.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  let tokens = sessionsByUser.get(user.id);
  if (!tokens) {
    tokens = new Set<string>();
    sessionsByUser.set(user.id, tokens);
  }
  tokens.add(token);
}

export function revokeSessionToken(token: string) {
  const entry = sessionTokens.get(token);
  sessionTokens.delete(token);
  if (entry) {
    sessionsByUser.get(entry.user.id)?.delete(token);
  }
}

/**
 * Révoque immédiatement toutes les sessions d'un utilisateur.
 * À appeler dès qu'un compte est désactivé, rétrogradé ou supprimé : sans cela,
 * une session déjà ouverte conserverait ses droits jusqu'à l'expiration (12 h).
 */
export function revokeAllSessionsForUser(userId: number) {
  const tokens = sessionsByUser.get(userId);
  if (!tokens) return 0;
  const n = tokens.size;
  for (const token of tokens) {
    sessionTokens.delete(token);
  }
  tokens.clear();
  sessionsByUser.delete(userId);
  return n;
}

// Sweep des sessions expirées (évite la fuite mémoire)
setInterval(
  () => {
    const now = Date.now();
    for (const [token, entry] of sessionTokens) {
      if (entry.expiresAt <= now) {
        sessionTokens.delete(token);
        sessionsByUser.get(entry.user.id)?.delete(token);
      }
    }
    // Purge des index d'utilisateurs devenus vides
    for (const [userId, tokens] of sessionsByUser) {
      if (tokens.size === 0) sessionsByUser.delete(userId);
    }
  },
  CONFIG.SESSION_SWEEP_INTERVAL_MS
).unref();

/**
 * Resout un compte en base à partir de son identifiant interne.
 * Colonnes explicitement listées : on ne charge jamais `password_hash` pour
 * trancher une simple question d'accès.
 */
async function loadActiveUserById(id: number): Promise<AuthenticatedUser | null> {
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

async function loadActiveUserByUid(uid: string): Promise<AuthenticatedUser | null> {
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
    .where(eq(users.uid, uid))
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

function toAuthenticatedUser(row: {
  id: number;
  uid: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
}): AuthenticatedUser {
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    email: row.email,
    role: row.role as UserRole,
    active: row.active,
  };
}

// Valide un jeton (session locale ou Firebase ID token) sans faire d'effet de bord.
// Retourne l'utilisateur authentifié, ou null. Utile pour le WebSocket.
export async function verifyToken(token: string): Promise<AuthenticatedUser | null> {
  if (!token) return null;

  // 1. Custom session token (email/password)
  const session = sessionTokens.get(token);
  if (session) {
    if (session.expiresAt <= Date.now()) {
      revokeSessionToken(token);
      return null;
    }
    // Revalidation systématique : la session porte un instantané figé au login.
    // Sans cette lecture, un compte désactivé ou rétrogradé conserverait ses
    // droits jusqu'à l'expiration du jeton.
    const fresh = await loadActiveUserById(session.user.id);
    if (!fresh) {
      revokeSessionToken(token);
      return null;
    }
    return fresh;
  }

  // 2. Firebase ID token (comptes existants uniquement)
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return await loadActiveUserByUid(decoded.uid);
  } catch {
    return null;
  }
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

  // 1. Check custom session token (email/password)
  const session = sessionTokens.get(token);
  if (session) {
    if (session.expiresAt <= Date.now()) {
      revokeSessionToken(token);
      return res.status(401).json({ error: 'Session expirée, veuillez vous reconnecter' });
    }
    // Revalidation en base : désactivation et changement de rôle prennent effet
    // immédiatement, sans attendre l'expiration du jeton.
    const fresh = await loadActiveUserById(session.user.id);
    if (!fresh) {
      revokeSessionToken(token);
      return res.status(401).json({
        error: 'Compte inactif ou droits modifiés. Veuillez vous reconnecter.',
      });
    }
    req.user = fresh;
    return next();
  }

  // 2. Check Firebase ID token
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const existing = await loadActiveUserByUid(decoded.uid);

    if (existing) {
      if (!existing.active) {
        return res.status(403).json({ error: 'Compte désactivé' });
      }
      req.user = existing;
      return next();
    }

    // New account (Google sign-in) : ADMIN uniquement pour le premier compte
    // ou pour un email sur un domaine de l'organisation AEERKS.
    // `count(*)` au lieu de SELECT * : on ne charge pas la table entière
    // (et ses empreintes de mots de passe) pour tester la vacuité.
    const [row] = await db.select({ total: count() }).from(users);
    const isFirstUser = (row?.total ?? 0) === 0;
    const email = decoded.email?.toLowerCase() ?? '';
    const isOrganizationEmail = CONFIG.ORG_EMAIL_DOMAINS.some((domain) =>
      email.endsWith(domain)
    );
    const role: UserRole = isFirstUser || isOrganizationEmail ? 'ADMIN' : 'JURY';

    const [newUser] = await db
      .insert(users)
      .values({
        uid: decoded.uid,
        name: decoded.name || decoded.email?.split('@')[0] || 'Utilisateur AEERKS',
        email: decoded.email || `${decoded.uid}@aeerks.sn`,
        role,
        active: true,
      })
      .returning();

    req.user = toAuthenticatedUser(newUser);
    return next();
  } catch (error) {
    console.error('Erreur de validation token Firebase:', error);
    return res.status(401).json({ error: 'Jeton invalide ou expiré' });
  }
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
