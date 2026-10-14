/** A job's on-disk artifacts, as the pages need them. */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { jobPath, readJson } from '@wm/core';
import { Approval, latestPlanVersion, loadDecisions, loadPlan, type Plan, type ReviewDecisions } from '@wm/planner';
import type { Report } from '@wm/executor';
import type { QaReport } from '@wm/qa';

export interface PlanState {
  plan: Plan;
  sha256: string;
  /** The approval on file, if any (it may be for an older version). */
  approval: Approval | null;
  /** The approval covers exactly this plan. */
  approved: boolean;
  /** The reviewer's saved decisions. */
  decisions: ReviewDecisions;
  /** Saved decisions differ from the ones this plan applied: re-plan to see their effect. */
  pendingDecisions: boolean;
}

export async function planState(jobId: string, version?: number): Promise<PlanState | null> {
  if (!(await latestPlanVersion(jobId))) return null;
  const { plan, sha256 } = await loadPlan(jobId, version);
  const approval = await readJson<unknown>(jobPath(jobId, 'plan', 'approval.json'))
    .then((a) => Approval.parse(a))
    .catch(() => null);
  const decisions = await loadDecisions(jobId);
  return {
    plan,
    sha256,
    approval,
    approved: !!approval && approval.planVersion === plan.version && approval.planSha256 === sha256,
    decisions,
    pendingDecisions: decisionsKey(decisions) !== decisionsKey(plan.decisions),
  };
}

/**
 * Just the latest version and whether it's approved, for lists: the plan's bytes are hashed, not
 * parsed (a plan can be megabytes).
 */
export async function planHeadline(jobId: string): Promise<{ version: number; approved: boolean } | null> {
  const version = await latestPlanVersion(jobId);
  if (!version) return null;
  const approval = await readJson<Approval>(jobPath(jobId, 'plan', 'approval.json')).catch(() => null);
  if (!approval || approval.planVersion !== version) return { version, approved: false };
  const bytes = await readFile(jobPath(jobId, 'plan', `plan.v${version}.json`));
  return { version, approved: createHash('sha256').update(bytes).digest('hex') === approval.planSha256 };
}

/**
 * Stages whose output is on disk. Jobs the CLI ran before the web app existed have no stage runs in
 * the database, so the job page falls back to this.
 */
export async function stagesOnDisk(jobId: string): Promise<Set<string>> {
  const files: Record<string, string[]> = {
    scan: ['snapshot', 'pages.jsonl'],
    extract: ['extract', 'pages.jsonl'],
    analyze: ['analyze', 'site.json'],
    execute: ['run', 'state.json'],
    report: ['report', 'report.json'],
    qa: ['qa', 'qa.json'],
  };
  const done = await Promise.all(Object.entries(files).map(async ([stage, parts]) => ((await stat(jobPath(jobId, ...parts)).catch(() => null)) ? stage : null)));
  return new Set(done.filter((s): s is string => !!s));
}

/** The previous version of a plan, for the Changes tab. */
export async function previousPlan(jobId: string, version: number): Promise<Plan | null> {
  return version > 1 ? (await loadPlan(jobId, version - 1).catch(() => null))?.plan ?? null : null;
}

export async function loadReport(jobId: string): Promise<Report | null> {
  return readJson<Report>(jobPath(jobId, 'report', 'report.json')).catch(() => null);
}

export async function loadQa(jobId: string): Promise<QaReport | null> {
  return readJson<QaReport>(jobPath(jobId, 'qa', 'qa.json')).catch(() => null);
}

/** A QA screenshot, by its file name (as qa.json lists it). */
export async function qaScreenshot(jobId: string, file: string): Promise<Buffer | null> {
  if (!/^[a-z0-9-]+-(mobile|tablet|desktop)\.png$/i.test(file)) return null;
  return readFile(jobPath(jobId, 'qa', 'screenshots', file)).catch(() => null);
}

/** Files the report page offers for download. */
export const DOWNLOADS = { 'redirects.csv': 'text/csv', 'url-map.csv': 'text/csv', 'report.md': 'text/markdown' } as const;

export async function reportFile(jobId: string, name: string): Promise<Buffer | null> {
  if (!(name in DOWNLOADS)) return null;
  return readFile(jobPath(jobId, 'report', name)).catch(() => null);
}

function decisionsKey(d: ReviewDecisions | null): string {
  const empty = !d || (!d.exclude.length && !d.include.length && !Object.keys(d.type).length && !Object.keys(d.slug).length && !d.keep.length);
  if (empty) return '';
  return createHash('sha256')
    .update(JSON.stringify([[...d.exclude].sort(), [...d.include].sort(), Object.entries(d.type).sort(), Object.entries(d.slug).sort(), [...d.keep].sort((a, b) => a - b)]))
    .digest('hex');
}
