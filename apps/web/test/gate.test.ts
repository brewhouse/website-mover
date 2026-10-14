import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvePlan, buildPlan, saveDecisions, savePlan } from '@wm/planner';
import { planHeadline, planState } from '../lib/job-files';
import { isHttps, safeNext } from '../lib/safe-next';

describe('after login', () => {
  it.each([
    ['/jobs/jha/review', '/jobs/jha/review'],
    ['/', '/'],
    ['', '/'],
    ['https://evil.example/', '/'],
    ['//evil.example/', '/'],
    ['/\\evil.example', '/'], // browsers read "/\" as "//"
    ['/%5Cevil.example', '/%5Cevil.example'], // encoded: stays a path on this site
    ['/jobs\n/x', '/'],
  ])('%j → %j', (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });

  it('marks the session cookie Secure only when the request came over https', () => {
    const h = (entries: Record<string, string>) => ({ get: (n: string) => entries[n] ?? null });
    expect(isHttps(h({ 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isHttps(h({ 'x-forwarded-proto': 'http', origin: 'https://x' }))).toBe(false);
    expect(isHttps(h({ origin: 'https://mover.example' }))).toBe(true);
    expect(isHttps(h({ origin: 'http://mover.internal:3100' }))).toBe(false);
  });
});

describe('approval state the job and review pages gate on', () => {
  it('counts a plan as approved only while its exact bytes are, and flags decisions it lacks', async () => {
    process.env.WM_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'wm-web-'));
    const plan = buildPlan({
      jobId: 'gate',
      version: 1,
      source: { origin: 'https://example.org', profile: 'generic' },
      inputs: { extractSha256: 'x' },
      target: { name: 'local', url: 'http://localhost:8088', wordpress: '7.0.4', theme: 't', permalinks: '/%postname%/', disabledBlocks: [], reservedSlugs: [], redirection: true, timezone: 'UTC' },
      pages: [],
      snapshotPages: [],
      files: [],
      existing: [],
    });
    const sha = await savePlan(plan);
    expect(await planHeadline('gate')).toEqual({ version: 1, approved: false });
    expect((await planState('gate'))!.approved).toBe(false);

    await approvePlan('gate', 'Reviewer', { version: 1, sha256: sha });
    expect(await planHeadline('gate')).toEqual({ version: 1, approved: true });
    expect(await planState('gate')).toMatchObject({ approved: true, pendingDecisions: false });

    // Changed on disk after approval: no longer approved.
    const file = path.join(process.env.WM_DATA_DIR, 'jobs/gate/plan/plan.v1.json');
    await writeFile(file, JSON.stringify({ ...plan, warnings: ['edited'] }, null, 2));
    expect(await planHeadline('gate')).toEqual({ version: 1, approved: false });
    expect((await planState('gate'))!.approved).toBe(false);

    // A newer version needs its own approval; saved decisions it doesn't have are pending.
    await savePlan({ ...plan, version: 2 });
    await saveDecisions('gate', { exclude: ['example.org/old'], include: [], type: {}, slug: {}, keep: [] });
    expect(await planHeadline('gate')).toEqual({ version: 2, approved: false });
    expect(await planState('gate')).toMatchObject({ approved: false, pendingDecisions: true });
  });
});
