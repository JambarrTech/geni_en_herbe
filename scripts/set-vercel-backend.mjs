/**
 * Renseigne l'origine du backend dans `vercel.json`, en UNE commande.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * L'hôte du backend apparaît deux fois dans `vercel.json` : la destination du
 * relais `/api` et la directive `connect-src` de la CSP. Les saisir à la main
 * était jusqu'ici la source d'un mode de panne silencieux et coûteux : si les
 * deux divergeaient, le build passait, les pages s'affichaient, et l'utilisateur
 * se voyait déconnecté sans explication ; si le marqueur restait, le build
 * échouait avec un message à déchiffrer.
 *
 * `npm run vercel:backend -- https://aeerks.onrender.com` remplace les deux
 * occurrences d'un coup, puis affiche ce qu'il reste à faire ailleurs — parce
 * qu'il reste forcément une chose à faire ailleurs : `WS_ALLOWED_ORIGINS` sur
 * Render doit contenir l'origine Vercel, et elle n'est connue qu'après la
 * création du projet.
 *
 * Usage :
 *   npm run vercel:backend -- https://aeerks.onrender.com
 *   npm run vercel:backend -- https://aeerks.onrender.com/   (barre finale tolérée)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MARQUEUR } from './vercel-backend.mjs';

const CONFIG = path.resolve('vercel.json');

const argv = process.argv.slice(2).filter((a) => a !== '--');
if (argv.length !== 1) {
  console.error(
    `Usage : npm run vercel:backend -- <origine>\n` +
      `  Exemple : npm run vercel:backend -- https://aeerks.onrender.com`
  );
  process.exit(1);
}

const saisie = argv[0];
if (!/^https?:\/\//.test(saisie)) {
  console.error(
    `« ${saisie} » n'est pas une origine absolue.\n` +
      `  Attendu : https://ton-backend.exemple (le schema http/https est obligatoire,\n` +
      `  et aucune barra oblique finale n'est necessaire).`
  );
  process.exit(1);
}

const origin = saisie.trim().replace(/\/+$/, '');
const hostOnly = origin.replace(/^https?:\/\//i, '');

let brut = readFileSync(CONFIG, 'utf8');
const occurrences = (brut.match(new RegExp(MARQUEUR, 'g')) ?? []).length;

if (occurrences === 0) {
  const dejaConfigure = brut.match(/"destination":\s*"(https?:\/\/[^/"]+)/i)?.[1];
  if (dejaConfigure?.toLowerCase() === origin.toLowerCase()) {
    console.log(`[vercel] ${origin} est deja renseigne dans les deux emplacements.`);
    process.exit(0);
  }
  console.error(
    `vercel.json ne contient plus le marqueur, et son relais vise ${dejaConfigure}.\n` +
      `  Pour changer de backend, remplace a la main les DEUX occurrences de\n` +
      `  ${dejaConfigure} dans vercel.json, puis relance cette commande pour verifier.`
  );
  process.exit(1);
}

// On substitue l'HÔTE, jamais l'origine entière.
//
// Le marqueur est *suffixé* d'un schéma déjà écrit dans le fichier : le relais
// porte `https://REMPLACER_PAR_TON_API` et la CSP `wss://REMPLACER_PAR_TON_API`.
// Remplacer le marqueur par l'origine entière produirait
// `https://https://aeerks.onrender.com` — un relais qui, relu par la regex,
// donne un hôte « https: », lequel compare EGAL à l'autre « https: ». Le
// contrôle de cohérence passe alors, VITE_WS_URL devient `wss://https:`, et le
// déploiement est produit entièrement vert avec un canal temps réel mort.
//
// C'est exactement le piège que cette commande existe pour éviter : on ne
// touche qu'à l'hôte, chaque occurrence conserve le schéma qui lui convient.
const avant = brut;
brut = brut.replace(
  new RegExp(`${MARQUEUR}`, 'g'),
  hostOnly
);

if (brut === avant) {
  console.error(`Aucun marqueur trouve dans ${CONFIG}.`);
  process.exit(1);
}

const reste = (brut.match(new RegExp(MARQUEUR, 'g')) ?? []).length;
if (reste > 0) {
  console.error(`${reste} occurrence(s) du marqueur subsistent.`);
  process.exit(1);
}

writeFileSync(CONFIG, brut, 'utf8');

console.log(`[vercel] ${occurrences} occurrence(s) du marqueur remplacee(s) par ${hostOnly} :`);
console.log(`         - relais /api        (${origin})`);
console.log(`         - connect-src / CSP  (wss://${hostOnly})`);
console.log('');
console.log('VITE_WS_URL sera deduit de ce fichier au build : rien a saisir.');
console.log('');
console.log('Il reste deux etapes, sur des plateformes differentes :');
console.log(`  1. Sur Render : WS_ALLOWED_ORIGINS = <ton origine Vercel>`);
console.log(`     (obligatoire : une liste vide refuse le WebSocket, code 1008)`);
console.log('  2. Sur Vercel : declarer le projet avec le dossier racine du depot.');
console.log('');
console.log('Commite vercel.json : le build Vercel lit ce fichier.');