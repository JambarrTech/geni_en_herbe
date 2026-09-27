import type { Request, Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.ts';
import { CONFIG } from '../config.ts';

/**
 * Limitation de débit en fenêtre glissante, par clé.
 *
 * Pourquoi un module dédié plutôt qu'une `Map` par route :
 *  - le seul dispositif existant coveringait `/login` avec une `Map` qui n'est
 *    jamais purgée : une attaque par force brute la fait croître sans borne
 *    (mémoire), en plus de bloquer ;
 *  - les endpoints d'écriture du jury (score, chronomètre, publication) n'ont
 *    aucune limite. La protection anti-double-clic du client est contournable
 *   trivialement : il suffit de ne pas utiliser le client, ou d'en ouvrir
 *    plusieurs en parallèle.
 *
 * Deux propriétés délibérées :
 *  - la mémoire est bornée : les entrées expirées sont évincées à intervalle
 *    régulier, pas seulement à la lecture ;
 *  - la réponse 429 indique `Retry-After`, ce qui permet à un client correct de
 *    se replier au lieu de marteler.
 */

interface Bucket {
  /** Horodatages des requêtes acceptées dans la fenêtre courante. */
  hits: number[];
  /** Nombre de requêtes refusées depuis le début de la fenêtre. */
  blocked: number;
}

const buckets = new Map<string, Bucket>();
const now = () => Date.now();

/**
 * Purge les seaux expirés. Sans cela, un attaquant cumulant des adresses IP
 * épuiserait la mémoire du service API sans jamais être bloqué.
 */
function sweep(windowMs: number) {
  const cutoff = now() - windowMs;
  for (const [key, bucket] of buckets) {
    // Une entrée dont la dernière frappe est antérieure à la fenêtre ne peut
    // plus être lue comme active : l'entrée part, et sa fenêtre avec.
    if (bucket.hits.length === 0 || bucket.hits[bucket.hits.length - 1] < cutoff) {
      buckets.delete(key);
    }
  }
}

let sweeping = false;
function startSweeper(windowMs: number) {
  if (sweeping) return;
  sweeping = true;
  const timer = setInterval(() => sweep(windowMs), Math.max(30_000, windowMs));
  timer.unref();
}

/** Vidage explicite (tests). */
export function __resetRateLimits() {
  buckets.clear();
}

export interface RateLimitOptions {
  /** Nombre de requêtes autorisées dans la fenêtre. */
  limit: number;
  /** Durée de la fenêtre, en millisecondes. */
  windowMs: number;
  /**
   * Comment construire la clé. Par défaut : IP seule, plus l'identifiant de
   * session s'il y en a un. Inclure l'utilisateur évite qu'un membre du jury
   * soit bloqué par le trafic d'une autre machine sur la même IP (salle de
   * competition, NAT), tout en gardant la limite par utilisateur.
   */
  key?: (req: Request) => string;
  /** Libellé renvoyé au client, pour savoir quel quota est atteint. */
  label?: string;
}

/** Clé par défaut : utilisateur si authentifié, sinon adresse IP. */
function defaultKey(req: Request): string {
  const uid = (req as AuthRequest).user?.uid;
  if (uid) return `u:${uid}`;
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'inconnu'}`;
}

/**
 * Fabrique un middleware de limitation de débit.
 *
 * ```
 * router.post('/:id/score', rateLimit({ limit: 30, windowMs: 10_000 }), handler)
 * ```
 */
export function rateLimit(options: RateLimitOptions) {
  const { limit, windowMs, key = defaultKey, label = 'trop de requêtes' } = options;
  startSweeper(windowMs);

  return (req: Request, res: Response, next: NextFunction) => {
    const bucketKey = key(req);
    const cutoff = now() - windowMs;
    const bucket = buckets.get(bucketKey) ?? { hits: [], blocked: 0 };
    // Retire les frappes sorties de la fenêtre : on ne garde que le pertinent.
    while (bucket.hits.length > 0 && bucket.hits[0] < cutoff) bucket.hits.shift();

    if (bucket.hits.length >= limit) {
      bucket.blocked += 1;
      buckets.set(bucketKey, bucket);
      // Second de repos restant avant qu'une place se libère.
      const retryAfter = Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now()) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.status(429).json({
        error: `Limite atteinte : ${label}. Réessayez dans ${retryAfter} s.`,
      });
      return;
    }

    bucket.hits.push(now());
    buckets.set(bucketKey, bucket);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.hits.length)));
    next();
  };
}

/**
 * Quotas prêts à l'emploi, calibrés dans CONFIG.RATE_LIMIT.
 *
 * Exportés comme instances uniques (et non comme greetings à appeler) pour que
 * chaque routeur n'ait qu'à les référencer : une seule configuration, un seul
 * état, et impossible d'oublier le libellé d'erreur.
 *
 * Règle de placement : TOUJOURS après `requireAuth` et après le contrôle de rôle.
 * La clé par défaut est l'identifiant de session, qui n'existe qu'une fois
 * l'appelant authentifié. Placés plus tôt, la clé retomberait sur l'adresse IP
 * — et une seule machine bruyante bloquerait alors tous les membres du jury
 * d'une salle de compétition, souvent derrière le même NAT.
 */
export const scoreLimit = rateLimit({
  ...CONFIG.RATE_LIMIT.SCORE,
  label: 'trop d\'attributions de score',
});

export const controlLimit = rateLimit({
  ...CONFIG.RATE_LIMIT.MATCH_CONTROL,
  label: 'trop d\'actions de pilotage',
});

export const adminWriteLimit = rateLimit({
  ...CONFIG.RATE_LIMIT.ADMIN_WRITE,
  label: 'trop de modifications',
});

/** Connexion : clé par couple email + IP, pour ne pas bloquer toute la salle. */
export const loginLimit = (email: string) =>
  rateLimit({
    ...CONFIG.RATE_LIMIT.LOGIN,
    label: 'trop de tentatives de connexion',
    key: (req) => `login:${email.toLowerCase()}|${req.ip ?? req.socket.remoteAddress ?? 'inconnu'}`,
  });

/**
 * Limiteur d'échecs, piloté explicitement.
 *
 * Différence avec `rateLimit` : il ne compte QUE les échecs déclarés par
 * l'appelant, pas les requêtes reçues. C'est indispensable pour la connexion.
 *
 * Pourquoi une limite par IP en complément de la limite par compte :
 * la clé `email + IP` se contourne trivialement en changeant d'email
 * (bourrage d'identifiants) ou d'IP (force brute distribuée). Une limite
 * exclusivement par compte se contourne en changeant de compte. Il faut les deux.
 *
 * Pourquoi ne compter que les échecs : dans une salle de compétition, trente
 * personnes se connectent depuis la même adresse IP publique. Compter les
 * CONNEXIONS RÉUSSIES bloquerait la vingt-et-unième. On ne penalise donc que
 * ce qui signale une attaque.
 */
export function failureLimiter(options: { limit: number; windowMs: number }) {
  const { limit, windowMs } = options;
  startSweeper(windowMs);

  return {
    /** true si le nombre d'échecs récents a atteint la limite. */
    isBlocked(key: string): boolean {
      const bucket = buckets.get(key);
      if (!bucket) return false;
      const cutoff = now() - windowMs;
      while (bucket.hits.length > 0 && bucket.hits[0] < cutoff) bucket.hits.shift();
      return bucket.hits.length >= limit;
    },

    /** Enregistre un échec. */
    penalize(key: string): void {
      const bucket = buckets.get(key) ?? { hits: [], blocked: 0 };
      bucket.hits.push(now());
      buckets.set(key, bucket);
    },

    /** Oublie les échecs — appelé après une réussite. */
    reset(key: string): void {
      buckets.delete(key);
    },

    /** Secondes restantes avant qu'une place se libère (0 si non bloqué). */
    retryAfter(key: string): number {
      const bucket = buckets.get(key);
      if (!bucket || bucket.hits.length === 0) return 0;
      return Math.max(1, Math.ceil((bucket.hits[0] + windowMs - now()) / 1000));
    },
  };
}

/** Échecs de connexion par adresse IP : freine le bourrage de comptes. */
export const loginIpFailures = failureLimiter({
  limit: 30,
  windowMs: 15 * 60_000,
});
