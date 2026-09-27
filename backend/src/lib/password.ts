import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

// scrypt est expose par Node sous sa forme synchrone (`scryptSync`) et sous
// forme asynchrone. Cette derniere fait le calcul dans le pool de threads de
// libuv : l'event loop n'est pas bloque.
const scryptAsync = promisify(scrypt);

/**
 * Coût de scrypt, sous forme de paramètres N/r/p.
 *
 * Ces valeurs sont VOLONTAIRESMENT conservées identiques à celles des hachages
 * déjà enregistrés en base. Les changer forcerait la réinscription de tous les
 * mots de passe existants : les anciens hachages ne seraient plus
 * vérifiables, et personne ne pourrait plus se connecter.
 *
 * Le durcissement se joue ici en changeant de primitive — plus d'attente
 * synchrone qui fige le serveur — pas en modifiant les paramètres.
 */
const KEY_LENGTH = 64;

/**
 * Hache un mot de passe.
 *
 * @param sel hex-encoded, tiré au hasard par défaut.
 * @returns « sel:empreinte », les deux en hexadécimal.
 */
export async function hashPassword(
  password: string,
  sel: string = randomBytes(16).toString('hex')
): Promise<string> {
  const derived = (await scryptAsync(password, sel, KEY_LENGTH)) as Buffer;
  return `${sel}:${derived.toString('hex')}`;
}

/**
 * Vérifie un mot de passe face à un hachage enregistré.
 *
 * `timingSafeEqual` est conservé : comparer deux empreintes avec `===`
 * s'arrête au premier octet différent et laisse fuiter, par la durée de
 * l'opération, le nombre d'octets corrects. Le canal temporel est réel, même
 * sur un hachage.
 *
 * @returns false si le format est invalide, si l'empreinte est malformée, ou
 *          si elle ne correspond pas. L'appelant ne peut pas distinguer ces
 *          cas — c'est délibéré.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined
): Promise<boolean> {
  if (!stored || !stored.includes(':')) return false;
  const [sel, hashHex] = stored.split(':');
  if (!sel || !hashHex) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  // Une empreinte de longueur inattendue ne peut pas correspondre. On évite
  // donc d'appeler timingSafeEqual, qui lève si les deux buffers n'ont pas la
  // même taille.
  if (expected.length !== KEY_LENGTH) return false;

  const actual = (await scryptAsync(password, sel, KEY_LENGTH)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
