import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { startAuthoritativeTimerLoop, stopAuthoritativeTimerLoop } from './server/matchEngine.ts';
import { initWebSocketServer, getConnectedClients, closeWebSocketServer } from './server/websocket.ts';
import { db } from './db/index.ts';
import { sql } from 'drizzle-orm';
import { authRouter } from './routes/auth.routes.ts';
import { eventsRouter } from './routes/events.routes.ts';
import { participantsRouter } from './routes/participants.routes.ts';
import { teamsRouter } from './routes/teams.routes.ts';
import { categoriesRouter } from './routes/categories.routes.ts';
import { questionsRouter } from './routes/questions.routes.ts';
import { matchesRouter } from './routes/matches.routes.ts';
import { liveRouter } from './routes/live.routes.ts';
import { adminRouter } from './routes/admin.routes.ts';
import { usersRouter } from './routes/users.routes.ts';
import { CONFIG } from './config.ts';

// Project root: parent of backend/ (where the frontend lives)
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(currentDir, '..', '..');

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || CONFIG.PORT_DEFAULT;

  // Derrière un reverse proxy (nginx, Cloudflare, Fly…), req.ip doit refléter
  // X-Forwarded-For, sinon le rate-limit de connexion se bucketise sur l'IP du
  // proxy : un seul compteur partagé par tous les utilisateurs du LAN.
  if (process.env.TRUST_PROXY) {
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : tp.split(','));
  }

  // En-têtes de sécurité. Pas de helmet : on pose explicitement le nécessaire
  // pour cette application (API JSON + 3 shells statiques).
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Le shell statique n'exécute rien d'inline : 'self' suffit et bloque
    // l'injection de script en cas de faille XSS.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' https://apis.google.com https://www.gstatic.com",
        "style-src 'self' 'unsafe-inline'", // Tailwind injecte des <style> inline
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self' https://*.googleapis.com wss: ws:",
        "frame-src 'self' https://*.firebaseapp.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    if (process.env.NODE_ENV === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  app.use(express.json({ limit: CONFIG.JSON_BODY_LIMIT }));

  const server = http.createServer(app);

  // 1. WebSocket Server for real-time synchronization
  initWebSocketServer(server);

  // 2. Start authoritative timer background loop
  startAuthoritativeTimerLoop();

  // ----------------------------------------------------
  // API ROUTES
  // ----------------------------------------------------

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'AEERKS Génie en Herbe API',
      connectedClients: getConnectedClients().size,
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

  // ----------------------------------------------------
  // STATIC SERVING DES TROIS FRONTENDS (apps/*)
  // ----------------------------------------------------
  // Le frontend est découpé en trois apps Vite distinctes :
  //   apps/live   -> /       (écran public de compétition)
  //   apps/jury   -> /jury   (table d'arbitrage)
  //   apps/admin  -> /admin  (comité d'organisation)
  const appsRoot = path.join(PROJECT_ROOT, 'apps');
  const distOf = (name: string) => path.join(appsRoot, name, 'dist');

  const setStaticHeaders = (res: express.Response, filePath: string) => {
    // Les assets hashés de Vite sont immutables : cache long
    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader(
        'Cache-Control',
        `public, max-age=${CONFIG.STATIC_IMMUTABLE_MAX_AGE_MS}, immutable`
      );
    } else {
      // index.html ne doit jamais être mis en cache : il référence les chunks
      // hashés, et un shell périmé pointe vers des assets supprimés.
      res.setHeader('Cache-Control', 'no-cache');
    }
  };

  if (process.env.NODE_ENV !== 'production') {
    // Développement : chaque app tourne sur son propre serveur Vite
    // (ports 5173 / 5174 / 5175) qui proxie /api et /ws vers ce serveur.
    app.get('/', (_req, res) => {
      res.json({
        api: 'AEERKS Génie en Herbe — API prête',
        apps: {
          live: 'http://localhost:5173 (Écran public)',
          jury: 'http://localhost:5174 (Espace Jury)',
          admin: 'http://localhost:5175 (Administration)',
        },
      });
    });
  } else {
    const liveDist = distOf('live');
    const juryDist = distOf('jury');
    const adminDist = distOf('admin');

    if (fs.existsSync(liveDist)) app.use('/', express.static(liveDist, { index: 'index.html', setHeaders: setStaticHeaders }));
    if (fs.existsSync(juryDist)) app.use('/jury', express.static(juryDist, { index: 'index.html', setHeaders: setStaticHeaders }));
    if (fs.existsSync(adminDist)) app.use('/admin', express.static(adminDist, { index: 'index.html', setHeaders: setStaticHeaders }));

    // Fallback SPA : les routes inconnues renvoient le shell de l'app concernée.
    const sendIndex = (dist: string) => (_req: express.Request, res: express.Response) =>
      res.sendFile(path.join(dist, 'index.html'));

    if (fs.existsSync(juryDist)) {
      app.get('/jury', sendIndex(juryDist));
      app.get('/jury/*', sendIndex(juryDist));
    }
    if (fs.existsSync(adminDist)) {
      app.get('/admin', sendIndex(adminDist));
      app.get('/admin/*', sendIndex(adminDist));
    }
    // L'app live (racine) est le fallback général, enregistré en dernier.
    if (fs.existsSync(liveDist)) {
      app.get('*', sendIndex(liveDist));
    }
  }

  // Gestion centralisée des erreurs (JSON), y compris les JSON mal formés
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
      console.error('Erreur non gérée:', err);
      res.status(500).json({ error: 'Erreur interne du serveur' });
    }
  );

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, '0.0.0.0', () => {
        console.log(`[AEERKS Server] Serveur actif sur http://0.0.0.0:${PORT}`);
        console.log(`[AEERKS Server] WebSocket prêt sur ws://0.0.0.0:${PORT}`);
        resolve();
      });
    });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `[AEERKS Server] Le port ${PORT} est déjà utilisé : un autre backend tourne déjà ? Fermez-le puis relancez.`
      );
    } else {
      console.error('[AEERKS Server] Impossible de démarrer le serveur:', err);
    }
    stopAuthoritativeTimerLoop();
    closeWebSocketServer();
    process.exit(1);
  }

  // Sonde unique et non bloquante : si la base est injoignable, un message clair
  // (au lieu d'un mur d'erreurs) sans bloquer le démarrage.
  void checkDatabaseOnce();

  // Arrêt propre : arrête le chrono, ferme WebSocket et le serveur HTTP
  const shutdown = (signal: string) => {
    console.log(`[AEERKS Server] Arrêt demandé (${signal}). Fermeture propre...`);
    stopAuthoritativeTimerLoop();
    closeWebSocketServer();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('Erreur fatale au démarrage du serveur:', err);
  process.exit(1);
});

async function checkDatabaseOnce() {
  try {
    await db.execute(sql`SELECT 1`);
    console.log('[AEERKS Server] Base de données : connexion OK');
  } catch (err: any) {
    const reason =
      err?.cause?.code || err?.code || (err instanceof Error ? err.message : String(err));
    console.error('[AEERKS Server] ATTENTION — base de données injoignable :');
    console.error(`  raison : ${reason}`);
    console.error('  Le serveur tourne, mais les données et le temps réel reprendront');
    console.error('  automatiquement dès que la base (DATABASE_URL) sera joignable.');
  }
}

// Filets de sécurité : ne jamais laisser une promesse non gérée faire tomber le process
process.on('unhandledRejection', (reason) => {
  console.error('Promesse non gérée:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Exception non interceptée:', err);
});