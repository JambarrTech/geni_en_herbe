/**
 * Rejoue la construction des interfaces avec EXACTEMENT les fichiers que le
 * Dockerfile copie.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Un deploiement Render a echoue sur :
 *
 *     Error: Cannot find module '/repo/scripts/build.mjs'
 *
 * La stage `apps-build` copiait `shared/` et `apps/`, jamais `scripts/` — or
 * `npm run build` execute `node scripts/build.mjs`. Le build a donc echoue
 * APRES un `npm ci` reussi, ce qui rend le journal trompeur : 272 paquets
 * installes, puis une erreur qui ne parle pas d'installation.
 *
 * Ce defaut n'a pas ete vu parce que la verification precedente reconstituait
 * l'arborescence A LA MAIN (`git archive` de tel et tel dossier). Elle testait
 * donc une arborescence plus complete que celle du Dockerfile, et ne pouvait
 * pas echouer. Un test qui reconstruit sa propre entree ne teste rien.
 *
 * CE QUE CE SCRIPT FAIT
 * ---------------------
 * Il LIT le Dockerfile : il extrait les instructions `COPY` de la stage
 * `apps-build`, enumere les fichiers suivis par git qui tombent sous ces
 * chemins, applique `.dockerignore`, materialise le tout dans un dossier
 * temporaire, puis y lance `npm ci` et `npm run build`.
 *
 * L'entree du test est donc DERIVEE du Dockerfile, pas ecrite a cote. Ajouter
 * un fichier necessaire au build sans l'ajouter au `COPY` fait echouer ce
 * script — ce qui est exactement le but.
 *
 * USAGE
 * -----
 *     npm run verify:docker-context
 *
 * Lent (une installation complete), donc hors de la suite de tests unitaires.
 * A lancer avant de modifier le Dockerfile ou les scripts de build.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RACINE = process.cwd();
const ETAGE = 'apps-build';

/** Lit un fichier du depot, en refusant l'absence plutot qu'en la supposant. */
function lire(relatif) {
  const chemin = path.join(RACINE, relatif);
  if (!existsSync(chemin)) {
    throw new Error(`Fichier introuvable : ${relatif}`);
  }
  return readFileSync(chemin, 'utf8');
}

/**
 * Decoupe le Dockerfile en stages nommees.
 *
 * Les continuations de ligne (`\` en fin de ligne) sont recollees : une
 * instruction `RUN` sur trois lignes est une seule instruction pour Docker, et
 * l'ignorer ferait lire un Dockerfile que Docker ne lit pas.
 */
function lireStages(dockerfile) {
  const lignes = dockerfile.split(/\r?\n/);
  const stages = new Map();
  let courante = null;
  let tampon = '';

  for (const brute of lignes) {
    const ligne = tampon + brute;
    if (ligne.endsWith('\\')) {
      tampon = ligne.slice(0, -1) + ' ';
      continue;
    }
    tampon = '';

    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(ligne.trim());
    if (from) {
      courante = from[1] ?? `(anonyme ${stages.size})`;
      stages.set(courante, []);
      continue;
    }
    if (courante) stages.get(courante).push(ligne.trim());
  }
  return stages;
}

/**
 * Extrait les sources des `COPY` d'une stage.
 *
 * `COPY a b dest` copie `a` et `b` vers `dest` : tout sauf le dernier jeton est
 * une source. Les `COPY --from=...` sont ignores : ils ne viennent pas du
 * contexte de build mais d'une autre stage, et les inclure ferait croire a des
 * fichiers absents du depot.
 */
function sourcesCopiees(stage) {
  const sources = [];
  for (const ligne of stage) {
    if (!/^COPY\s/i.test(ligne)) continue;
    const jetons = ligne.split(/\s+/).slice(1).filter((j) => !j.startsWith('--'));
    if (jetons.length < 2) continue;
    sources.push(...jetons.slice(0, -1));
  }
  return sources;
}

/**
 * Applique `.dockerignore` a une liste de chemins relatifs.
 *
 * Approximation assumee de la semantique Docker : on ne cherche pas a
 * reproduire `filepath.Match` a la lettre, mais a retirer ce que le
 * `.dockerignore` du depot retire. Le risque d'ecart est dans le sens de
 * l'INCLUSION superflue, jamais de l'omission — or c'est l'omission qui casserait
 * le build, et l'inclusion en trop ne peut pas le faire reussir a tort.
 */
