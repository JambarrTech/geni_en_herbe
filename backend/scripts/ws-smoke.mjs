/**
 * Verification de bout en bout du canal temps reel a travers le superviseur.
 *
 * Le but n'est pas de tester `ws.ts` — ses tests existent — mais de prouver que
 * l'UPGRADE traverse le relais de `static` dans la configuration supervisee :
 * c'est le point exact qu'un hebergeur casse (proxy sans support d'upgrade).
 *
 * L'ORIGINE EST ENVOYEE, ET C'EST ESSENTIEL
 * ------------------------------------------
 * Un deploiement a deux origines (interface sur Vercel, backend sur Render)
 * impose `WS_ALLOWED_ORIGINS` non vide, et une liste non vide REFUSE une
 * requete depourvue d'en-tete `Origin` (cf. `lib/wsOrigin.ts`). Sans reproduire
 * cette requete, la sonde echouerait sur un backend parfaitement configure —
 * un faux negatif qui ferait corriger une variable qui est deja la bonne.
 *
 * Usage :
 *   node --import tsx scripts/ws-smoke.mjs [url] [origin]
 */
import { WebSocket } from 'ws';

const url = process.argv[2] ?? 'ws://127.0.0.1:4103/ws';
const origin = process.argv[3];
console.log(`Connexion a ${url} ...`);
if (origin) console.log(`Origine annoncee : ${origin}`);

const ws = origin ? new WebSocket(url, { origin }) : new WebSocket(url);
let fini = false;

const ok = (message) => {
  console.log(message);
  fini = true;
  try {
    ws.close();
  } catch {
    /* deja ferme */
  }
};

ws.on('open', () => ok('OK    upgrade WebSocket accepte a travers le relais'));
ws.on('message', (data) => ok(`OK    message recu : ${String(data).slice(0, 80)}`));
ws.on('error', (err) => ok(`ERREUR ${err.message}`));

// 1008 = politique d'acces refusee : l'origine annoncee ne figure pas dans
// WS_ALLOWED_ORIGINS. C'est le mode de panne le plus courant d'un deploiement
// a deux origines ; sans ce message, la sortie reste un « FERME » sans cause
// et l'on cherche le mauvais endroit pendant des heures.
ws.on('close', (code, reason) => {
  if (fini) return;
  fini = true;
  if (code === 1008) {
    console.log(
      `REFUS (1008) : l'origine annoncee n'est pas dans WS_ALLOWED_ORIGINS.\n` +
        `  Annonce : ${origin ?? '(aucune)'}\n` +
        `  Verifiez la variable dans le dashboard Render.`
    );
  } else if (code === 1011) {
    console.log(`ERREUR (1011) : ${String(reason)}`);
  } else {
    console.log(`FERME (${code}) ${String(reason)}`);
  }
  process.exit(1);
});

setTimeout(() => {
  if (!fini) console.log('TIMEOUT aucune connexion, aucune erreur');
  process.exit(fini ? 0 : 1);
}, 12_000);