/**
 * Scan + extract jaxha.org into data/jobs/jha (M1 smoke run).
 *
 *   pnpm exec tsx packages/extractor/scripts/run-jha.ts [--skip-scan]
 *
 * Page responses come from the M0 inventory's cache (snapshots/jha/http), so the
 * network is only used for file downloads; those are kept in the job's
 * snapshot/files/ and not downloaded again on re-runs.
 */
import path from 'node:path';
import { scanSite } from '@wm/crawler';
import { extractJob } from '../src/index.js';

const root = path.resolve(import.meta.dirname, '../../..');
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

if (!process.argv.includes('--skip-scan')) {
  const scan = await scanSite({
    jobId: 'jha',
    origin: 'https://www.jaxha.org',
    profile: 'bjm',
    cacheDir: path.join(root, 'snapshots/jha/http'),
    log,
  });
  console.log(JSON.stringify(scan, null, 2));
}
console.log(JSON.stringify(await extractJob({ jobId: 'jha', log }), null, 2));
