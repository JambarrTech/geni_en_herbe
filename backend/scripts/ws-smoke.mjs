/**
 * Verification de bout en bout du canal temps reel a travers le superviseur.
 *
 * Le but n'est pas de tester `ws.ts` — ses tests existent — mais de prouver que
 * l'UPGRADE traverse le relais de `static` dans la configuration supervisee :
 * c'est le point exact qu'un hebergeur casse (proxy sans support d'upgrade).
 */
import { WebSocket } from 'ws';

const url = process.argv[2] ?? 'ws://127.0.0.1:4103/ws';
console.log(`Connexion a ${url} ...`);

const ws = new WebSocket(url);
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

setTimeout(() => {
  if (!fini) console.log('TIMEOUT aucune connexion, aucune erreur');
  process.exit(fini ? 0 : 1);
}, 12_000);