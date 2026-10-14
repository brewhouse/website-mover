import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from './pool.js';

const dir = path.join(import.meta.dirname, '..', 'migrations');

/** Applies migrations/*.sql in name order, each once, under an advisory lock (web and worker both call it). */
export async function migrate(): Promise<string[]> {
  const client = await db().connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', ['website-mover:migrate']);
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      await client.query('begin');
      try {
        await client.query(await readFile(path.join(dir, name), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      }
      applied.push(name);
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock(hashtext($1))', ['website-mover:migrate']).catch(() => {});
    client.release();
  }
}
