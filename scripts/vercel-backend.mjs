/**
 * Origine du backend : SOURCE UNIQUE de vérité pour le déploiement Vercel.
 *
 * LE PROBLÈME QUE CE MODULE RÉSOUT
 * ---------------------------------
 * L'adresse du backend devait être renseignée à TROIS endroits :
 *
 *   1. `vercel.json` — destination du relais `/api`
 *   2. `vercel.json` — directive `connect-src` de la CSP (le WebSocket)
 *   3. tableau de bord Vercel — variable `VITE_WS_URL` utilisée au build
 *
 * Trois saisies manuelles pour une seule valeur. `scripts/assemble-vercel-dist.mjs`
 * vérifiait déjà que (1) et (2) concordaient — mais (3) restait hors de portée :
 * un `VITE_WS_URL` oublié ou périmé produisait un déploiement **entièrement
 * vert** (build réussi, assets vérifiés, distillations OK) dont la seule
 * conséquence est que le chronomètre ne descend plus le jour de la compétition.
 * Aucun test ne l'attrape, parce que la valeur est injectée par l'environnement,
 * pas par le code.
 *
 * La correction n'est pas un test de plus : c'est de supprimer l'entrée (3).
 * `vercel.json` devient l'unique endroit où l'hôte est écrit, et ce module le
 * lit pour en déduire `VITE_WS_URL` au moment du build. Une valeur, une saisie,
 * et le garde-fou existant s'applique enfin à l'ensemble.
 *
 * C'est aussi pourquoi ce fichier n'exporte que des fonctions PURES : la
 * lecture disque est faite par l'appelant, ce qui rend la logique testable
 * sans fixture et sans I/O.
 */

/** Marqueur laissé dans `vercel.json` tant que le domaine n'est pas choisi. */
export const MARQUEUR = 'REMPLACER_PAR_TON_API';

/**
 * Lit les deux emplacements qui doivent nommer le même hôte.
 *
 * DEUX BUGS CORRIGÉS ICI, TROUVÉS PAR LES TESTS
 * ---------------------------------------------
 * La version d'origine de cette lecture était du code mort, et elle ne pouvait
 * pas ne pas l'être :
 *
 * 1. **La regex ne trouvait rien.** Elle cherchait `https?://` dans la
 *    directive `connect-src`, or cette directive contient `wss://`. Aucune
 *    correspondance, donc `csp` valait toujours `null`, donc le contrôle de
 *    cohérence — celui dont le commentaire affirmait qu'il attrapait « le jeton
 *    émis pour un hôte et refusé par l'autre » — ne s'exécutait jamais. Le
 *    garde-fou advertised depuis le premier commit n'avait jamais rien vérifié.
 *
 * 2. **Comparer les origines aurait été faux.** Même en matchant, comparer
 *    `https://api.aeerks.sn` (le relais) à `wss://api.aeerks.sn` (la CSP) donne
 *    deux chaînes différentes pour une configuration parfaitement correcte : le
 *    script aurait alors échoué sur TOUT déploiement valide. Il n'échouait que
 *    parce qu'il ne voyait rien. Corriger la seule regex aurait cassé le
 *    déploiement — c'est le piège classique d'un test qui « passe » sans rien
 *    contrôler.
 *
 * Ce qui se compare, c'est donc l'HÔTE, pas l'origine : le relais est en
 * `https:`, le canal en `wss:`, et c'est normal.
 *
 * On ne retient pas non plus toutes les URL du fichier : `$schema` pointe vers
 * `openapi.vercel.sh`, qui n'est pas un backend, et une telle comparaison
 * signalerait cette URL à chaque déploiement.
 *
 * @param {string} json contenu brut de `vercel.json`
 */
