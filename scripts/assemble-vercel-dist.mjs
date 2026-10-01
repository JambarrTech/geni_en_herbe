/**
 * Assemblage des trois applications en un seul repertoire `dist/`.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * Vercel sert UN SEUT `outputDirectory`. Or `npm run build` produit trois
 * repertoires independants : `apps/live/dist`, `apps/jury/dist`,
 * `apps/admin/dist`.
 *
 * Et ce n'est pas un detail : les trois apps sont DEJA concues pour etre
 * servies sous des prefixes (`scripts/build.mjs` passe `VITE_BASE_PATH` a
 * `/`, `/jury/` et `/admin/`). Elles n'ont donc pas besoin d'etre remontees en
 * une seule application — il suffit de lesemblemes sous le memePrefix, ce que
 * fait ce script :
 *
 *     dist/index.html            <- apps/live/dist   (base '/')
 *     dist/assets/...            <- idem
 *     dist/jury/index.html       <- apps/jury/dist   (base '/jury/')
 *     dist/jury/assets/...
 *     dist/admin/index.html      <- apps/admin/dist  (base '/admin/')
 *
 * Les URL d'assets generes par Vite sont donc deja correctes, sans
 * reecriture : `/jury/assets/index-abc123.js` pointe bien vers le fichier
 * present. C'est la raison pour laquelle les bases n'ont pas ete redefinies
 * pour Vercel — elles etaient deja justes.
 *
 * LA VÉRIFICATION QUI COMPTE
 * --------------------------
 * Un build Vite « réussit » meme avec une base mal configuree : les fichiers
 * sont produits, mais le HTML reference des assets inexistants, et chaque page
 * affiche une page blanche. Aucun bundler ne leve d'erreur dans ce cas.
 *
 * C'est exactement le defaut que la verification du CSS a deja rattrape pour
 * `shared/` (cf. `scripts/verify-build-output.mjs`). On ajoute ici la meme
 * precaution pour les bases : on lit les HTML produits et on verifie que
 * chaque reference d'asset existe reellement sur le disque. Un deploiement qui
 * aboutirait a trois pages blanches echoue donc au build, pas a l'usage.
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'dist');

/**
 * Adresse du backend, lue dans la meme source que la configuration Vercel.
 *
 * SOURCE UNIQUE
 * -------------
 * L'URL du backend apparait deux fois dans `vercel.json` : le relais `/api`
 * et la directive `connect-src` de la CSP (le WebSocket ne peut pas etre
 * relaye par Vercel, il doit donc etre autorisé explicitement). Deux
 * occurrences à renseigner à la main, c'est deux occasions d'en oublier une —
 * et l'oubli est silencieux : la page s'affiche, puis le chronometre ne
 * descend plus.
 *
 * Ce script lit donc le fichier, verifie que le marqueur a bien ete remplace,
 * et echoue le build sinon. Le deploiement echoue donc tot, et bruyamment,
 * plutot qu'etre livre avec un canal temps reel casse.
 */
const VERCEL_CONFIG = path.join(ROOT, 'vercel.json');
const MARQUEUR = 'REMPLACER_PAR_TON_API';

