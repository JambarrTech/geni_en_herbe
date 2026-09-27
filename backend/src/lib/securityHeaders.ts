import type { Request, Response, NextFunction } from 'express';
import { isProduction } from '../config.ts';

/**
 * En-têtes de sécurité, à poser sur le processus qui sert les DOCUMENTS.
 *
 * Une faute de ciblage commise pendant la séparation des serveurs
 * ------------------------------------------------------------------
 * Ces en-têtes vivaient sur le processus API. Or l'API ne sert que du JSON :
 * une Content-Security-Policy ne s'applique qu'au document qu'elle accompagne,
 * donc elle ne protégeait aucun écran. Les documents sont servis par le
 * processus `static` en production, et par Vite en développement — et ni
 * l'un ni l'autre ne posait ces en-têtes.
 *
 * La CSP est donc appliquée au bon endroit : le serveur de fichiers. Elle est
 * également posée sur l'API, où elle ne coûte rien et protège le cas d'une
 * réponse JSON directement navigable.
 *
 * Les entrées Google (`apis.google.com`, `www.gstatic.com`,
 * `*.googleapis.com`) ont été retirées : la connexion Google a été supprimée
 * du client, Firebase compris. Des origines autorisées sans raison ne sont
 * qu'une porte laissée entrouverte.
 */
export function securityHeaders(options: { serveDocuments: boolean }) {
  const directives = [
    "default-src 'self'",
    // Pas de source externe : tout le JS est compilé et servi par nos soins.
    "script-src 'self'",
    // 'unsafe-inline' sur le style est nécessaire : les styles calculés en JS
    // (barres de score, positions de colonne) passent par l'attribut style.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // 'self' couvre le WebSocket : la page et son socket sont sur la même
    // origine, le processus `static` relayant /ws vers le processus `ws`.
    // C'est un bénéfice direct de la séparation : pas d'origine tierce à
    // autoriser, donc pas de CORS, et une politique de connexion minimale.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    // Empêche le chargement en <iframe> : couvre frame-ancestors pour les
    // navigateurs anciens qui ne le supportent pas.
    "upgrade-insecure-requests",
  ];

  if (!options.serveDocuments) {
    // L'API ne renvoie pas de document : ni balise, ni image, ni police n'a
    // besoin d'être chargée depuis une réponse JSON. On durcit au maximum.
    directives.push("img-src 'none'", "font-src 'none'", "style-src 'none'");
  }

  const policy = directives.join('; ');

  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
    );
    res.setHeader('Content-Security-Policy', policy);

    // HSTS : « toujours https pendant max-age secondes ».
    // Deux précautions, car une erreur ici est irréversible :
    //  - jamais en développement : un navigateur qui a mémorisé la directive
    //    refuse ensuite http://localhost pendant toute la durée, ce qui rend
    //    le poste inutilisable jusqu'à l'expiration du cache ;
    //  - jamais derrière un proxy qui ne terminait pas le TLS.
    // Le domaine peut être surchargé : plusieurs noms TLS ne peuvent pas
    // partager une seule directive preload.
    if (isProduction()) {
      const hstsHost = process.env.HSTS_HOST || '';
      res.setHeader(
        'Strict-Transport-Security',
        `max-age=31536000; includeSubDomains${hstsHost ? `; preload` : ''}`
      );
    }

    next();
  };
}
