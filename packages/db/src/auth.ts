import { createHash, randomBytes } from 'node:crypto';
import { db } from './pool.js';
import { hashPassword, verifyPassword } from './passwords.js';

export interface User {
  id: number;
  email: string;
  name: string;
}

/** Sessions last this long; then the person logs in again. */
export const SESSION_HOURS = 12;

export async function createUser(email: string, name: string, password: string): Promise<User> {
  const { rows } = await db().query<User>(
    'insert into users (email, name, password_hash) values (lower($1), $2, $3) returning id, email, name',
    [email.trim(), name.trim(), await hashPassword(password)],
  );
  return rows[0]!;
}

export async function setPassword(email: string, password: string): Promise<boolean> {
  const { rowCount } = await db().query('update users set password_hash = $2 where email = lower($1)', [email.trim(), await hashPassword(password)]);
  if (rowCount) await db().query('delete from sessions where user_id = (select id from users where email = lower($1))', [email.trim()]);
  return !!rowCount;
}

export async function listUsers(): Promise<User[]> {
  return (await db().query<User>('select id, email, name from users order by name')).rows;
}

// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** The user for an email and password, or null. */
export async function checkLogin(email: string, password: string): Promise<User | null> {
  const { rows } = await db().query<User & { password_hash: string }>('select id, email, name, password_hash from users where email = lower($1)', [email.trim()]);
  const row = rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return row && ok ? { id: row.id, email: row.email, name: row.name } : null;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Starts a session; the returned token goes in the cookie. */
export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db().query('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [tokenHash(token), userId, expiresAt]);
  await db().query('delete from sessions where expires_at < now()');
  return { token, expiresAt };
}

export async function sessionUser(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const { rows } = await db().query<User>(
    'select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()',
    [tokenHash(token)],
  );
  return rows[0] ?? null;
}

export async function endSession(token: string): Promise<void> {
  await db().query('delete from sessions where token_hash = $1', [tokenHash(token)]);
}
