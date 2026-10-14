import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { jobPath, writeJsonl } from '@wm/core';
import { approvePlan, buildPlan, savePlan } from '@wm/planner';
import type { WpClient } from '@wm/wp-client';
import { executePlan } from '../src/index.js';

it('refuses to execute content that changed after the plan was approved', async () => {
  process.env.WM_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'wm-'));
  const extract = jobPath('test', 'extract', 'pages.jsonl');
  await writeJsonl(extract, [{ sourceKey: 'example.org/a', contentHtml: '<p>reviewed</p>' }]);
  const plan = buildPlan({
    jobId: 'test',
    version: 1,
    source: { origin: 'https://example.org', profile: 'generic' },
    inputs: { extractSha256: createHash('sha256').update(await import('node:fs').then((fs) => fs.readFileSync(extract))).digest('hex') },
    target: { name: 'local', url: 'http://localhost:8088', wordpress: '7.0.4', theme: 't', permalinks: '/%postname%/', disabledBlocks: [], reservedSlugs: [], redirection: false },
    pages: [],
    snapshotPages: [],
    files: [],
    existing: [],
  });
  await savePlan(plan);
  await approvePlan('test', 'Reviewer');

  // Re-extracted after approval: different content than was reviewed.
  await writeFile(extract, JSON.stringify({ sourceKey: 'example.org/a', contentHtml: '<p>changed</p>' }) + '\n');
  const untouchable = new Proxy({}, { get: () => { throw new Error('the target must not be touched'); } }) as WpClient;

  await expect(executePlan({ jobId: 'test', client: untouchable, log: () => {} })).rejects.toThrow(/extracted content changed/);
});
