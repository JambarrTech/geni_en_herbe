import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

export function hashPassword(password: string, salt: string = randomBytes(16).toString('hex')): string {
  const hash = scryptSync(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}