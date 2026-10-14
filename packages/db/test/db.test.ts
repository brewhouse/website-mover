import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Against a real Postgres: TEST_DATABASE_URL, default the compose database "mover_test"
 * (docker compose up -d postgres; docker compose exec postgres createdb -U mover mover_test).
 * The suite is skipped when it can't connect.
 */
const url = process.env.TEST_DATABASE_URL ?? 'postgres://mover:mover@localhost:5432/mover_test';
const available = await new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 })
  .connect()
  .then(async (c) => {
    await c.query('drop schema if exists public cascade; drop schema if exists pgboss cascade; create schema public');
    await c.end();
    return true;
  })
  .catch(() => false);

process.env.DATABASE_URL = url;
process.env.CREDENTIALS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
const m = await import('../src/index.js');

describe.runIf(available)('db (Postgres)', () => {
  let userId: number;
  let targetId: number;

  beforeAll(async () => {
    expect(await m.migrate()).toEqual(['001_init.sql']);
    expect(await m.migrate()).toEqual([]); // once only
  });
  afterAll(async () => {
    await m.closeQueue();
    await m.closeDb();
  });

  it('logs people in by email (any case) and password, and keeps sessions until they end or expire', async () => {
    const user = await m.createUser('Reviewer@Example.org', 'Rae Viewer', 'correct horse battery');
    userId = user.id;
    expect(await m.checkLogin('reviewer@example.org', 'correct horse battery')).toEqual(user);
    expect(await m.checkLogin('reviewer@example.org', 'wrong password!!')).toBeNull();
    expect(await m.checkLogin('nobody@example.org', 'correct horse battery')).toBeNull();
    await expect(m.createUser('short@example.org', 'Short', 'too short')).rejects.toThrow(/12 characters/);

    const { token } = await m.createSession(user.id);
    expect(await m.sessionUser(token)).toEqual(user);
    expect(await m.sessionUser('forged-token')).toBeNull();
    await m.endSession(token);
    expect(await m.sessionUser(token)).toBeNull();

    const expired = await m.createSession(user.id);
    await m.db().query(`update sessions set expires_at = now() - interval '1 minute'`);
    expect(await m.sessionUser(expired.token)).toBeNull();
  });

  it('stores Application Passwords encrypted and gives them back only through targetCredentials', async () => {
    const target = await m.createTarget({ name: 'jha-dev', url: 'https://dev-jha.example.org/', wpUser: 'mover', appPassword: 'abcd efgh ijkl mnop', createdBy: userId });
    targetId = target.id;
    expect(target).not.toHaveProperty('appPassword');
    const stored = (await m.db().query('select app_password_enc from targets where id = $1', [target.id])).rows[0].app_password_enc as string;
    expect(stored).not.toContain('abcd');
    expect(await m.targetCredentials(target.id)).toEqual({ name: 'jha-dev', baseUrl: 'https://dev-jha.example.org', user: 'mover', appPassword: 'abcd efgh ijkl mnop' });
  });

  it('runs one stage at a time per job, and queues it for the worker', async () => {
    await m.createJob({ id: 'jha', sourceUrl: 'https://www.jaxha.org/', profile: 'bjm', targetId, timezone: 'America/New_York', ga4Id: null, styleGuide: null, userId });
    const run = await m.enqueueStages('jha', ['scan', 'extract', 'analyze', 'plan'], userId);
    expect(run).toMatchObject({ jobId: 'jha', stage: 'scan', status: 'queued', thenStages: ['extract', 'analyze', 'plan'], requestedBy: 'Rae Viewer' });
    await expect(m.enqueueStages('jha', ['plan'], userId)).rejects.toBeInstanceOf(m.JobBusyError);

    const [job] = await (await m.queue()).fetch<{ runId: number }>(m.STAGE_QUEUE);
    expect(job!.data).toEqual({ runId: run.id });

    await m.startRun(run.id);
    await m.appendEvent('jha', run.id, 'Scan: 3 pages');
    await m.finishRun(run.id, { summary: { pages: 3 } });
    expect(await m.getRun(run.id)).toMatchObject({ status: 'done', summary: { pages: 3 } });
    expect((await m.recentEvents('jha')).map((e) => e.message)).toEqual(['Scan: 3 pages']);

    // Finished: the job can run again.
    expect((await m.enqueueStages('jha', ['plan'], userId)).stage).toBe('plan');
    expect((await m.listJobs())[0]).toMatchObject({ id: 'jha', targetName: 'jha-dev', createdBy: 'Rae Viewer', lastRun: { stage: 'plan', status: 'queued' } });
  });
});

describe('secrets', () => {
  it('round-trips, and refuses a tampered value', () => {
    const enc = m.encryptSecret('app password');
    expect(m.decryptSecret(enc)).toBe('app password');
    expect(m.encryptSecret('app password')).not.toBe(enc); // fresh IV
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => m.decryptSecret(parts.join(':'))).toThrow();
  });

  it('hashes passwords with a salt and checks them', async () => {
    const hash = await m.hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await m.verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await m.verifyPassword('Correct horse battery', hash)).toBe(false);
    expect(await m.hashPassword('correct horse battery')).not.toBe(hash);
  });
});
