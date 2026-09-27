/**
 * Vérifie que les classes Tailwind utilisées dans les sources produisent
 * réellement des règles CSS dans les artefacts construits.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * Un bug réel du projet : `shared/` n'était pas déclaré comme source Tailwind.
 * Les pages de connexion, la barre de navigation du staff et le composant
 * `<Modal>` n'avaient donc AUCUNE règle applicable — rendu non stylé, entièrement
 * brisé. Et pourtant, à ce moment-là, tout le reste passait :
 *
 *   - le typecheck : les classes sont de simples chaînes, il n'a rien à dire ;
 *   - ESLint : idem ;
 *   - un grep du bundle JS : les noms de classes y figuraient, puisque le
 *     marqueur `class="..."` est préservé tel quel par la minification.
 *
 * Autrement dit, les trois vérifications usuelles donnent un « tout vert »
 * alors que l'interface est cassée. Le seul juge de paix est le fichier CSS
 * produit.
 *
 * DEUX PIÈGES QUI ONT DONNÉ DES FAUX POSITIFS
 * -------------------------------------------
 * 1. Les deux-points des variantes sont échappés à la minification :
 *      `md:grid-cols-3`  ->  `.md\:grid-cols-3`
 *    Un `includes('md:grid-cols-3')` sur le CSS ne trouve donc RIEN.
 *
 * 2. Les couleurs rgba sont réécrites en hexadécale court :
 *      `rgba(11,59,130,0.09)`  ->  `#0b3b8217`
 *    On ne peut donc pas chercher la forme source.
 *
 * D'où l'approche retenue : extraire les sélecteurs du CSS produit, les
 * déséchapper, et comparer à l'ensemble des classes utilisées. On compare des
 * identifiants, jamais des chaînes brutes.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const APPS = ['live', 'jury', 'admin'];

/**
 * Déséchappe un sélecteur CSS : `\:` -> `:`, `\.` -> `.`, etc.
 * C'est l'inverse exact de ce que fait le minificateur.
 */
function unescapeSelector(raw) {
  return raw.replace(/\\(.)/g, '$1');
}

/**
 * Un jeton extrait du CSS est-il réellement un nom de classe ?
 *
 * Contrainte découverte à l'usage : il ne faut PAS rejeter les classes
 * contenant un point, car la moitié de l'échelle Tailwind est fractionnaire
 * (`gap-1.5`, `px-2.5`, `p-1.5`, `space-y-1.5`). Le minificateur échappe le
 * point — `.gap-1\.5` — et le déséchappement redonne `gap-1.5`. Les rejeter
 * produisait 63 faux positifs, tous de cette famille.
 *
 * En revanche, un point issu d'une VALEUR CSS (`1.5rem`) ne doit pas passer.
 * On distingue les deux : après un point, seuls des chiffres sont acceptés.
 */
function isPlausibleClass(cls) {
  // Une classe commence par une lettre… ou par un tiret suivi d'une lettre :
  // les utilitaires négatifs (`-translate-y-1/2`, `-top-3`, `-mx-1`) sont aussi
  // légitimes que les autres. Les refuser masquait exactement ces trois cas.
  if (!/^-?[a-zA-Z]/.test(cls)) return false;
  if (cls.includes('..')) return false;
  // Le tiret initial ne doit pas être compté comme un segment.
  for (const segment of cls.replace(/^-/, '').split('.').slice(1)) {
    if (!/^\d+$/.test(segment)) return false; // `.5rem` est une valeur, pas une classe
  }
  return /^[A-Za-z0-9_:.%!#()&'"@*+,~>=/-]+$/.test(cls);
}

/**
 * Extrait tous les sélecteurs de classe d'une feuille CSS minifiée et les
 * renvoie déséchappés, sans le point initial.
 *
 * On ignore ce qui suit `{`, `,`, `:` (séparateur de pseudo-classe) ou
 * l'espace, car un sélecteur s'arrête là.
 */
function collectCssClasses(css) {
  const found = new Set();
  // `.` suivi d'une suite de caractères, en autorisant les antislashs.
  const re = /\.((?:[^\s.,:>+~(){}\\]|\\.)+)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const cls = unescapeSelector(m[1]);
    if (isPlausibleClass(cls)) found.add(cls);
  }
  return found;
}

/** Parcourt récursivement un dossier en filtrant sur l'extension. */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.includes(extname(full))) out.push(full);
  }
  return out;
}

/**
 * Extrait les classes Tailwind des sources.
 *
 * Heuristique volontairement STRICTE. Une première version ramassait tous les
 * mots d'une ligne contenant « className= » : elle remontait `className`,
 * `h4`, `div`, `aria-hidden`, et même des fragments du texte français
 * (« nie », « Herbe ») comme si c'étaient des classes — 710 faux positifs, qui
 * auraient rendu le script inutilisable et fait ignorer ses alertes réelles.
 *
 * On procède donc en deux temps :
 *   1. isoler les LITTÉRAUX de chaîne qui sont la valeur d'un attribut
 *      `class` / `className`, ou un argument de `cn(...)` / `clsx(...)` ;
 *   2. découper ces littéraux sur les blancs.
 *
 * Toute ligne contenant une interpolation `${…}` est ignorée : la valeur finale
 * n'est pas connue statiquement, et la deviner produirait des faux positifs.
 * C'est une limite assumée — Tailwind reste le juge, pas nous.
 */
