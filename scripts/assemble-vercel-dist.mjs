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
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBackendOverride, resolveBackendOrigin } from './vercel-backend.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'dist');
const VERCEL_CONFIG = path.join(ROOT, 'vercel.json');

/**
 * Adresse du backend, lue dans la même source que la configuration Vercel.
 *
 * SOURCE UNIQUE
 * -------------
 * L'URL du backend apparaît deux fois dans `vercel.json` : le relais `/api`
 * et la directive `connect-src` de la CSP (le WebSocket ne peut pas être
 * relayé par Vercel, il doit donc être autorisé explicitement). Deux
 * occurrences à renseigner à la main, c'est deux occasions d'en oublier une —
 * et l'oubli est silencieux : la page s'affiche, puis le chronomètre ne
 * descend plus.
 *
 * La logique de lecture et de cohérence vit dans `vercel-backend.mjs`, parce
 * qu'un troisième emplacement la consomme : `scripts/build.mjs` en déduit
 * `VITE_WS_URL`. Deux implémentations de la même lecture divergeraient, et la
 * divergence se manifesterait comme un chrono figé — pas comme une erreur.
 */
function verifierBackendConfigure(override) {
  const brut = readFileSync(VERCEL_CONFIG, 'utf8');
  const { origin, wsUrl, originOverride } = resolveBackendOrigin(brut, { override });

  if (originOverride) {
    console.log(
      `[vercel] VALIDATION ONLY — origine de test : ${origin}\n` +
        `         Le déploiement réel exige vercel.json configuré.`
    );
  } else {
    console.log(`[vercel] Backend configuré : ${origin}`);
  }
  console.log(`[vercel] Canal temps réel attendu : ${wsUrl}`);
  return { origin, wsUrl, originOverride };
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
// `--backend <origine>` : mode VALIDATION, réservé à la CI, qui doit pouvoir
// éprouver la mécanique d'assemblage alors que `vercel.json` contient encore le
// marqueur. Il ne doit jamais être défini sur un déploiement réel : c'est
// précisément le cas que le garde-fou doit laisser passer.
verifierBackendConfigure(readBackendOverride(process.argv));
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const entry of PLACEMENT) {
  await copyApp(entry);
}

console.log('[vercel] dist/ pret pour Vercel.');
