import 'dotenv/config';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import httpProxy from 'http-proxy';
import { securityHeaders } from '../lib/securityHeaders.ts';
import { CONFIG } from '../config.ts';
import { createLogger } from '../lib/logger.ts';
import { renderMetrics } from '../lib/metrics.ts';

const log = createLogger('static');

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(currentDir, '..', '..', '..');

/**
 * Point d'entree HTTP des trois applications.
 *
 * Séparé de l'API pour deux raisons :
 *  - le trafic des bundles (et leur cache navigateur) ne concurrence ni les
 *    requêtes métier, ni la boucle de chrono ;
 *  - les fichiers peuvent être servis par un CDN sans toucher au code métier.
 *
 * Reverse proxy
 * -------------
 * Les trois apps sont servies sur l'ORIGINE 4003, et appellent `/api/...`
 * ainsi que `wss://<hôte>/ws`. Pour que la séparation des processus soit
 * transparente côté navigateur — sans CORS, sans cookie inter-origines, et
 * sans toucher au code client — ce serveur relaie :
 *
 *   /api  ->  API_PORT     (processus api)
 *   /ws   ->  WS_PORT      (processus ws, avec upgrade WebSocket)
 *
 * C'est exactement le rôle que joue nginx en production. En développement,
 * c'est Vite qui remplit ce rôle, d'où l'absence du problème avant.
 */
const server = http.createServer();

const API_TARGET = `http://127.0.0.1:${Number(process.env.API_PORT) || CONFIG.API_PORT}`;
const WS_TARGET = `http://127.0.0.1:${Number(process.env.WS_PORT) || CONFIG.WS_PORT}`;

const proxy = httpProxy.createProxyServer({
  // Les erreurs de amont doivent remonter à l'utilisateur, pas tuer le serveur.
  proxyTimeout: 30_000,
  timeout: 30_000,
});

let upstreamErrors = 0;
// La surcharge `error` de http-proxy n'est pas correctement typée par
// @types/http-proxy (signature d'EventEmitter). On la declare explicitement.
proxy.on('error', ((
  err: Error,
  _req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  upstreamErrors += 1;
  log.error('Amont injoignable', { err });
  if (res && !res.headersSent && 'writeHead' in res) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service temporairement indisponible' }));
  }
}) as (...args: unknown[]) => void);

/**
 * Applique les en-têtes de sécurité.
 *
 * Ce serveur n'est pas une application Express mais un serveur Node qui
 * traite `request` puis, parfois, `upgrade` : monter un intergiciel complet
 * serait artificiel. On isole donc la logique dans une fonction appelable
 * directement, pour n'avoir qu'une seule définition à maintenir.
 */
const applySecurityHeaders = (req: http.IncomingMessage, res: http.ServerResponse) => {
  securityHeaders({ serveDocuments: true })(req as never, res as never, () => {});
};

// --- Sonde de vivacité (avant tout le reste) ------------------------------
server.on('request', (req, res) => {
  // La sonde passe avant la CSP : une sonde qui dépend de la politique de
  // sécurité est une sonde qui tombe au premier durcissement.
  if (req.url === '/__static_health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'AEERKS — statique',
        api: API_TARGET,
        ws: WS_TARGET,
        upstreamErrors,
      })
    );
    return;
  }

  // Métriques : également avant la CSP et avant le relais, pour les mêmes
  // raisons — un scrape ne doit dépendre ni de la politique de sécurité, ni
  // de la disponibilité de l'API.
  if (req.url === '/__static_metrics') {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      renderMetrics('static', {
        // Compteur d'erreurs d'amont : le nombre de 502 rendus. Un zéro qui
        // monte est le signal le plus direct d'un backend tombé.
        upstream_errors: () => upstreamErrors,
      })
    );
    return;
  }

  // En-têtes de sécurité sur les DOCUMENTS.
  //
  // C'est ici, et uniquement ici, qu'ils sont efficaces : une CSP ne gouverne
  // que le document qu'elle accompagne, et ce processus est le seul à servir
  // du HTML. Pendant la séparation des serveurs, ces en-têtes étaient restés
  // sur le processus API — qui ne sert que du JSON : aucun écran n'était
  // protégé. Le bug était invisible, les en-têtes étant bel et bien « poses ».
  applySecurityHeaders(req, res);

  staticHandler(req, res);
});

