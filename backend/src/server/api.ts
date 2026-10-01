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
import { securityHeaders } from '../lib/securityHeaders.ts';
import { metrics, renderMetrics, routeLabel } from '../lib/metrics.ts';
import { withRequestId } from '../lib/logger.ts';

/**
 * Constructeur de l'application API.
 *
 * Contenu volontairement restreint : routes REST, en-tetes de securite et
 * instrumentation. Ne font PAS partie de ce processus :
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
  // L'API ne sert que du JSON : la politique est durcie au maximum (ni image,
  // ni police, ni style). La politique destinée aux documents — celle qui
  // governera réellement les écrans — est posée par le processus `static`,
  // seul à servir du HTML. Voir lib/securityHeaders.ts.
  app.use(securityHeaders({ serveDocuments: false }));

  // --- Sonde de métriques, AVANT l'instrumentation ----------------------
  // Elle ne doit pas se compter elle-même : un scrape toutes les 15 s
  // gonflerait le total de requêtes et legerait le nombre de latences, pour
  // rien. Elle est en outre ramenee avant le corps JSON : un scrape doit
  // repondre meme si le client parte en cours de route.
  app.get('/api/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    // Prometheus n'a aucune obligation de le gerer, et un cache intermediaire
    // ne doit surtout pas servir des metriques perimees.
    res.setHeader('Cache-Control', 'no-store');
    res.end(renderMetrics('api'));
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

  // --- Instrumentation des requetes --------------------------------------
  // Placee en dernier, donc APRES les routes : elle n'observe que ce qui est
  // reellement passe par le routage, et non les 404 explicites ci-dessus
  // (qui ont deja repondu). Elle s'installe malgre tout comme un gestionnaire
  // d'erreur, ce qui garantit une ligne de journal meme sur une exception.
  app.use(instrumentRequests());

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

/**
 * Journalise et chronometre chaque requete.
 *
 * Deux decisions non evidentes :
 *
 * 1. `finish` est sur `res`, pas sur `req`. L'evenement `finish` survient
 *    quand la reponse a ete entierement transmise ; `close` peut survenir
 *    avant, si le client abandonne. En mesurant sur `close` en complement,
 *    une requete interrompue en cours de route (reseau coupe, onglet ferme)
 *    reste visible : sinon elle disparaitrait des metriques, et une panne
 *    réseau massive se lirait comme une baisse de trafic.
 *
 * 2. La duree est relevee une fois, au plus proche de la reponse. Un `res.end`
 *    intercepte permet de mesurer la duree totale exacte, ce qu'un middleware
 *    classique ne fait pas toujours.
 */
function instrumentRequests() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const startedAt = process.hrtime.bigint();
    metrics.httpInFlight.inc();
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      metrics.httpInFlight.dec();

      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const route = routeLabel(req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : req.path);
      const labels = { method: req.method, route, status: String(res.statusCode) };

      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe(durationSeconds, { method: req.method, route });
    };

    res.on('finish', settle);
    res.on('close', settle);

    // Chaque requete porte un identifiant, reutilise par le journal via
    // AsyncLocalStorage : c'est ce qui relie une ligne d'access log a une
    // erreur base de donnees survenue trois appels plus loin.
    const requestId = randomRequestId();
    res.setHeader('X-Request-Id', requestId);
    withRequestId(requestId, () => next());
  };
}

/** Identifiant court, lisible dans un journal. */
function randomRequestId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