function appliquerDockerignore(chemins) {
  const brut = existsSync(path.join(RACINE, '.dockerignore'))
    ? lire('.dockerignore')
    : '';

  const motifs = brut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const positifs = motifs.filter((m) => !m.startsWith('!'));
  const negations = motifs.filter((m) => m.startsWith('!')).map((m) => m.slice(1));

  const correspond = (motif, chemin) => {
    const base = path.posix.basename(chemin);
    if (motif === base) return true;
    if (motif.startsWith('**/')) return correspond(motif.slice(3), chemin);
    if (motif.startsWith('*.') && base.endsWith(motif.slice(1))) return true;
    if (motif.startsWith('*.')) return base.endsWith(motif.slice(1));
    // `dossier/` ou `dossier` : le chemin, ou l'un de ses segments parents.
    const sansSlash = motif.replace(/\/$/, '');
    return (
      chemin === sansSlash ||
      chemin.startsWith(`${sansSlash}/`) ||
      chemin.split('/').includes(sansSlash)
    );
  };

  return chemins.filter((chemin) => {
    if (negations.some((m) => correspond(m, chemin))) return false;
    return !positifs.some((m) => correspond(m, chemin));
  });
}

/** Enumere les fichiers suivis par git sous les chemins donnees. */
function fichiersSous(sources) {
  const tous = execFileSync('git', ['ls-files', '-z'], {
    cwd: RACINE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);

  return tous.filter((f) =>
    sources.some((src) => {
      const propre = src.replace(/^\.\//, '').replace(/\/$/, '');
      return f === propre || f.startsWith(`${propre}/`);
    })
  );
}

function copier(racineTemp, fichiers) {
  for (const relatif of fichiers) {
    const destination = path.join(racineTemp, relatif);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(path.join(RACINE, relatif)));
  }
}

// --- Execution -------------------------------------------------------------

const dockerfile = lire('Dockerfile');
const stages = lireStages(dockerfile);

if (!stages.has(ETAGE)) {
  console.error(
    `ECHEC : la stage « ${ETAGE} » est introuvable dans le Dockerfile.\n` +
      `Stages trouvees : ${[...stages.keys()].join(', ')}`
  );
  process.exit(1);
}

const sources = sourcesCopiees(stages.get(ETAGE));
console.log(`[contexte] stage « ${ETAGE} » — ${sources.length} source(s) copiee(s) :`);
for (const s of sources) console.log(`  ${s}`);

const suivis = fichiersSous(sources);
const aCopier = appliquerDockerignore(suivis);
console.log(`[contexte] ${suivis.length} fichier(s) suivis, ${aCopier.length} apres .dockerignore.`);

// Verification ciblee : l'erreur qui a coûte un deploiement, nommee d'avance.
// Un message generique « npm a echoue » n'aide personne ; celui-ci dit quoi
// ajouter au Dockerfile.
const paquet = JSON.parse(lire('package.json'));
const commandeBuild = paquet.scripts?.build ?? '';
const entreeBuild = /node\s+(\S+\.mjs)/.exec(commandeBuild)?.[1];

if (entreeBuild && !aCopier.includes(entreeBuild)) {
  console.error(
    `\nECHEC PREDITIF : « npm run build » execute « ${entreeBuild} », ` +
      `mais ce fichier n'est pas dans le contexte de build.\n` +
      `Ajoutez « COPY ${path.posix.dirname(entreeBuild)}/ ./${path.posix.dirname(entreeBuild)}/ » ` +
      `a la stage « ${ETAGE} » du Dockerfile.`
  );
  process.exit(1);
}

const temporaire = path.join(os.tmpdir(), `aeerks-build-context-${process.pid}`);
rmSync(temporaire, { recursive: true, force: true });
mkdirSync(temporaire, { recursive: true });

try {
  copier(temporaire, aCopier);
  console.log(`[contexte] materialise dans ${temporaire}\n`);

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const shell = process.platform === 'win32';

  for (const [etape, args] of [
    ['npm ci', ['ci']],
    ['npm run build', ['run', 'build']],
  ]) {
    console.log(`[contexte] ${etape} ...`);
    const resultat = spawnSync(npm, args, {
      cwd: temporaire,
      stdio: 'inherit',
      shell,
    });
    if (resultat.status !== 0) {
      console.error(
        `\nECHEC : « ${etape} » a retourne ${resultat.status} avec le contexte du Dockerfile.\n` +
          `Le build fonctionne peut-etre en local, mais il ne fonctionne pas avec ce que\n` +
          `l'image copie. C'est exactement le defaut que ce script existe pour attraper.`
      );
      process.exit(1);
    }
  }

  console.log('\n[contexte] OK : le build reussit avec le contexte exact du Dockerfile.');
} finally {
  rmSync(temporaire, { recursive: true, force: true });
}
