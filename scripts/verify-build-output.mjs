/**
 * Verifie que les classes Tailwind utilisees dans les sources produisent
 * reellement des regles CSS dans les artefacts construits.
 *
 * POURQUOI CE SCRIPT EXISTE
 * -------------------------
 * Un bug reel du projet : `shared/` n'etait pas declare comme source Tailwind.
 * Les pages de connexion, la barre de navigation du staff et le composant
 * `<Modal>` n'avaient donc AUCUNE regle applicable — rendu non style,
 * entierement casse. Et pourtant, a ce moment-la, tout le reste passait :
 *
 *   - le typecheck : les classes sont de simples chaines, il n'a rien a dire ;
 *   - ESLint : idem ;
 *   - un grep du bundle JS : les noms de classes y figuraient, puisque le
 *     marqueur `class="..."` est preserve tel quel par la minification.
 *
 * Autrement dit, les trois verifications usuelles donnent un « tout vert »
 * alors que l'interface est cassee. Le seul juge de paix est le fichier CSS
 * produit.
 *
 * DEUX PIEGES QUI ONT DONNE DES FAUX POSITIFS
 * -------------------------------------------
 * 1. Les deux-points des variantes sont echappes a la minification :
 *      `md:grid-cols-3`  ->  `.md\:grid-cols-3`
 *    Un `includes('md:grid-cols-3')` sur le CSS ne trouve donc RIEN.
 *
 * 2. Les couleurs rgba sont reecrites en hexadecimal court :
 *      `rgba(11,59,130,0.09)`  ->  `#0b3b8217`
 *    On ne peut donc pas chercher la forme source.
 *
 * D'ou l'approche retenue : extraire les selecteurs du CSS produit, les
 * desechapper, et comparer a l'ensemble des classes utilisees. On compare des
 * identifiants, jamais des chaines brutes.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const APPS = ['live', 'jury', 'admin'];

/** Desechappe un selecteur CSS : `\:` -> `:`, `\.` -> `.`, etc. */
function unescapeSelector(raw) {
  return raw.replace(/\\(.)/g, '$1');
}

/**
 * Un jeton extrait du CSS est-il reellement un nom de classe ?
 *
 * Contrainte decouverte a l'usage : il ne faut PAS rejeter les classes
 * contenant un point, car la moitie de l'echelle Tailwind est fractionnaire
 * (`gap-1.5`, `px-2.5`, `space-y-1.5`). Le minificateur echappe le point —
 * `.gap-1\.5` — et le desechappement redonne `gap-1.5`. Les rejeter
 * produisait 63 faux positifs, tous de cette famille.
 *
 * En revanche, un point issu d'une VALEUR CSS (`1.5rem`) ne doit pas passer.
 * On distingue les deux : apres un point, seuls des chiffres sont acceptes.
 */
function isPlausibleClass(cls) {
  // Une classe commence par une lettre… ou par un tiret suivi d'une lettre :
  // les utilitaires negatifs (`-translate-y-1/2`, `-top-3`) sont aussi
  // legitimes que les autres.
  if (!/^-?[a-zA-Z]/.test(cls)) return false;
  if (cls.includes('..')) return false;
  for (const segment of cls.replace(/^-/, '').split('.').slice(1)) {
    if (!/^\d+$/.test(segment)) return false;
  }
  return /^[A-Za-z0-9_:.%!#()&'"@*+,~>=/-]+$/.test(cls);
}

/** Extrait tous les selecteurs de classe d'une feuille CSS minifiee. */
export function collectCssClasses(css) {
  const found = new Set();
  const re = /\.((?:[^\s.,:>+~(){}\\]|\\.)+)/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const cls = unescapeSelector(m[1]);
    if (isPlausibleClass(cls)) found.add(cls);
  }
  return found;
}

/** Parcourt recursivement un dossier en filtrant sur l'extension. */
export function walk(dir, exts, out = []) {
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
 * Utilitaires Tailwind SANS tiret.
 *
 * Des qu'on elargit l'extraction aux tableaux et aux ternaires, on ramasse
 * aussi les operandes de comparaison : `status === 'FINISHED'`, `role ===
 * 'ADMIN'`, `tone === 'danger'`. Ces valeurs ressemblent a des tokens, et
 * aucune n'existe dans le CSS — 13 faux positifs a chaque execution.
 *
 * Plutot que de dresser une liste d'exclusions (fragile : elle se remplit a
 * chaque nouvel enum), on raisonne dans l'autre sens. Presque tous les
 * utilitaires Tailwind contiennent un tiret : `text-sm`, `bg-white`, `rounded-xl`,
 * `tabular-nums`, `sr-only`. On exige donc soit un tiret, soit l'appartenance a
 * cette liste courte et explicite d'utilitaires sans tiret.
 *
 * Ce qui n'est pas retenu (`FINISHED`, `ADMIN`, `danger`, `a`) ne peut pas etre
 * un utilitaire, donc son absence du CSS n'apprend rien.
 */
