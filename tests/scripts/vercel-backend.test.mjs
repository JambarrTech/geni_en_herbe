/**
 * `scripts/vercel-backend.mjs` — l'origine du backend, source unique du
 * déploiement Vercel.
 *
 * Ce module décide de trois choses qui, prises de travers, ne font JAMAIS
 * échouer un build : l'hôte retenu pour le relais `/api`, le `connect-src` de
 * la CSP, et le `VITE_WS_URL` injecté au build. Toutes trois finissent en
 * « le chronomètre ne descend plus », le jour de la compétition, devant public.
 * Aucun test d'intégration ne les rattraperait : elles sont lues dans un
 * fichier de configuration et injectées par l'environnement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARQUEUR,
  parseVercelConfig,
  readBackendOverride,
  resolveBackendOrigin,
  wsUrlFor,
} from '../../scripts/vercel-backend.mjs';

const CORRECT = `{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://api.aeerks.sn/api/:path*" }
  ],
  "headers": [
    { "source": "/(.*)", "headers": [
      { "key": "Content-Security-Policy",
        "value": "default-src 'self'; connect-src 'self' wss://api.aeerks.sn; object-src 'none'" }
    ]}
  ]
}`;

test('parseVercelConfig — configuration valide', () => {
  const r = parseVercelConfig(CORRECT);
  assert.equal(r.configured, true);
  assert.equal(r.relay, 'https://api.aeerks.sn');
  // La CSP contient `wss://`, pas `https://` : une regex limitée à `https?://`
  // ne trouvait RIEN, et le contrôle de cohérence ne s'exécutait jamais.
  assert.equal(r.csp, 'wss://api.aeerks.sn');
  assert.equal(r.occurrences, 0);
});

test('parseVercelConfig — c\'est l\'HÔTE qui se compare, pas l\'origine', () => {
  // wss: pour le canal, https: pour le relais : c'est la configuration normale.
  // Comparer les chaînes complètes les ferait diverger et casserait tout
  // déploiement valide.
  const r = parseVercelConfig(CORRECT);
  assert.notEqual(r.relay, r.csp);
  assert.equal(r.relayHost, r.cspHost);
  assert.equal(r.relayHost, 'api.aeerks.sn');
});

test('parseVercelConfig — port explicite conservé dans l\'hôte', () => {
  const brut = CORRECT.split('api.aeerks.sn').join('localhost:4003');
  const r = parseVercelConfig(brut);
  assert.equal(r.relayHost, 'localhost:4003');
  assert.equal(r.cspHost, 'localhost:4003');
});

test('parseVercelConfig — $schema n\'est jamais pris pour un backend', () => {
  // openapi.vercel.sh est une URL https du fichier. Un test naïf qui comparerait
  // « toutes les URL » le signalerait comme un hôte de second point, et ferait
  // échouer chaque déploiement.
  const r = parseVercelConfig(CORRECT);
  assert.notEqual(r.relay, 'https://openapi.vercel.sh');
  assert.notEqual(r.csp, 'https://openapi.vercel.sh');
});

test('parseVercelConfig — marqueur encore présent', () => {
  // Le marqueur figure deux fois dans vercel.json : relais + connect-src.
  const brut = CORRECT.split('api.aeerks.sn').join(MARQUEUR);
  const r = parseVercelConfig(brut);
  assert.equal(r.configured, false);
  assert.equal(r.occurrences, 2);
});

test('parseVercelConfig — relais absent', () => {
  const r = parseVercelConfig('{ "framework": null }');
  assert.equal(r.configured, false);
  assert.equal(r.relay, null);
});

test('resolveBackendOrigin — configuration cohérente', () => {
  const r = resolveBackendOrigin(CORRECT);
  assert.equal(r.origin, 'https://api.aeerks.sn');
  assert.equal(r.wsUrl, 'wss://api.aeerks.sn');
  assert.equal(r.originOverride, false);
});

test('resolveBackendOrigin — refus explicite si le marqueur est là', () => {
  const brut = CORRECT.split('api.aeerks.sn').join(MARQUEUR);
  assert.throws(() => resolveBackendOrigin(brut), (e) => {
    assert.match(e.message, /marqueur/);
    // Le message doit dire COMMENT corriger, sinon l'opérateur tataie.
    assert.match(e.message, /vercel:backend/);
    return true;
  });
});

test('resolveBackendOrigin — relais et CSP divergents : refus', () => {
  // C'est le mode de panne le plus vicieux : le build passe, l'API répond via
  // un hôte et la CSP en interdit un autre, donc le jeton est émis pour l'un et
  // refusé par l'autre. L'utilisateur est déconnecté sans explication.
  const brut = CORRECT.replace('wss://api.aeerks.sn', 'wss://autre.exemple');
  assert.throws(() => resolveBackendOrigin(brut), /connect-src/);
});

test('resolveBackendOrigin — schéma différent, même hôte : accepté', () => {
  // La contrepartie du test précédent : si on comparait les origines, ce build
  // échouerait alors qu'il est parfaitement correct.
  const r = resolveBackendOrigin(CORRECT);
  assert.equal(r.wsUrl, 'wss://api.aeerks.sn');
});

test('resolveBackendOrigin — divergence de PORT détectée', () => {
  // Deux origines différentes peuvent porter le même nom d'hôte : c'est le
  // port qui distingue le relais du canal. L'ignorer laisserait passer un
  // déploiement où l'API et le socket ne sont pas le même service.
  const brut = CORRECT.replace('wss://api.aeerks.sn', 'wss://api.aeerks.sn:4001');
  assert.throws(() => resolveBackendOrigin(brut), /connect-src/);
});

test('resolveBackendOrigin — refus si le relais est absent', () => {
  const brut = CORRECT.replace(/https:\/\/api\.aeerks\.sn/, 'REMPLACER_PAR_TON_API');
  assert.throws(() => resolveBackendOrigin(brut), /marqueur|relais/);
});

test('wsUrlFor — le schéma suit celui de l\'API', () => {
  assert.equal(wsUrlFor('https://api.aeerks.sn'), 'wss://api.aeerks.sn');
  assert.equal(wsUrlFor('http://localhost:4003'), 'ws://localhost:4003');
});

test('wsUrlFor — barre oblique finale tolérée', () => {
  // L\'opérateur la tape spontanément : `https://x.sn/` ne doit pas produire
  // `wss://x.sn//ws`.
  assert.equal(wsUrlFor('https://api.aeerks.sn/'), 'wss://api.aeerks.sn');
  assert.equal(wsUrlFor('  https://api.aeerks.sn/  '), 'wss://api.aeerks.sn');
});

test('wsUrlFor — port explicite conservé', () => {
  assert.equal(wsUrlFor('http://localhost:4003'), 'ws://localhost:4003');
});

test('parseVercelConfig — substitution ratée : hôte illisible', () => {
  // Le marqueur est suffixé d'un schéma déjà écrit dans le fichier. Le
  // remplacer par une origine ENTIERE produit `https://https://hôte`, dont la
  // regex relit l'hôte comme « https: ». Les deux occurrences corrompues
  // donnent le meme hôte : la coherence passerait, et le deploiement partirait
  // vert avec un canal temps reel mort. L'echec doit etre explicite.
  const brut = CORRECT
    .split('https://api.aeerks.sn')
    .join('https://https://aeerks-n8pe.onrender.com')
    .replace('wss://api.aeerks.sn', 'wss://https://aeerks-n8pe.onrender.com');
  const r = parseVercelConfig(brut);
  assert.equal(r.occurrences, 0);
  assert.equal(r.relayHost, null, 'un hote contenant un schema doit etre rejete');

  assert.throws(() => resolveBackendOrigin(brut), /illisible/);
});

test('readBackendOverride — absent par défaut', () => {
  assert.equal(readBackendOverride(['node', 'script']), undefined);
});

test('readBackendOverride — lu quand présent', () => {
  assert.equal(
    readBackendOverride(['node', 'script', '--backend', 'https://x.sn']),
    'https://x.sn'
  );
});

test('readBackendOverride — sans valeur : erreur explicite', () => {
  // `--backend` suivi d'un autre drapeau doit être refusé, pas interprété
  // comme le drapeau suivant.
  assert.throws(() => readBackendOverride(['node', 's', '--backend', '--autre']), /attend une valeur/);
});

test('resolveBackendOrigin — override de validation (CI)', () => {
  const r = resolveBackendOrigin(CORRECT, { override: 'https://validation.invalid' });
  assert.equal(r.origin, 'https://validation.invalid');
  assert.equal(r.wsUrl, 'wss://validation.invalid');
  assert.equal(r.originOverride, true);
});

test('resolveBackendOrigin — override tolère la barre finale', () => {
  const r = resolveBackendOrigin(CORRECT, { override: 'https://validation.invalid/' });
  assert.equal(r.origin, 'https://validation.invalid');
});

test('resolveBackendOrigin — override sans schéma : refusé', () => {
  // Un hôte nu se combinerait au protocole de la page, ce qui donnerait un
  // `connect-src` relatif : le build « réussirait » avec une CSP inopérante.
  assert.throws(
    () => resolveBackendOrigin(CORRECT, { override: 'api.aeerks.sn' }),
    /origine absolue/
  );
});

test('resolveBackendOrigin — l\'override court-circuite le marqueur, et le signale', () => {
  const brut = CORRECT.split('api.aeerks.sn').join(MARQUEUR);
  const r = resolveBackendOrigin(brut, { override: 'https://validation.invalid' });
  // Sans ce drapeau, un déploiement réel pourrait être produit avec une origine
  // de test sans que rien ne le signale.
  assert.equal(r.originOverride, true);
});