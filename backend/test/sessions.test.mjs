/**
 * Test des invariants du stockage de sessions qui ne demandent pas de base.
 *
 * Ces tests protègent trois propriétés, chacune susceptible d'être cassée par
 * un refonte future sans qu'aucun test à bout de chaîne ne le remarque :
 *
 *  1. le jeton n'est jamais déterministe ni réutilisable ;
 *  2. l'empreinte stockée est bien un hachage du jeton, et le hachage est
 *     stable — sans cela, « la base ne contient pas le jeton » ne tiendrait
 *     que par accident ;
 *  3. le cache ne peut pas prolonger une session au-dela de sa vraie expiration.
 *
 * Le troisième est le plus subtil : il découle d'une relation entre deux
 * constantes de configuration, et non de la logique d'une fonction. Une
 * modification de l'une des deux — pour « optimiser » la base, par exemple —
 * passerait tous les tests fonctionnels tout en rouvrant une fenêtre
 * d'acceptation après expiration.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CONFIG } from '../src/config.ts';
import { hashToken, generateToken } from '../src/lib/sessions.ts';

describe('sessions — generation du jeton', () => {
  test('le jeton porte le prefixe de configuration', () => {
    // Le prefixe permet de reconnaitre un jeton AEERKS dans un journal ou un
    // proxy, et de le refuser tot s'il apparait ailleurs.
    assert.ok(generateToken().startsWith(CONFIG.TOKEN_PREFIX));
  });

  test('deux jetons consecutifs sont distincts', () => {
    // Un jeton reproductible serait une session partageable : quiconque
    // obtient le jeton d'un utilisateur pourrait s'en servir a l'identique.
    const seen = new Set();
    for (let i = 0; i < 2_000; i += 1) seen.add(generateToken());
    assert.equal(seen.size, 2_000, 'collision sur 2000 jetons');
  });

  test('le jeton est suffisamment long pour resister a une recherche exhaustive', () => {
    // 32 octets aleatoires = 256 bits. En dessous de ~128 bits, une
    // recherche exhaustive devient envisageable sur un cluster adapte ; au
    // dessus, elle n'est pas un scenario de menace. La longueur est donc
    // une propriete de securite, pas une question de gout.
    const token = generateToken();
    const entropy = Buffer.from(token.slice(CONFIG.TOKEN_PREFIX.length), 'base64url').length;
    assert.ok(entropy >= 32, ` seulement ${entropy} octets d'entropie`);
  });

  test('le jeton ne contient pas de caractere ambigu', () => {
    // Base64url, pas base64 : un `+` ou un `/` dans un en-tete HTTP demande un
    // encodage, et `=` se retrouve frontalement avec le separateur `key=value`
    // de certains parseurs de cookies et de journaux.
    assert.match(generateToken(), /^[A-Za-z0-9_-]+$/);
  });
});

describe('sessions — empreinte', () => {
  test('l\'empreinte est le sha256 du jeton', () => {
    const token = generateToken();
    const expected = createHash('sha256').update(token, 'utf8').digest('hex');
    // La base ne doit contenir QUE cela : ni le jeton, ni un variant
    // reversible. Ce test verrouille la definition meme de la colonne.
    assert.equal(hashToken(token), expected);
  });

  test('l\'empreinte ne contient pas le jeton', () => {
    // Defence explicite contre une refonte qui reviendrait a stocker le jeton
    // « pour eviter un calcul » : sha256 n'est pas reversible, donc cette
    // propriete doit tenir pour tout jeton.
    const token = generateToken();
    assert.ok(!hashToken(token).includes(token.slice(0, 16)));
  });

  test('l\'empreinte est stable et injective sur des jeton distincts', () => {
    const a = generateToken();
    const b = generateToken();
    // Le hachage doit etre DETERMINISTE : la verification d'un jeton relit la
    // ligne par empreinte, donc deux appels doivent produire la meme valeur.
    assert.equal(hashToken(a), hashToken(a));
    assert.notEqual(hashToken(a), hashToken(b));
  });

  test('l\'empreinte a une longueur fixe', () => {
    // Une longueur variable romprait l'index unique sur `token_hash`, et le
    // format hexadecimal garantit la compatibilite de la colonne.
    assert.equal(hashToken('a').length, 64);
    assert.equal(hashToken(generateToken().repeat(10)).length, 64);
  });
});

describe('sessions — invariant de configuration', () => {
  test('la duree de cache reste tres inferieure a la duree de vie', () => {
    // Le cache vit `SESSION_CACHE_TTL_MS` ; la session vit `SESSION_TTL_MS`.
    // Si la premiere approchait la seconde, une session dont il reste peu de
    // temps pourrait etre servie depuis le cache apres son expiration. Le
    // code verifie les deux bornes, mais l'ecart doit rester enormous : c'est
    // la marge qui absorbe un changement de configuration hasty.
    assert.ok(
      CONFIG.SESSION_CACHE_TTL_MS < CONFIG.SESSION_TTL_MS / 100,
      `cache=${CONFIG.SESSION_CACHE_TTL_MS}ms session=${CONFIG.SESSION_TTL_MS}ms : marge insuffisante`
    );
  });

  test('le cache reste court au regard d\'une journee', () => {
    // Un cache long transformerait le deplacement de session en base en
    // fiction : sur une instance, la revocation ne se verrait qu'a l'expiration
    // du cache. Trente secondes borne le retard maximal de prise en compte.
    assert.ok(
      CONFIG.SESSION_CACHE_TTL_MS <= 60_000,
      `cache=${CONFIG.SESSION_CACHE_TTL_MS}ms : trop long pour un cache de revocation`
    );
  });

  test('la duree de vie de session reste bornee', () => {
    // 12 h correspond a une journee de competition. Au-dela, la fenetre
    // d'exposition d'un jeton vole devient genante sans contrepartie : le
    // jury se reconnecte chaque jour.
    assert.ok(CONFIG.SESSION_TTL_MS <= 24 * 60 * 60 * 1000);
    assert.ok(CONFIG.SESSION_TTL_MS >= 60 * 60 * 1000, 'une session de moins d\'une heure est inconfortable');
  });

  test('la purge s\'execute assez souvent pour suivre l\'expiration', () => {
    // Si la purge est plus rare que la duree de vie, les sessions echues
    // s'accumulent longtemps apres leur fin. Elle n'est pas critique pour la
    // securite (la verification teste l'expiration), mais elle l'est pour
    // l'espace occupe.
    assert.ok(
      CONFIG.SESSION_SWEEP_INTERVAL_MS <= CONFIG.SESSION_TTL_MS,
      'la purge ne peut pas etre plus rare que la duree de vie des sessions'
    );
  });
});