const HYPHENLESS_UTILITIES = new Set([
  'flex', 'grid', 'block', 'inline', 'hidden', 'contents',
  'static', 'fixed', 'absolute', 'relative', 'sticky',
  'visible', 'invisible', 'isolate', 'collapse',
  'truncate', 'italic', 'underline', 'overline',
  'uppercase', 'lowercase', 'capitalize',
  'antialiased', 'tabular', 'resize', 'container', 'table',
]);

/** Un jeton a-t-il la forme d'un utilitaire Tailwind ? */
function looksLikeUtility(tok) {
  if (tok.includes('-')) return true;
  return HYPHENLESS_UTILITIES.has(tok);
}

/**
 * Extrait les classes Tailwind des sources, sur TOUTES les formes d'ecriture.
 *
 * Deux regressions successives de cet extracteur Meritent d'etre racontees,
 * parce qu'elles ont la meme signature — l'echec SILENCIEUX :
 *
 *   v1 : ramassait tous les mots d'une ligne contenant « className= ». Elle
 *        remontait `className`, `h4`, `div` et des fragments de texte francais.
 *        710 faux positifs, qui auraient rendu le script inutilisable.
 *
 *   v2 : n'acceptait que `className="a b"`, et ignorait les TABLEAUX
 *        (`[...].join(' ')`) et les ternaires. L'audit
 *        (scripts/audit-css-coverage.mjs) a mesure la couverture : 52 formes
 *        sur 791 n'etaient pas verifiees du tout — la faille que ce script
 *        existe pour fermer, reapparue a l'interieur du script lui-meme.
 *
 * Regle retenue, volontairement simple et large : apres `className=` ou
 * `class=`, on avance jusqu'a l'accolade fermante correspondante et on ramasse
 * TOUS les litteraux qu'elle contient. Cela couvre :
 *   className="a b"                          className={'a b'}
 *   className={`a b`}                        className={['a', c && 'b'].join(' ')}
 *   className={[actif ? 'bg-x' : 'bg-y'].join(' ')}
 *
 * Les DEUX branches d'un ternaire sont retenues : elles doivent compiler
 * toutes les deux. Les identifiants (`base`, `iconClass`) sont ignores — leur
 * valeur n'est pas determinable ici.
 *
 * Toute interpolation `${…}` est ignoree : la valeur finale n'est pas connue
 * statiquement, et la deviner produirait des faux positifs. C'est une limite
 * assumee — Tailwind reste le juge, pas nous.
 */
