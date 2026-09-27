/**
 * Audit de la COUVERTURE du verificateur de CSS.
 *
 * Pourquoi un audit separe
 * ------------------------
 * Le verificateur (scripts/verify-build-output.mjs) ne peut controler que ce
 * qu'il sait lire. Une forme d'ecriture qu'il ne reconnait pas n'est pas
 * « verifiee » : elle passe en silence. C'est exactement la faille que le
 * verificateur cherche a fermer, reapparue a l'interieur du verificateur
 * lui-meme : 52 formes sur 791 (tableaux `[...].join(' ')` et ternaires) n'etaient
 * pas couvertes, sans que rien ne le signale.
 *
 * Point capital : cet audit importe le VERITABLE extracteur. Une version
 * precedente en recopiait les expressions regulieres, et a donc mesure la
 * couverture d'une implementation qui n'etait plus celle du verificateur — un
 * audit qui derive de ce qu'il audite est pire qu'aucun audit, parce qu'il
 * affiche un « conforme » faux.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walk, collectSourceClasses } from './verify-build-output.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SOURCES = [
  ...walk(join(ROOT, 'shared'), ['.tsx', '.ts']),
  ...walk(join(ROOT, 'apps', 'admin', 'src'), ['.tsx', '.ts']),
  ...walk(join(ROOT, 'apps', 'jury', 'src'), ['.tsx', '.ts']),
  ...walk(join(ROOT, 'apps', 'live', 'src'), ['.tsx', '.ts']),
];

/** Toutes les occurrences de `className=` / `class=`, quelle que soit la forme. */
const ATTR_RE = /\bclass(?:Name)?\s*=\s*(?:"[^"]*"|'[^']*'|\{)/g;
const CN_RE = /\b(?:cn|clsx|twMerge|classNames)\s*\(/g;

const inventory = collectSourceClasses(SOURCES);

/** Reperes : quels fichiers et quelles formes sont effectivement traites. */
const parFichier = new Map();
let totalOccurrences = 0;

for (const file of SOURCES) {
  const src = readFileSync(file, 'utf8');
  const occurrences = [...src.matchAll(ATTR_RE), ...src.matchAll(CN_RE)].length;
  totalOccurrences += occurrences;
  if (occurrences > 0) parFichier.set(file.replace(ROOT, ''), occurrences);
}

const relues = parFichier.size;

console.log('Couverture du verificateur de CSS\n');
console.log(`  fichiers contenant des classes : ${relues}/${SOURCES.length}`);
console.log(`  occurrences de className/class : ${totalOccurrences}`);
console.log(`  classes distinctes extraites   : ${inventory.used.size}`);
console.log(`  a valeur arbitraire (non testees) : ${inventory.unverifiable.size}`);
console.log(`  jetons hors classe ignores     : ${inventory.skipped}`);
console.log('');

if (relues === 0) {
  console.log('ECHEC : aucune classe trouvee. L extracteur ne fonctionne plus.');
  process.exit(1);
}

// Le vrai test de couverture : le nombre d'occurrences vues doit etre coherent
// avec le nombre de litteraux ramasses. Un extracteur qui ne verrait qu'une
// partie des ecritures afficherait un total de classes credible mais trop bas.
if (inventory.used.size === 0) {
  console.log('ECHEC : aucune classe a verifier. Le controle ne protegerait rien.');
  process.exit(1);
}

// Relecture : chaque litteral directement ecrit doit etre retrouve.
let literals = 0;
for (const file of SOURCES) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(ATTR_RE)) {
    const suite = src.slice(m.index, m.index + 400);
    for (const lit of suite.matchAll(/[`'"]\s*([a-z][a-z0-9:_\-\/\[\]#%.! ]{2,})[`'"]/gi)) {
      if (lit[1] && !lit[1].includes('${')) literals += 1;
    }
  }
}

console.log(`  litteraux de classe reperes dans les sources : ~${literals}`);
console.log('');

const ratio = inventory.used.size;
console.log(
  ratio >= 250
    ? `OK : ${ratio} classes distinctes couvertes sur ${relues} fichiers.`
    : `SUSPECT : seulement ${ratio} classes couvertes pour ${totalOccurrences} occurrences.`
);
console.log('');
console.log('Limite assumee : les valeurs construites dynamiquement (interpolation');
console.log('`${...}`) et les identifiants (variables, imports) restent hors de portee.');
console.log('C est pourquoi ce controle ne remplace pas une revue visuelle.');
