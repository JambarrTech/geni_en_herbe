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
 *
 * La DÉCISION est dans `render-blueprint.mjs`, testée ; ce fichier ne fait
 * qu'imprimer. Voir ce module pour pourquoi la séparation est nécessaire.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { auditBlueprint, estIncoherent, parGravite } from './render-blueprint.mjs';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const { findings } = auditBlueprint(yaml.load(readFileSync('render.yaml', 'utf8')));

console.log('YAML parse : OK');
console.log('');

const etiquette = { ok: '  OK  ', info: '       ', warn: '  !   ', ko: '  KO  ' };
for (const f of parGravite(findings)) {
  for (const ligne of f.text.split('\n')) console.log(etiquette[f.level] + ligne);
}

// Un blueprint incoherent doit interrompre le script : un diagnostic qui
// signale un probleme tout en sortant en 0 finit par etre ignore, et l'on
// scopera de diagnostiquer ce qui est deja affiche.
process.exit(estIncoherent(findings) ? 1 : 0);