export function collectSourceClasses(files) {
  const used = new Map();
  const unverifiable = new Map();
  let skipped = 0; // jetons manifestement hors classe (comparaisons d'enums)

  /** Ajoute les classes d'un litteral de chaine a l'inventaire. */
  const consume = (literal) => {
    if (literal === undefined || literal === null) return;
    if (literal.includes('${')) return; // valeur dynamique
    for (const raw of literal.split(/\s+/)) {
      const tok = raw.trim();
      if (!tok) continue;
      if (!/^-?[A-Za-z]/.test(tok)) continue;
      if (/[{};=<>]/.test(tok)) continue;
      if (!looksLikeUtility(tok)) {
        skipped += 1;
        continue;
      }
      if (tok.includes('[') || tok.includes(']')) {
        if (!unverifiable.has(tok)) unverifiable.set(tok, new Set());
        unverifiable.get(tok).add(1);
        continue;
      }
      if (tok.length > 80) continue;
      if (!used.has(tok)) used.set(tok, new Set());
      used.get(tok).add(1);
    }
  };

  /** Ramasse tous les litteraux d'une portion de source. */
  const consumeLiterals = (text) => {
    for (const m of text.matchAll(/[`'"]([^`'"\n]*)[`'"]/g)) consume(m[1]);
  };

  for (const file of files) {
    const src = readFileSync(file, 'utf8');

    // 1. Forme simple : className="a b"  |  className={'a b'}  |  className={`a b`}
    const simpleRe =
      /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*[`'"]([^`'"\n]*)[`'"]\s*\})/g;
    let m;
    while ((m = simpleRe.exec(src)) !== null) {
      consume(m[1] ?? m[2] ?? m[3]);
    }

    // 2. Forme expression : className={ … } — on parcourt les accolades.
    const exprRe = /\bclass(?:Name)?\s*=\s*\{/g;
    while ((m = exprRe.exec(src)) !== null) {
      let depth = 0;
      let end = m.index + m[0].length;
      for (let i = end; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          if (depth === 0) {
            end = i;
            break;
          }
          depth -= 1;
        }
        if (i - m.index > 800) break; // garde-fou
      }
      consumeLiterals(src.slice(m.index + m[0].length, end));
    }

    // 3. Utilitaires de composition : cn(…) / clsx(…)
    const cnRe = /\b(?:cn|clsx|twMerge|classNames)\s*\(([\s\S]*?)\)/g;
    while ((m = cnRe.exec(src)) !== null) {
      consumeLiterals(m[1]);
    }
  }
  return { used, unverifiable, skipped };
}

// --- Execution -------------------------------------------------------------

/**
 * Le bloc de verification ne doit s'executer que lorsque ce fichier est lance
 * directement.
 *
 * L'audit de couverture (scripts/audit-css-coverage.mjs) importe l'extracteur
 * pour mesurer la VRAIE implementation. Sans cette garde, l'import declenchait
 * aussi la verification complete, et l'audit affichait deux rapports successifs
 * sans que ce soit demande.
 */
const lanceDirectement =
  process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);

if (lanceDirectement) {
  // --- Execution -------------------------------------------------------------
  
  let totalMissing = 0;
  let totalChecked = 0;
  const report = [];
  
  for (const app of APPS) {
    const distDir = join(ROOT, 'apps', app, 'dist');
    if (!existsSync(distDir)) {
      report.push(`  ${app.padEnd(6)} build absent — ignore (lancez \`npm run build\`)`);
      continue;
    }
  
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
      report.push(`  ${app.padEnd(6)} AUCUN fichier CSS dans le build — ECHEC`);
      totalMissing += 1;
      continue;
    }
    const css = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
    const cssClasses = collectCssClasses(css);
  
    const srcFiles = [
      ...walk(join(ROOT, 'shared'), ['.tsx', '.ts']),
      ...walk(join(ROOT, 'apps', app, 'src'), ['.tsx', '.ts']),
    ];
    const { used, unverifiable, skipped } = collectSourceClasses(srcFiles);
  
    const missing = [];
    for (const cls of used.keys()) {
      totalChecked += 1;
      if (!cssClasses.has(cls)) missing.push(cls);
    }
  
    const shortKb = (css.length / 1024).toFixed(1);
    const notes = [];
    if (unverifiable.size > 0) {
      notes.push(`${unverifiable.size} classe(s) a valeur arbitraire non verifiables`);
    }
    if (skipped > 0) {
      notes.push(`${skipped} jeton(s) hors classe ignores (comparaisons d'enums)`);
    }
    const noteStr = notes.length ? `\n            (${notes.join(', ')})` : '';
  
    if (missing.length === 0) {
      report.push(
        `  ${app.padEnd(6)} ${String(used.size).padStart(4)} classes, toutes presentes dans ${cssFiles.length} CSS (${shortKb} Ko)${noteStr}`
      );
    } else {
      totalMissing += missing.length;
      report.push(
        `  ${app.padEnd(6)} ${missing.length} classe(s) UTILISEES MAIS ABSENTES du CSS :`
      );
      for (const cls of missing.slice(0, 25)) {
        report.push(`            ${cls}`);
      }
      if (missing.length > 25) {
        report.push(`            … et ${missing.length - 25} de plus`);
      }
      if (noteStr) report.push(noteStr.trim().padEnd(0) || noteStr);
    }
  }
  
  console.log('Verification du CSS produit');
  console.log('');
  console.log(report.join('\n'));
  console.log('');
  
  if (totalMissing > 0) {
    console.log(`ECHEC : ${totalMissing} classe(s) referencee(s) mais absentes du CSS produit.`);
    console.log('');
    console.log('Cause la plus probable : les sources ne sont pas declarees a Tailwind.');
    console.log('Chaque `apps/*/src/index.css` doit contenir, RELATIF A CE FICHIER :');
    console.log('    @source "../../../shared"');
    console.log('(trois niveaux : src -> app -> apps -> racine)');
    process.exit(1);
  }
  
  console.log(`OK : ${totalChecked} classes verifiees, toutes presentes dans le CSS produit.`);
}