export function parseVercelConfig(json) {
  const occurrences = (json.match(new RegExp(MARQUEUR, 'g')) ?? []).length;
  const relay = json.match(/"destination":\s*"(https?:\/\/[^/"]+)/i)?.[1]?.toLowerCase() ?? null;
  const csp = json.match(/connect-src[^"]*?((?:https?|wss?):\/\/[a-z0-9.:-]+)/i)?.[1]?.toLowerCase() ?? null;
  return {
    relay,
    csp,
    /** Hôte du relais, port compris : `api.aeerks.sn`, `localhost:4003`. */
    relayHost: hostOf(relay),
    /** Hôte autorisé par la CSP, port compris. */
    cspHost: hostOf(csp),
    occurrences,
    configured: occurrences === 0 && Boolean(relay),
  };
}

/**
 * `https://h:1/x` -> `h:1`. `null` si l'entrée est absente ou illisible.
 *
 * Un hôte qui contient encore un schéma est INVALIDE. C'est le symptôme d'une
 * substitution Ratée — remplacer `https://MARQUEUR` par une origine entière
 * produit `https://https://hôte`, dont la regex relit l'hôte comme `https:`.
 * Deux occurrences ainsi corrompues donnent le MÊME hôte : la comparaison
 * passerait, `VITE_WS_URL` vaudrait `wss://https:`, et le déploiement partirait
 * entièrement vert avec un canal temps réel mort. Seul un refus explicite
 * l'empêche — d'où l'exigence sur la forme, ci-dessous.
 */
function hostOf(url) {
  if (!url) return null;
  const m = url.match(/^[a-z0-9+.-]+:\/\/([^/]+)/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  // Hôte valide : nom optionally qualifié, port numérique facultatif.
  return /^[a-z0-9.-]+(:\d+)?$/.test(host) ? host : null;
}

/**
 * Déduit l'URL du canal temps réel à partir de l'origine du backend.
 *
 * Le schéma suit celui de l'API : `https:` donne `wss:`, `http:` donne `ws:`.
 * Écrire `wss:` en dur casserait le développement en `http://localhost` — le
 * navigateur refuse un socket sécurisé sur une page non sécurisée.
 */
export function wsUrlFor(origin) {
  const trimmed = origin.trim().replace(/\/+$/, '');
  return trimmed.startsWith('http://') ? `ws://${trimmed.slice('http://'.length)}` : `wss://${trimmed.replace(/^https:\/\//, '')}`;
}

/**
 * Résout l'origine du backend à utiliser pour le build.
 *
 * @param {string} json contenu brut de `vercel.json`
 * @param {{ override?: string | undefined }} [options]
 *   `override` sert aux runs de VALIDATION (CI), où `vercel.json` contient encore
 *   le marqueur. Il ne doit jamais être défini sur un déploiement réel : c'est
 *   précisément le cas que le garde-fou doit laisser passer.
 * @returns {{ origin: string, wsUrl: string, originOverride: boolean }}
 */
export function resolveBackendOrigin(json, options = {}) {
  const override = options.override?.trim();

  if (override) {
    const origin = override.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(origin)) {
      throw new Error(`--backend doit être une origine absolue (https:// ou http://). Reçu : « ${override} »`);
    }
    return { origin, wsUrl: wsUrlFor(origin), originOverride: true };
  }

  const { relay, relayHost, csp, cspHost, occurrences } = parseVercelConfig(json);

  if (occurrences > 0) {
    throw new Error(
      `vercel.json contient encore le marqueur « ${MARQUEUR} » (${occurrences} occurrence(s)).\n` +
        `  Remplace-le par l'URL de ton backend, dans les DEUX endroits :\n` +
        `    - la destination du relais /api\n` +
        `    - la directive connect-src de la CSP (WebSocket)\n` +
        `  Puis commite le fichier : VITE_WS_URL en découle automatiquement.\n` +
        `  Exemple : https://aeerks.onrender.com\n` +
        `  (npm run vercel:backend -- https://aeerks.onrender.com le fait à ta place)`
    );
  }

  if (!relay) {
    throw new Error(
      `vercel.json : aucune destination https pour le relais /api. ` +
        `Sans elle, l'interface appelle /api sur le CDN, qui ne répond pas.`
    );
  }

  // Hôte illisible = substitution ratée (schéma emboîté, double protocole).
  // On le signale ici, explicitement, alors qu'il laisserait sinon passer
  // toutes les vérifications suivantes.
  if (!relayHost) {
    throw new Error(
      `vercel.json : le relais /api est illisible — « ${relay} ».\n` +
        `  Cela arrive quand le schéma est écrit deux fois (` +
        `https://https://…). Reinitialise le marqueur puis relance ` +
        `npm run vercel:backend -- <ton origine>.`
    );
  }
  if (csp && !cspHost) {
    throw new Error(
      `vercel.json : connect-src est illisible — « ${csp} ». Meme cause que le relais.`
    );
  }

  if (csp && (!cspHost || !relayHost || cspHost !== relayHost)) {
    throw new Error(
      `vercel.json : le relais /api vise ${relay} mais connect-src vise ${csp}.\n` +
        `  Les deux doivent nommer le MÊME HÔTE : sinon le jeton de session est émis ` +
        `pour un hôte et refusé par l'autre, et l'utilisateur se voit déconnecté ` +
        `sans explication.\n` +
        `  (Le schéma n'a pas besoin de correspondre : wss: est attendu pour le ` +
        `canal, https: pour le relais.)`
    );
  }

  return { origin: relay, wsUrl: wsUrlFor(relay), originOverride: false };
}

/**
 * Extrait `--backend <origine>` des arguments de la ligne de commande.
 * @param {string[]} argv
 * @returns {string | undefined}
 */
export function readBackendOverride(argv) {
  const i = argv.indexOf('--backend');
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--backend attend une valeur : --backend https://exemple.sn');
  }
  return value;
}