/** Relais des appels API et WebSocket vers les processus spécialisés. */
server.on('upgrade', (req, socket, head) => {
  // Tout ce qui n'est pas le canal WS est refusé : l'hôte ne sert pas de WS.
  if (req.url?.startsWith('/ws')) {
    proxy.ws(req, socket, head, { target: WS_TARGET });
  } else {
    socket.destroy();
  }
});

function staticHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? '/';
  if (url.startsWith('/api')) {
    proxy.web(req, res, { target: API_TARGET });
    return;
  }
  serveStatic(url, res);
}

// --- Fichiers statiques ----------------------------------------------------
const appsRoot = path.join(PROJECT_ROOT, 'apps');
const distOf = (name: string) => path.join(appsRoot, name, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'woff2',
  '.woff2': 'woff2',
  '.map': 'application/json; charset=utf-8',
};

const liveDist = distOf('live');
const juryDist = distOf('jury');
const adminDist = distOf('admin');

const missing: string[] = [];
if (!fs.existsSync(liveDist)) missing.push('apps/live/dist');
if (!fs.existsSync(juryDist)) missing.push('apps/jury/dist');
if (!fs.existsSync(adminDist)) missing.push('apps/admin/dist');
if (missing.length > 0) {
  log.warn(
    `Builds absents : ${missing.join(', ')}. Lancez \`npm run build\`.`,
    { manquants: missing }
  );
}

const setStaticHeaders = (filePath: string) => ({
  'Cache-Control': filePath.includes(`${path.sep}assets${path.sep}`)
    ? `public, max-age=${CONFIG.STATIC_IMMUTABLE_MAX_AGE_MS}, immutable`
    : // index.html ne doit jamais être mis en cache : il référence les chunks
      // hashés, et un shell périmé pointe vers des assets supprimés.
      'no-cache',
});

/** Résout un chemin d'URL vers un fichier sur disque, en refusant toute sortie du dist. */
function resolveFile(dist: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = path.normalize(path.join(dist, decoded));
  // Empêche ../../ : le résultat doit rester sous `dist`.
  if (!candidate.startsWith(path.normalize(dist))) return null;
  if (!fs.existsSync(candidate)) return null;
  if (fs.statSync(candidate).isDirectory()) {
    const index = path.join(candidate, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return candidate;
}

function sendFile(res: http.ServerResponse, file: string) {
  res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
  for (const [k, v] of Object.entries(setStaticHeaders(file))) res.setHeader(k, v);
  fs.createReadStream(file).pipe(res);
}

function serveStatic(url: string, res: http.ServerResponse) {
  const [pathname] = url.split('?');

  // Application concernée selon le préfixe.
  let dist = liveDist;
  let rel = pathname;
  if (pathname.startsWith('/jury')) {
    dist = juryDist;
    rel = pathname.slice('/jury'.length) || '/';
  } else if (pathname.startsWith('/admin')) {
    dist = adminDist;
    rel = pathname.slice('/admin'.length) || '/';
  }

  const direct = resolveFile(dist, rel);
  if (direct) {
    sendFile(res, direct);
    return;
  }

  // Repli SPA : route profonde -> shell de l'app concernée.
  const shell = path.join(dist, 'index.html');
  if (fs.existsSync(shell)) {
    sendFile(res, shell);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('404 — build absent. Lancez `npm run build` à la racine.');
}

const PORT = Number(process.env.STATIC_PORT) || CONFIG.STATIC_PORT;

server.listen(PORT, '0.0.0.0', () => {
  log.info(`Point d'entrée sur http://0.0.0.0:${PORT}`, {
    apps: '/ écran public · /jury · /admin',
    api: API_TARGET,
    ws: WS_TARGET,
  });
});

const shutdown = (signal: string) => {
  log.info(`Arrêt demandé (${signal}).`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => log.error('Promesse non gérée', { err: reason }));
process.on('uncaughtException', (err) => log.error('Exception non interceptée', { err }));
