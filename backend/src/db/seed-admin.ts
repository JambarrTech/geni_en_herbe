import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, createPool } from './index.ts';
import { users } from './schema.ts';
import { hashPassword } from '../lib/password.ts';

const email = (process.env.SEED_ADMIN_EMAIL ?? 'jambarrtech@gmail.com').trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD;

if (!password || password.length < 6) {
  throw new Error('SEED_ADMIN_PASSWORD est obligatoire et doit contenir au moins 6 caractères.');
}

const passwordHash = await hashPassword(password);
const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

if (existing) {
  await db
    .update(users)
    .set({ name: 'Jambarr Tech', role: 'ADMIN', active: true, passwordHash, updatedAt: new Date() })
    .where(eq(users.id, existing.id));
  console.log(`Compte administrateur mis à jour : ${email}`);
} else {
  await db.insert(users).values({
    name: 'Jambarr Tech',
    email,
    role: 'ADMIN',
    passwordHash,
    active: true,
  });
  console.log(`Compte administrateur créé : ${email}`);
}

await createPool().end();