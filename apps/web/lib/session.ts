import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { migrate, sessionUser, type User } from '@wm/db';

export const SESSION_COOKIE = 'wm_session';

let ready: Promise<unknown> | undefined;
/** The schema is migrated once per server process, before the first query. */
export function dbReady(): Promise<unknown> {
  ready ??= migrate().catch((err) => {
    ready = undefined;
    throw err;
  });
  return ready;
}

export async function currentUser(): Promise<User | null> {
  await dbReady();
  return sessionUser((await cookies()).get(SESSION_COOKIE)?.value);
}

/** The logged-in user; anyone else goes to the login page. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}
