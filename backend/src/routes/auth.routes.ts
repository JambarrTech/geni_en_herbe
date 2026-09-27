import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'crypto';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { registerSessionToken, revokeSessionToken, requireAuth, type AuthRequest } from '../middleware/auth.ts';
import { logAudit } from '../server/matchEngine.ts';
import { verifyPassword } from '../lib/password.ts';
import { loginIpFailures } from '../middleware/rateLimit.ts';
import { CONFIG } from '../config.ts';

export const authRouter = Router();

// Anti brute-force simple (en mémoire) : N essais / fenêtre par email+IP
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();

function rateLimitKey(email: string, ip: string): string {
  return `${email.toLowerCase()}|${ip}`;
}

function isBlocked(key: string): boolean {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.blockedUntil) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= CONFIG.MAX_LOGIN_ATTEMPTS;
}

function registerFailure(key: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, blockedUntil: now + CONFIG.LOGIN_WINDOW_MS };
  entry.count += 1;
  entry.blockedUntil = now + CONFIG.LOGIN_WINDOW_MS;
  loginAttempts.set(key, entry);
}

function resetAttempts(key: string): void {
  loginAttempts.delete(key);
}

// Purge des compteurs expirés. Sans ce balayage, chaque couple (email, IP)
// distinct qui échouait laissait une entrée définitive : la Map grossissait
// indéfiniment sur la durée de vie du process.
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) {
      if (entry.blockedUntil <= now) loginAttempts.delete(key);
    }
  },
  60_000
).unref();

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = rateLimitKey(normalizedEmail, ip);

    if (isBlocked(key)) {
      const minutes = Math.round(CONFIG.LOGIN_WINDOW_MS / 60000);
      return res.status(429).json({
        error: `Trop de tentatives échouées. Réessayez dans ${minutes} minutes.`,
      });
    }

    // Frein complementary, par adresse IP. La cle email+IP ci-dessus se
    // contourne en variant l'email (bourrage d'identifiants) ; celle-ci compte
    // les ECHECS uniquement, pour ne pas penaliser une salle entiere derriere
    // un meme NAT dont les connexions reussies sont legitimes.
    const ipKey = `login-ip:${ip}`;
    if (loginIpFailures.isBlocked(ipKey)) {
      const seconds = loginIpFailures.retryAfter(ipKey);
      res.setHeader('Retry-After', String(seconds));
      return res.status(429).json({
        error: `Trop de tentatives infructueuses depuis ce poste. Réessayez dans ${Math.ceil(seconds / 60)} minute(s).`,
      });
    }

    // Find user in database
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail));

    // La vérification est asynchrone : scrypt s'exécute dans le pool de threads,
    // l'event loop n'est pas figé pendant le calcul. Une rafale de tentatives
    // ne peut donc plus paralyser ni le chrono ni la diffusion — ce qui, depuis
    // la séparation des serveurs, ne gelaient plus le même processus, mais
    // paralyserait encore toutes les autres requêtes de l'API.
    //
    // `await` AVANT la comparaison : sans lui, un email inconnu court-circuiterait
    // la vérification et repondaitait plus vite qu'un email valide. Cette
    // différence de temps révélerait quels comptes existent. Le `||` force donc
    // le calcul dans les deux cas.
    const passwordMatches = user?.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : false;

    if (!user || !user.passwordHash || !passwordMatches) {
      registerFailure(key);
      loginIpFailures.penalize(ipKey);
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Ce compte est inactif. Contactez l\'AEERKS.' });
    }

    resetAttempts(key);
    loginIpFailures.reset(ipKey);

    // Generate session token (cryptographiquement aléatoire)
    const token = `${CONFIG.TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const userProfile = {
      id: user.id,
      uid: user.uid,
      name: user.name,
      email: user.email,
      role: user.role as 'ADMIN' | 'JURY',
      active: user.active,
    };

    registerSessionToken(token, userProfile);

    await logAudit(
      user.uid,
      user.email,
      'LOGIN',
      'user',
      String(user.id),
      `Connexion réussie sous le rôle ${user.role}`
    );

    res.json({
      token,
      user: userProfile,
    });
  } catch (error: any) {
    console.error('Erreur login:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion' });
  }
});

authRouter.get('/me', requireAuth, (req: AuthRequest, res: Response) => {
  res.json({ user: req.user });
});

authRouter.post('/logout', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.split('Bearer ')[1]?.trim();
    if (token) revokeSessionToken(token);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Erreur de déconnexion' });
  }
});
