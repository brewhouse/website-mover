/**
 * The pipeline stages, shared by the CLI and the queue worker (docs/m4/design.md). Approval isn't a
 * stage: a person does it (CLI `wm approve`, or the web app).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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
import { buildPlan, latestPlanVersion, loadDecisions, savePlan, type BrandInput, type PlanOptions } from '@wm/planner';
import { BrandFile, type BrandManifest } from '@wm/styleguide/brand';
import { buildReport, executePlan, probeTarget, rollbackJob, runPostLaunch } from '@wm/executor';
import { runQa } from '@wm/qa';
import type { WpClient } from '@wm/wp-client';

export type StageName = 'scan' | 'extract' | 'analyze' | 'plan' | 'execute' | 'report' | 'qa' | 'postlaunch' | 'rollback' | 'ingest' | 'model' | 'design_plan' | 'design_theme';

export interface StageContext {
  jobId: string;
  /** Source site and its profile (scan only; later stages read job.json). For a design job, origin is the Figma link. */
  source?: { origin: string; profile: string; cacheDir?: string };
  /** The WordPress target (plan, execute, report). */
  target?: { name: string; client: WpClient };
  /** Site timezone the plan should set (IANA name). */
  timezone?: string | null;
  /** GA4 measurement ID (plan: theme option; post-launch: the tag to look for). */
  ga4Id?: string | null;
  /** The live address for the post-launch check (else the target). */
  liveUrl?: string | null;
  /** Job options the plan applies (incremental, content only, side navigation in the main menu). */
  options?: Partial<PlanOptions>;
  log: (message: string) => void;
}