async function verifierBackendConfigure() {
  const brut = await readFile(VERCEL_CONFIG, 'utf8');
  if (brut.includes(MARQUEUR)) {
    const occurrences = (brut.match(new RegExp(MARQUEUR, 'g')) ?? []).length;
    throw new Error(
      `vercel.json contient encore le marqueur « ${MARQUEUR} » (${occurrences} occurrence(s)).\n` +
        `  Remplace-le par l'URL de ton backend, dans les DEUX endroits :\n` +
        `    - la destination du relais /api\n` +
        `    - la directive connect-src de la CSP (WebSocket)\n` +
        `  Exemple : https://api.aeerks.sn`
    );
  }
  // Cohérence entre les deux emplacements : ils doivent nommer le même hôte.
  //
  // On ne compare que les deux endroits qui comptent, pas toutes les URL du
  // fichier : `$schema` pointe vers `openapi.vercel.sh`, qui n'est pas un
  // backend. Comparer « toutes les URL » à `> 1` aurait signalé cette URL de
  // schéma à chaque déploiement.
  const relais = brut.match(/"destination":\s*"(https?:\/\/[^/"]+)/i)?.[1]?.toLowerCase();
  const csp = brut.match(/connect-src[^"]*?(https?:\/\/[a-z0-9.:-]+)/i)?.[1]?.toLowerCase();

  if (!relais) {
    throw new Error(
      `vercel.json : aucune destination https pour le relais /api. ` +
        `Sans elle, l'interface appelle /api sur le CDN, qui ne repond pas.`
    );
  }
  if (csp && csp !== relais) {
    throw new Error(
      `vercel.json : le relais /api vise ${relais} mais connect-src vise ${csp}.\n` +
        `  Les deux doivent etre identiques : sinon le jeton de session est emis ` +
        `pour un hote et refuse par l'autre, et l'utilisateur se voit deconnecte ` +
        `sans explication.`
    );
  }
  console.log(`[vercel] Backend configuré : ${relais}`);
}

/**
 * Destination de chaque application, relatively a `dist/`.
 *
 * `live` occupe la racine : l'ecran public est a `/`, comme demande.
 */
const PLACEMENT = [
  { app: 'live', prefix: '' },
  { app: 'jury', prefix: 'jury' },
  { app: 'admin', prefix: 'admin' },
];

/** Extrait `src`/`href` de `type` dans un HTML. */
function references(html, type) {
  const attr = type === 'script' ? 'src' : 'href';
  const re = new RegExp(`${attr}="([^"]+)"`, 'g');
  return [...html.matchAll(re)].map((m) => m[1]);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function copyApp({ app, prefix }) {
  const src = path.join(ROOT, 'apps', app, 'dist');
  if (!(await exists(src))) {
    throw new Error(`apps/${app}/dist absent. Lancez \`npm run build\` avant ce script.`);
  }

  const dest = prefix ? path.join(OUT, prefix) : OUT;
  // `cp` vers un dossier existant y copierait un sous-dossier du meme nom :
  // on supprime donc la destination pour obtenir une copie exacte.
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });

  const html = await readFile(path.join(dest, 'index.html'), 'utf8');

  // Toutes les references doivent porter le prefixe de base attendu, et
  // exister sur le disque.
  const attendu = prefix ? `/${prefix}/` : '/';
  const assets = [
    ...references(html, 'script'),
    ...references(html, 'link'),
  ].filter((url) => !url.startsWith('data:'));

  const absentes = [];
  for (const url of assets) {
    if (!url.startsWith(attendu)) {
      absentes.push(`${url} (prefixe attendu : ${attendu})`);
      continue;
    }
    const rel = prefix ? url.slice(`/${prefix}/`.length) : url.replace(/^\//, '');
    if (!(await exists(path.join(dest, rel)))) absentes.push(url);
  }

  if (absentes.length > 0) {
    throw new Error(
      `apps/${app} : le HTML referencia des fichiers absents de dist/.\n` +
        `  ${absentes.join('\n  ')}\n` +
        `  VITE_BASE_PATH vaut « ${attendu} » — c'est lui qui produit ces URL.`
    );
  }

  const fichiers = (await readdir(path.join(dest, 'assets'))).length;
  console.log(
    `[vercel] apps/${app} -> ${prefix ? `/${prefix}/` : '/'} · ${fichiers} asset(s) · ${assets.length} reference(s) verifie(s)`
  );
}

console.log('[vercel] Assemblage de dist/ ...');
await verifierBackendConfigure();
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const entry of PLACEMENT) {
  await copyApp(entry);
}

console.log('[vercel] dist/ pret pour Vercel.');
