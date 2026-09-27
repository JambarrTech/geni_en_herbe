import { Router, type Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth, requireAdmin, revokeAllSessionsForUser, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { hashPassword } from '../lib/password.ts';
import { adminWriteLimit } from '../middleware/rateLimit.ts';

export const usersRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Projection minimale : jamais de password_hash chargé hors vérification de connexion.
const USER_PUBLIC_COLUMNS = {
  id: users.id,
  uid: users.uid,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

async function countActiveAdmins(): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'ADMIN'), eq(users.active, true)));
  return rows.length;
}

usersRouter.get('/', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const list = await db
      .select(USER_PUBLIC_COLUMNS)
      .from(users)
      .orderBy(desc(users.id));

    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: 'Impossible de charger les comptes' });
  }
});

usersRouter.post('/', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nom, email et mot de passe sont obligatoires' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Adresse email invalide' });
    }
    if (role && !['ADMIN', 'JURY'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide' });
    }

    const [existing] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    if (existing) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cette adresse email' });
    }

    const [newUser] = await db
      .insert(users)
      .values({
        uid: `local_${randomUUID()}`,
        name: name.trim(),
        email: normalizedEmail,
        role: role || 'JURY',
        passwordHash: hashPassword(password),
        active: true,
      })
      .returning();

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'CREATE_USER',
      'user',
      String(newUser.id),
      `Création du compte ${newUser.email} (${newUser.role})`
    );

    res.status(201).json({
      id: newUser.id,
      uid: newUser.uid,
      name: newUser.name,
      email: newUser.email,
      role: newUser.role,
      active: newUser.active,
      createdAt: newUser.createdAt,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la création du compte' });
  }
});

usersRouter.patch('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { role, active } = req.body;

    const [target] = await db.select(USER_PUBLIC_COLUMNS).from(users).where(eq(users.id, id));
    if (!target) return res.status(404).json({ error: 'Compte non trouvé' });

    if ((role && role !== target.role) || (active !== undefined && active !== target.active)) {
      const willDeactivateOrDowngradeAdmin =
        target.role === 'ADMIN' &&
        (active === false || (role && role !== 'ADMIN'));
      if (willDeactivateOrDowngradeAdmin) {
        const adminCount = await countActiveAdmins();
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Impossible : il doit rester au moins un administrateur actif' });
        }
      }
      if (req.user?.id === id && active === false) {
        return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte' });
      }
    }

    const [updated] = await db
      .update(users)
      .set({
        ...(role && ['ADMIN', 'JURY'].includes(role) && { role }),
        ...(active !== undefined && { active }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();

    // Les droits ont changé : les sessions déjà ouvertes ne doivent pas survivre,
    // sinon l'utilisateur conserve le rôle précédent jusqu'à l'expiration du jeton.
    if (active === false || (role && role !== target.role)) {
      const revoked = revokeAllSessionsForUser(id);
      if (revoked > 0) {
        console.log(`[auth] ${revoked} session(s) révoquée(s) pour l'utilisateur ${id}`);
      }
    }

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'UPDATE_USER',
      'user',
      String(id),
      `Mise à jour compte ${updated.email} (rôle: ${updated.role}, actif: ${updated.active})`
    );

    res.json({
      id: updated.id,
      uid: updated.uid,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      active: updated.active,
      createdAt: updated.createdAt,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de mise à jour du compte' });
  }
});

usersRouter.post('/:id/password', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password } = req.body;

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });
    }

    const [updated] = await db
      .update(users)
      .set({ passwordHash: hashPassword(password), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();

    if (!updated) return res.status(404).json({ error: 'Compte non trouvé' });

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'RESET_USER_PASSWORD',
      'user',
      String(id),
      `Réinitialisation du mot de passe du compte ${updated.email}`
    );

    res.json({ success: true, message: 'Mot de passe réinitialisé avec succès' });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la réinitialisation du mot de passe' });
  }
});

usersRouter.delete('/:id', requireAuth, requireAdmin, adminWriteLimit, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [target] = await db.select(USER_PUBLIC_COLUMNS).from(users).where(eq(users.id, id));
    if (!target) return res.status(404).json({ error: 'Compte non trouvé' });

    if (req.user?.id === id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
    }

    if (target.role === 'ADMIN') {
      const adminCount = await countActiveAdmins();
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Impossible : il doit rester au moins un administrateur actif' });
      }
    }

    await db.delete(users).where(eq(users.id, id));
    revokeAllSessionsForUser(id);

    await logAudit(
      req.user?.uid,
      req.user?.email,
      'DELETE_USER',
      'user',
      String(id),
      `Suppression du compte ${target.email}`
    );

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur lors de la suppression du compte' });
  }
});
