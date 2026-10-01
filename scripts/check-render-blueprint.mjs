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
console.log('dockerfile :', service.dockerfilePath);
console.log('context    :', service.dockerContext);
console.log('dockerCmd  :', service.dockerCommand);
console.log('health     :', service.healthCheckPath);
console.log('envVars    :', service.envVars.map((e) => e.key).join(', '));
console.log('');

// Render reserve `buildCommand` aux runtimes natifs. Sur `runtime: docker` il
// est ignore : le champ qui remplace le CMD du Dockerfile est `dockerCommand`.
// Un `buildCommand` ici est donc a la fois inefficace et trompeur -- il laisse
// croire qu'une etape de construction existe.
console.log('buildCommand present ?', 'buildCommand' in service ? 'OUI (inutile sur docker)' : 'non');
