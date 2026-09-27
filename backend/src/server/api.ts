import express from 'express';
import 'dotenv/config';

import { CONFIG } from '../config.ts';
import { authRouter } from '../routes/auth.routes.ts';
import { eventsRouter } from '../routes/events.routes.ts';
import { participantsRouter } from '../routes/participants.routes.ts';
import { teamsRouter } from '../routes/teams.routes.ts';
import { categoriesRouter } from '../routes/categories.routes.ts';
import { questionsRouter } from '../routes/questions.routes.ts';
import { matchesRouter } from '../routes/matches.routes.ts';
import { liveRouter } from '../routes/live.routes.ts';
import { adminRouter } from '../routes/admin.routes.ts';
import { usersRouter } from '../routes/users.routes.ts';

/**
 * Constructeur de l'application API.
 *
 * Contenu volontairement restreint : routes REST et en-tetes de securite.
 * Ne font PAS partie de ce processus :
 *  - la diffusion WebSocket        -> processus `ws`
 *  - la boucle de chrono           -> processus `worker`
 *  - le service des fichiers       -> processus `static`
 *
 * Conséquence à garder en tête : un traitement de requête long ou bloquant
 * (hachage de mot de passe, par exemple) ne peut plus figer le chrono ni la
 * diffusion, puisqu'ils vivent dans d'autres processus.
 */
export function createApiApp(): express.Express {
  const app = express();

  // Derrière un reverse proxy : req.ip doit lire X-Forwarded-For, sinon le
  // rate-limit de connexion se bucketise sur l'IP du proxy.
  if (process.env.TRUST_PROXY) {
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : tp.split(','));
  }

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://apis.google.com https://www.gstatic.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self' https://*.googleapis.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    next();
  });

  app.use(express.json({ limit: CONFIG.JSON_BODY_LIMIT }));

  // Sonde de vivacite. Volontairement sans information d'exploitation :
  // ce point peut etre expose publiquement.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'AEERKS — API',
      time: new Date().toISOString(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/participants', participantsRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/questions', questionsRouter);
  app.use('/api/matches', matchesRouter);
  app.use(liveRouter); // /api/rankings, /api/live
  app.use(adminRouter); // /api/audit-logs, /api/settings
  app.use('/api/users', usersRouter);

  // 404 JSON propre pour les routes API inconnues
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint API introuvable' });
  });

  // Gestion centralisée des erreurs (JSON), y compris JSON mal formés
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Corps de requête JSON invalide' });
      }
      console.error('Erreur non gérée (API):', err);
      res.status(500).json({ error: 'Erreur interne du serveur' });
    }
  );

  return app;
}
