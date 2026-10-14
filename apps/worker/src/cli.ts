/**
 * Website Mover CLI (M1). Each command is one pipeline stage; see docs/m1/design.md.
 *
 *   pnpm --filter @wm/worker wm scan    --job jha --origin https://www.jaxha.org --profile bjm [--cache snapshots/jha/http]
 *   pnpm --filter @wm/worker wm extract --job jha
 *   pnpm --filter @wm/worker wm plan    --job jha [--target local]
 *   pnpm --filter @wm/worker wm approve --job jha --by "Name"
 *   pnpm --filter @wm/worker wm execute --job jha [--target local]
 *   pnpm --filter @wm/worker wm report  --job jha [--target local]
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { jobPath, readJson, readJsonl, type ExtractedPage, type JobInfo, type SnapshotFile, type SnapshotPage } from '@wm/core';
import { scanSite } from '@wm/crawler';
import { extractJob } from '@wm/extractor';
import { approvePlan, buildPlan, latestPlanVersion, loadPlan, savePlan } from '@wm/planner';
import { buildReport, connectTarget, executePlan, probeTarget, type TargetName } from '@wm/executor';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    job: { type: 'string' },
    origin: { type: 'string' },
    profile: { type: 'string', default: 'generic' },
    cache: { type: 'string' },
    target: { type: 'string', default: 'local' },
    by: { type: 'string' },
  },
});
const [command] = positionals;
const jobId = values.job ?? fail('--job is required');
const target = values.target as TargetName;
// pnpm runs scripts in the package directory; resolve user paths against where the command was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();

switch (command) {
  case 'scan': {
    const origin = values.origin ?? fail('--origin is required');
    const summary = await scanSite({
      jobId,
      origin,
      profile: values.profile!,
      cacheDir: values.cache ? path.resolve(cwd, values.cache) : undefined,
      log: console.log,
    });
    console.log(summary);
    break;
  }
  case 'extract':
    console.log(await extractJob({ jobId, log: console.log }));
    break;
  case 'plan': {
    const job = await readJson<JobInfo>(jobPath(jobId, 'job.json'));
    const client = connectTarget(target);
    const { info, existing } = await probeTarget(client, target);
    const plan = buildPlan({
      jobId,
      version: (await latestPlanVersion(jobId)) + 1,
      source: { origin: job.origin, profile: job.profile },
      inputs: { extractSha256: createHash('sha256').update(await readFile(jobPath(jobId, 'extract', 'pages.jsonl'))).digest('hex') },
      target: info,
      pages: await readJsonl<ExtractedPage>(jobPath(jobId, 'extract', 'pages.jsonl')),
      snapshotPages: await readJsonl<SnapshotPage>(jobPath(jobId, 'snapshot', 'pages.jsonl')),
      files: await readJsonl<SnapshotFile>(jobPath(jobId, 'snapshot', 'files.jsonl')),
      existing,
    });
    const sha = await savePlan(plan);
    console.log(`Plan v${plan.version} (${sha.slice(0, 12)}):`, plan.expected);
    for (const w of plan.warnings) console.log(`  ! ${w}`);
    console.log(`Review: ${jobPath(jobId, 'plan', `plan.v${plan.version}.md`)}`);
    break;
  }
  case 'approve': {
    const by = values.by ?? fail('--by "<your name>" is required');
    const { plan } = await loadPlan(jobId);
    const approval = await approvePlan(jobId, by);
    console.log(`Approved plan v${approval.planVersion} (${approval.planSha256.slice(0, 12)}) by ${by}:`, plan.expected);
    break;
  }
  case 'execute': {
    const state = await executePlan({ jobId, client: connectTarget(target) });
    console.log(`Done: ${Object.keys(state.entities).length} objects, ${state.failures.length} failures, ${state.redirects.length} redirects`);
    break;
  }
  case 'report': {
    const report = await buildReport({ jobId, client: connectTarget(target) });
    console.table(report.counts);
    console.log(`Report: ${jobPath(jobId, 'report', 'report.md')}`);
    break;
  }
  default:
    fail(`Unknown command "${command ?? ''}". Commands: scan, extract, plan, approve, execute, report`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
