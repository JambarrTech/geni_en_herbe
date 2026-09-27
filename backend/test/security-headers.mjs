/**
 * Verifie que les en-tetes de securite sont poses AU BON ENDROIT.
 *
 * La faute a corriger etait une faute de ciblage, pas de contenu : les
 * en-tetes etaient poses par le processus API, qui ne sert que du JSON. Or une
 * Content-Security-Policy ne s'applique qu'au document qu'elle accompagne —
 * aucun ecran n'etait donc protege, alors que les en-tetes etaient bel et bien
 * poses. C'est le genre de defaut invisible : la presence du code donne
 * l'impression de la protection.
 *
 * Ce test interroge les deux points d'entree et verifie que :
 *   - le DOCUMENT (processus static) porte la politique complete ;
 *   - l'API porte une politique DURCIE (ni image, ni police, ni style) ;
 *   - aucune origine Google ne subsiste : la connexion Google a ete supprimee
 *     du client, et une origine autorisee sans raison est une porte ouverte ;
 *   - HSTS est ABSENT en developpement. Le poser ici memoriserait la directive
 *     dans le navigateur et refuserait http://localhost jusqu'a expiration —
 *     un poste de developpement rendu inutilisable par un en-tete de securite.
 */
const STATIC = 'http://127.0.0.1:4003';
const API = 'http://127.0.0.1:4000';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'OK   ' : 'ECHEC'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
};

const headersOf = async (url) => {
  const res = await fetch(url, { redirect: 'manual' });
  return res.headers;
};

console.log('En-tetes de securite : au bon processus ?\n');

console.log('A) DOCUMENT servi par le processus static');
{
  const h = await headersOf(`${STATIC}/`);
  const csp = h.get('content-security-policy') ?? '';
  check('CSP presente', csp.length > 0);
  check('X-Content-Type-Options: nosniff', h.get('x-content-type-options') === 'nosniff');
  check('X-Frame-Options: DENY', h.get('x-frame-options') === 'DENY');
  check('Referrer-Policy', (h.get('referrer-policy') ?? '').includes('no-referrer'));
  check('Cross-Origin-Opener-Policy', h.get('cross-origin-opener-policy') === 'same-origin');
  check('Cross-Origin-Resource-Policy', h.get('cross-origin-resource-policy') === 'same-origin');
  check('Permissions-Policy', (h.get('permissions-policy') ?? '').includes('camera=()'));
  check("CSP contient default-src 'self'", csp.includes("default-src 'self'"));
  check("CSP contient script-src 'self'", csp.includes("script-src 'self'"));
  check("CSP contient object-src 'none'", csp.includes("object-src 'none'"));
  check("CSP contient frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
  check("CSP contient connect-src 'self'", csp.includes("connect-src 'self'"));
  check("CSP contient frame-src 'none'", csp.includes("frame-src 'none'"));
  check("CSP contient upgrade-insecure-requests", csp.includes('upgrade-insecure-requests'));
  check("CSP n'autorise PAS l'image distante (img-src borne)", !csp.includes("img-src 'self' data: https:"));
}

console.log('\nB) le document porte-t-il aussi HSTS en developpement ? (non voulu)');
{
  const h = await headersOf(`${STATIC}/`);
  const hsts = h.get('strict-transport-security');
  check(
    'HSTS ABSENT hors production',
    hsts === null,
    hsts ? `trouve « ${hsts} » — le poste de dev deviendrait inutilisable` : ''
  );
}

console.log('\nC) API : politique durcie');
{
  const h = await headersOf(`${API}/api/health`);
  const csp = h.get('content-security-policy') ?? '';
  check('CSP presente', csp.length > 0);
  check("img-src 'none'", csp.includes("img-src 'none'"));
  check("font-src 'none'", csp.includes("font-src 'none'"));
  check("style-src 'none'", csp.includes("style-src 'none'"));
  check('nosniff pose', h.get('x-content-type-options') === 'nosniff');
}

console.log('\nD) aucune origine Google residuelle');
{
  for (const [nom, base] of [['document', STATIC], ['api', API]]) {
    const csp = (await headersOf(`${base}/`)).get('content-security-policy') ?? '';
    check(
      `${nom} : pas de googleapis`,
      !csp.includes('googleapis') && !csp.includes('gstatic'),
      csp.match(/[^;]*google[^;]*/)?.[0] ?? ''
    );
  }
}

console.log('\nE) le relais du reverse proxy ne perd pas les en-tetes');
{
  const h = await headersOf(`${STATIC}/api/health`);
  check('API via le port static : CSP presente', (h.get('content-security-policy') ?? '').length > 0);
  check('API via le port static : nosniff', h.get('x-content-type-options') === 'nosniff');
}

console.log(
  failures === 0 ? '\nOK : en-tetes de securite poses sur les bons processus.' : `\n${failures} ECHEC(S).`
);
process.exit(failures === 0 ? 0 : 1);
