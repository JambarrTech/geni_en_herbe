/**
 * Verification du blueprint Render.
 *
 * DIAGNOSTIC, PAS SCRIPT DE PRODUCTION
 * -----------------------------------
 * `render.yaml` est lu par Render, pas par Node : rien dans le code ne le
 * valide. Une faute de frappe dans un champ se paie par un deploiement rate,
 * avec un message qui parle du build et jamais de la configuration.
 *
 * Ce fichier le lit avec le meme parseur YAML que les editeurs (js-yaml, la
 * dependance deja presente dans node_modules) et affiche la structure telle que
 * Render la verra. Lecture seule, aucune connexion, aucune ecriture.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const doc = yaml.load(readFileSync('render.yaml', 'utf8'));
const service = doc.services[0];

console.log('YAML parse : OK');
console.log('');
console.log('type       :', service.type);
console.log('runtime    :', service.runtime);
console.log('plan       :', service.plan);
console.log('health     :', service.healthCheckPath);
console.log('envVars    :', service.envVars.map((e) => e.key).join(', '));
console.log('');

// `buildCommand` est la porte d'entrée du runtime natif : c'est lui qui produit
// les trois applications Vite ET les dépendances du backend, puisque le dépôt
// ne contient plus de Dockerfile. Son absence laisserait Render démarrer un
// service sans `apps/*/dist` ni `tsx`.
console.log('buildCommand present ?', 'buildCommand' in service ? 'OUI' : 'NON (INCOHERENT)');
console.log('startCommand present ?', 'startCommand' in service ? 'OUI' : 'NON (service sans commande de demarrage)');
console.log('');

// `WS_ALLOWED_ORIGINS` decide si le WebSocket du jury sera accepte. C'est le
// piege du deploiement a deux origines : le navigateur envoie alors l'origine
// Vercel, et si elle ne figure pas dans la liste, la connexion est refusee
// (code 1008) — le jury voit un chrono qui ne descend pas.
const ws = service.envVars.find((e) => e.key === 'WS_ALLOWED_ORIGINS');
if (!ws) {
  console.log('ATTENTION : WS_ALLOWED_ORIGINS absent de envVars.');
} else if (ws.sync === false) {
  console.log('WS_ALLOWED_ORIGINS : a definir dans le dashboard Render.');
  console.log('  Valeur attendue : l origine Vercel, ex. https://aeerks.vercel.app');
  console.log('  VIDE = meme origine uniquement. Sur un deploiement a deux origines,');
  console.log('  une valeur vide REFUSE le WebSocket de l interface Vercel.');
} else if (ws.value === '') {
  console.log('WS_ALLOWED_ORIGINS : vide (meme origine).');
  console.log(' _ATTENTION_ si l interface est sur Vercel : la connexion sera refusee.');
} else {
  console.log('WS_ALLOWED_ORIGINS :', ws.value);
}