/** Runs one stage and returns a short summary of what it did. */
export async function runStage(stage: StageName, ctx: StageContext): Promise<Record<string, unknown>> {
  const { jobId, log } = ctx;
  const target = () => ctx.target ?? fail(`The ${stage} stage needs a target`);
  switch (stage) {
    case 'scan': {
      const source = ctx.source ?? fail('The scan stage needs a source URL and profile');
      return { ...(await scanSite({ jobId, origin: source.origin, profile: source.profile, cacheDir: source.cacheDir, log })) };
    }
    case 'extract':
      return { ...(await extractJob({ jobId, log })) };
    case 'analyze': {
      const meetings = await analyzeMeetings(jobId, log);
      const forms = await analyzeForms(jobId, log);
      const records = await analyzeRecords(jobId, log);
      const site = await analyzeSite(jobId, log);
      return {
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
      };
    }
    case 'plan': {
      const { name, client } = target();
      const job = await readJson<JobInfo>(jobPath(jobId, 'job.json'));
      // Analysis is optional (M1 plans don't have it); when present, its hashes go into the plan.
      const analysisFiles = { meetings: 'meetings.json', forms: 'forms.json', records: 'records.json', site: 'site.json' } as const;
      const analysis: { meetings?: MeetingAnalysis; forms?: FormAnalysis; records?: RecordAnalysis; site?: SiteAnalysis } = {};
      const analysisSha256: Record<string, string> = {};
      for (const [key, file] of Object.entries(analysisFiles)) {
        const full = jobPath(jobId, 'analyze', file);
        if (!existsSync(full)) continue;
        const raw = await readFile(full);
        analysisSha256[key] = sha256(raw);
        (analysis as Record<string, unknown>)[key] = JSON.parse(raw.toString());
      }
      const extract = await readFile(jobPath(jobId, 'extract', 'pages.jsonl'));
      // The brand imported with `wm brand` (optional): the plan's Design section.
      let brand: BrandInput | undefined;
      if (existsSync(jobPath(jobId, 'inputs', 'brand', 'manifest.json'))) {
        const manifest = await readFile(jobPath(jobId, 'inputs', 'brand', 'manifest.json'));
        const file = await readFile(jobPath(jobId, 'inputs', 'brand', 'brand.json'));
        const parsed = JSON.parse(manifest.toString()) as BrandManifest;
        // The manifest's hash goes into the plan; it vouches for brand.json only if that's unchanged.
        if (sha256(file) !== parsed.brandSha256) throw new Error('inputs/brand/brand.json changed after "wm brand": import the brand file again');
        brand = { file: BrandFile.parse(JSON.parse(file.toString())), manifest: parsed, sha256: sha256(manifest) };
      }
      const { info, existing } = await probeTarget(client, name);
      const plan = buildPlan({
        jobId,
        version: (await latestPlanVersion(jobId)) + 1,
        source: { origin: job.origin, profile: job.profile },
        inputs: { extractSha256: sha256(extract), analysisSha256 },
        target: info,
        pages: await readJsonl<ExtractedPage>(jobPath(jobId, 'extract', 'pages.jsonl')),
        snapshotPages: await readJsonl<SnapshotPage>(jobPath(jobId, 'snapshot', 'pages.jsonl')),
        files: await readJsonl<SnapshotFile>(jobPath(jobId, 'snapshot', 'files.jsonl')),
        existing,
        analysis,
        timezone: ctx.timezone ?? undefined,
        ga4Id: ctx.ga4Id ?? undefined,
        brand,
        decisions: await loadDecisions(jobId),
        options: ctx.options,
      });
      const sha = await savePlan(plan);
      const on = Object.entries(plan.options).filter(([, v]) => v).map(([k]) => k);
      log(`Plan v${plan.version} (${sha.slice(0, 12)})${on.length ? `, options: ${on.join(', ')}` : ''}`);
      for (const w of plan.warnings) log(`  ! ${w}`);
      return { version: plan.version, sha256: sha, expected: plan.expected, warnings: plan.warnings.length };
    }
    case 'execute': {
      const state = await executePlan({ jobId, client: target().client, log });
      const summary = { objects: Object.keys(state.entities).length, failures: state.failures.length, redirects: state.redirects.length };
      log(`Done: ${summary.objects} objects, ${summary.failures} failures, ${summary.redirects} redirects`);
      return summary;
    }
    case 'report': {
      const report = await buildReport({ jobId, client: target().client, log });
      log(`Report: ${jobPath(jobId, 'report', 'report.md')}`);
      return { counts: report.counts, failures: report.failures.length };
    }
    case 'rollback': {
      const r = await rollbackJob({ jobId, client: target().client, log });
      return { ...r, problems: r.problems.length };
    }
    case 'postlaunch': {
      const r = await runPostLaunch({ jobId, base: ctx.liveUrl || target().client.baseUrl, ga4Id: ctx.ga4Id, log });
      return { checked: r.checked, ok: r.ok, problems: r.problems.length, ga4Found: r.ga4.found };
    }
    // ── Build from design (docs/build/PLAN.md) ──
    case 'ingest': {
      const design = await import('@wm/design');
      // The uploads are unpacked again only when they're newer than what was unpacked from them.
      const newer = async (input: string, done: string) => {
        const a = await stat(jobPath(jobId, ...input.split('/'))).catch(() => null);
        if (!a) return false;
        const b = await stat(jobPath(jobId, ...done.split('/'))).catch(() => null);
        return !b || a.mtimeMs > b.mtimeMs;
      };
      if (await newer('inputs/theme.zip', 'design/theme/style.css')) {
        const t = await design.unpackTheme(jobPath(jobId, 'inputs', 'theme.zip'), jobPath(jobId, 'design', 'theme'));
        log(`Theme: ${t.files} PHP/JSON files from ${t.prefix || 'the top of the zip'}`);
      }
      const inv = await design.ingestDesign({
        jobId,
        zip: (await newer('inputs/mockups.zip', 'design/intake.json')) ? jobPath(jobId, 'inputs', 'mockups.zip') : undefined,
        figmaUrl: ctx.source?.origin,
        log,
      });
      return { pages: inv.pages.length, frames: inv.frames.length, unmatched: inv.gaps.unmatchedFrames.length, ambiguous: inv.gaps.ambiguous.length };
    }
    case 'model': {
      const design = await import('@wm/design');
      if (!existsSync(jobPath(jobId, 'design', 'theme', 'functions.php'))) fail('No framework theme yet: upload the theme zip on the job page');
      const m = await design.modelDesign({ jobId, themeRoot: jobPath(jobId, 'design', 'theme'), target: target().client, log });
      return { components: m.components.length, sections: m.pages.reduce((n, p) => n + p.sections.length, 0), fits: m.schema.pages.length + m.schema.collections.length };
    }
    case 'design_plan': {
      const design = await import('@wm/design');
      // The AI refines the rules' draft whenever it's configured.
      const ai = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
      if (!ai) log('  ! OPENAI_API_KEY / OPENAI_MODEL not set: the plan is the rules\' draft only');
      const { plan, sha256: sha } = await design.planDesign({ jobId, themeRoot: jobPath(jobId, 'design', 'theme'), ai, log });
      for (const w of plan.warnings) log(`  ! ${w}`);
      return { version: plan.version, sha256: sha, expected: plan.expected, warnings: plan.warnings.length };
    }
    case 'design_theme': {
      const design = await import('@wm/design');
      const m = await design.generateThemeChanges({ jobId, log });
      for (const w of m.warnings) log(`  ! ${w}`);
      for (const f of m.files.filter((x) => x.lint === 'error')) log(`  ! PHP lint: ${f.path}: ${f.lintMessage}`);
      return { version: m.planVersion, files: m.files.length, replaced: m.files.filter((f) => f.action === 'replace').length, lint: m.lint, warnings: m.warnings.length };
    }
    case 'qa': {
      const qa = await runQa({ jobId, baseUrl: target().client.baseUrl, log });
      return { pages: qa.pages.length, rules: qa.rules.length, siteWide: qa.rules.filter((r) => r.siteWide).length, overflowMobile: qa.overflow.mobile?.length ?? 0 };
    }
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function fail(message: string): never {
  throw new Error(message);
}