function collectSourceClasses(files) {
  const used = new Map(); // classe -> Set(chemin)
  const unverifiable = new Map(); // classe -> Set(chemin), pour information

  // 1. Valeur d'un attribut class / className.
  //    className="a b"  |  className={'a b'}  |  className={`a b`}
  const attrRe = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*[`'"]([\s\S]*?)[`'"]\s*\})/g;

  // 2. Littéraux passés à un utilitaire de composition de classes.
  const cnRe = /\b(?:cn|clsx|twMerge|classNames)\s*\(([\s\S]*?)\)/g;

  for (const file of files) {
    const src = readFileSync(file, 'utf8');

    const consume = (literal) => {
      if (literal === undefined || literal === null) return;
      // Ligne dynamique : valeur non déterminable statiquement.
      if (literal.includes('${')) return;

      for (const raw of literal.split(/\s+/)) {
        const tok = raw.trim();
        if (!tok) continue;
        // Un token de classe Tailwind commence par une lettre, ou par un tiret
        // suivi d'une lettre (utilitaires négatifs : `-top-3`, `-mx-1`).
        if (!/^-?[A-Za-z]/.test(tok)) continue;
        // Caractères qui n'appartiennent pas à l'alphabet des classes :
        // ce sont des bouts de JS autour du littéral, pas des classes.
        if (/[{};=<>]/.test(tok)) continue;
        // Les classes à valeur arbitraire ont une forme CSS imprévisible
        // (`bg-[#0B3B82]/10` devient `#0b3b82171a`). On les compte à part
        // plutôt que de les déclarer absentes à tort.
        if (tok.includes('[') || tok.includes(']')) {
          if (!unverifiable.has(tok)) unverifiable.set(tok, new Set());
          unverifiable.get(tok).add(file);
          continue;
        }
        if (tok.length > 80) continue;
        if (!used.has(tok)) used.set(tok, new Set());
        used.get(tok).add(file);
      }
    };

    let m;
    while ((m = attrRe.exec(src)) !== null) {
      consume(m[1] ?? m[2] ?? m[3]);
    }
    while ((m = cnRe.exec(src)) !== null) {
      // On ne garde que les littéraux à l'intérieur de l'appel.
      for (const lit of m[1].matchAll(/[`'"]([^`'"]*)[`'"]/g)) {
        consume(lit[1]);
      }
    }
  }
  return { used, unverifiable };
}

// --- Exécution -------------------------------------------------------------

let totalMissing = 0;
let totalChecked = 0;
const report = [];

for (const app of APPS) {
  const distDir = join(ROOT, 'apps', app, 'dist');
  if (!existsSync(distDir)) {
    report.push(`  ${app.padEnd(6)} build absent — ignoré (lancez \`npm run build\`)`);
    continue;
  }

  // 1. CSS produit
  const cssFiles = [];
  const walkCss = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkCss(full);
      else if (extname(full) === '.css') cssFiles.push(full);
    }
  };
  walkCss(distDir);

  if (cssFiles.length === 0) {
    report.push(`  ${app.padEnd(6)} AUCUN fichier CSS dans le build — ÉCHEC`);
    totalMissing += 1;
    continue;
  }
  const css = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
  const cssClasses = collectCssClasses(css);

  // 2. Classes utilisées, toutes sources confondues
  const srcFiles = [
    ...walk(join(ROOT, 'shared'), ['.tsx', '.ts']),
    ...walk(join(ROOT, 'apps', app, 'src'), ['.tsx', '.ts']),
  ];
  const { used, unverifiable } = collectSourceClasses(srcFiles);

  // 3. Comparaison
  const missing = [];
  for (const [cls, files] of used) {
    totalChecked += 1;
    // Correspondance exacte après déséchappement. Les variantes sont déjà
    // couvertes : dans le CSS, le nom de classe porte le préfixe tel quel
    // (`hover:flex` devient `.hover\:flex:hover`), donc le préfixe fait partie
    // du nom et se retrouve dans l'ensemble extrait.
    if (!cssClasses.has(cls)) missing.push({ cls, from: [...files] });
  }

  const shortKb = (css.length / 1024).toFixed(1);
  if (missing.length === 0) {
    report.push(
      `  ${app.padEnd(6)} ${String(used.size).padStart(4)} classes, toutes présentes dans ${cssFiles.length} CSS (${shortKb} Ko)`
    );
  } else {
    totalMissing += missing.length;
    report.push(
      `  ${app.padEnd(6)} ${missing.length} classe(s) UTILISÉES MAIS ABSENTES du CSS :`
    );
    for (const m of missing.slice(0, 25)) {
      report.push(`            ${m.cls}`);
      report.push(`              → ${relative(ROOT, m.from[0])}`);
    }
    if (missing.length > 25) {
      report.push(`            … et ${missing.length - 25} de plus`);
    }
  }

  if (unverifiable.size > 0) {
    report.push(`            (${unverifiable.size} classe(s) à valeur arbitraire non vérifiables)`);
  }
}

console.log('Vérification du CSS produit');
console.log('');
console.log(report.join('\n'));
console.log('');

if (totalMissing > 0) {
  console.log(`ÉCHEC : ${totalMissing} classe(s) référencée(s) mais absentes du CSS produit.`);
  console.log('');
  console.log('Cause la plus probable : les sources ne sont pas déclarées à Tailwind.');
  console.log('Chaque `apps/*/src/index.css` doit contenir, RELATIF À CE FICHIER :');
  console.log('    @source "../../../shared"');
  console.log("(trois niveaux : src -> app -> apps -> racine)");
  process.exit(1);
}

console.log(`OK : ${totalChecked} classes vérifiées, toutes présentes dans le CSS produit.`);
