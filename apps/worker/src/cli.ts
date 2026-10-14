/**
 * Website Mover CLI (M1). Each command is one pipeline stage; see docs/m1/design.md.
 *
 *   pnpm --filter @wm/worker wm scan    --job jha --origin https://www.jaxha.org --profile bjm [--cache snapshots/jha/http]
 *   pnpm --filter @wm/worker wm extract --job jha
 *   pnpm --filter @wm/worker wm analyze --job jha
 *   pnpm --filter @wm/worker wm plan    --job jha [--target local] [--timezone America/New_York]
 *   pnpm --filter @wm/worker wm approve --job jha --by "Name"
 *   pnpm --filter @wm/worker wm execute --job jha [--target local]
 *   pnpm --filter @wm/worker wm report  --job jha [--target local]
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  jobPath,
  readJson,
  readJsonl,
  type ExtractedPage,
  type FormAnalysis,
  type JobInfo,
  type MeetingAnalysis,
  type RecordAnalysis,
  type SiteAnalysis,
  type SnapshotFile,
  type SnapshotPage,
} from '@wm/core';
import { scanSite } from '@wm/crawler';
import { extractJob } from '@wm/extractor';
import { analyzeForms, analyzeMeetings, analyzeRecords, analyzeSite } from '@wm/analyzer';
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
    timezone: { type: 'string' },
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
  case 'analyze': {
    const meetings = await analyzeMeetings(jobId, console.log);
    const forms = await analyzeForms(jobId, console.log);
    const records = await analyzeRecords(jobId, console.log);
    const site = await analyzeSite(jobId, console.log);
    console.log({
      meetings: meetings.meetings.length,
      meetingIndexPages: meetings.indexPages.length,
      unresolvedMeetings: meetings.unresolved.length,
      forms: forms.forms.length,
      people: records.people.length,
      communities: records.communities.length,
      tables: records.tables.length,
      documents: records.documents.length,
      menus: Object.fromEntries(Object.entries(site.menus).map(([k, v]) => [k, v.length])),
      homeSlides: site.home.slides.length,
    });
    break;
  }
  case 'plan': {
    const job = await readJson<JobInfo>(jobPath(jobId, 'job.json'));
    // Analysis is optional (M1 plans don't have it); when present, its hashes go into the plan.
    const analysisFiles = { meetings: 'meetings.json', forms: 'forms.json', records: 'records.json', site: 'site.json' } as const;
    const analysis: { meetings?: MeetingAnalysis; forms?: FormAnalysis; records?: RecordAnalysis; site?: SiteAnalysis } = {};
    const analysisSha256: Record<string, string> = {};
    for (const [name, file] of Object.entries(analysisFiles)) {
      const full = jobPath(jobId, 'analyze', file);
      if (!existsSync(full)) continue;
      const raw = await readFile(full);
      analysisSha256[name] = sha256(raw);
      (analysis as Record<string, unknown>)[name] = JSON.parse(raw.toString());
    }
    const client = connectTarget(target);
    const { info, existing } = await probeTarget(client, target);
    const plan = buildPlan({
      jobId,
      version: (await latestPlanVersion(jobId)) + 1,
      source: { origin: job.origin, profile: job.profile },
      inputs: { extractSha256: sha256(await readFile(jobPath(jobId, 'extract', 'pages.jsonl'))), analysisSha256 },
      target: info,
      pages: await readJsonl<ExtractedPage>(jobPath(jobId, 'extract', 'pages.jsonl')),
      snapshotPages: await readJsonl<SnapshotPage>(jobPath(jobId, 'snapshot', 'pages.jsonl')),
      files: await readJsonl<SnapshotFile>(jobPath(jobId, 'snapshot', 'files.jsonl')),
      existing,
      analysis,
      timezone: values.timezone,
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
    fail(`Unknown command "${command ?? ''}". Commands: scan, extract, analyze, plan, approve, execute, report`);
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
