/**
 * What the web app's design review needs (`@wm/design/review`): the plan, its approval, the
 * inventory and the reviewer's decisions. No browser or AI client is loaded from here.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { jobPath, readJson, writeJson } from '@wm/core';
import type { Inventory } from './ingest.js';
import { DesignApproval, DesignDecisions, latestDesignPlanVersion, loadDesignDecisions, loadDesignPlan } from './plan-run.js';
import type { DesignPlan } from './plan-schema.js';

export { approveDesignPlan, DesignApproval, DesignDecisions, latestDesignPlanVersion, loadDesignDecisions, loadDesignPlan } from './plan-run.js';
export { partKey, type Proposal, type ProposalPart, type ProposalField } from './propose.js';
export { Binding, PageKind, FieldType, type DesignPlan, type PlanTemplate, type PlanPart, type PlanFieldGroup, type PlanField, type PlanEntry } from './plan-schema.js';
export type { Inventory } from './ingest.js';
export { parseFigmaUrl } from './figma.js';
export type { FrameMatch } from './match.js';

export interface DesignState {
  plan: DesignPlan;
  sha256: string;
  approval: DesignApproval | null;
  approved: boolean;
  decisions: DesignDecisions;
  /** Decisions saved since this plan was made: re-plan to see them. */
  pendingDecisions: boolean;
  inventory: Inventory | null;
  /** Frame ↔ page corrections saved by reviewers. */
  matches: Record<string, string | null>;
}

const stable = (v: unknown) => JSON.stringify(v, Object.keys(v ?? {}).sort());

export async function designState(jobId: string): Promise<DesignState | null> {
  if (!(await latestDesignPlanVersion(jobId))) return null;
  const { plan, sha256 } = await loadDesignPlan(jobId);
  const approval = await readJson(jobPath(jobId, 'design', 'plan', 'approval.json'))
    .then((a) => DesignApproval.parse(a))
    .catch(() => null);
  const decisions = await loadDesignDecisions(jobId);
  const used = await readJson<{ decisions: DesignDecisions | null }>(jobPath(jobId, 'design', 'plan', `proposal.v${plan.version}.json`)).catch(() => ({ decisions: null }));
  return {
    plan,
    sha256,
    approval,
    approved: !!approval && approval.planVersion === plan.version && approval.planSha256 === sha256,
    decisions,
    pendingDecisions: stable(DesignDecisions.parse(used.decisions ?? {})) !== stable(decisions),
    inventory: await readJson<Inventory>(jobPath(jobId, 'design', 'inventory.json')).catch(() => null),
    matches: await readJson<Record<string, string | null>>(jobPath(jobId, 'review', 'design-matches.json')).catch(() => ({})),
  };
}

/** The latest version and whether it's approved, for lists (hashes the file, doesn't parse it). */
export async function designHeadline(jobId: string): Promise<{ version: number; approved: boolean } | null> {
  const version = await latestDesignPlanVersion(jobId);
  if (!version) return null;
  const approval = await readJson<DesignApproval>(jobPath(jobId, 'design', 'plan', 'approval.json')).catch(() => null);
  if (!approval || approval.planVersion !== version) return { version, approved: false };
  const bytes = await readFile(jobPath(jobId, 'design', 'plan', `plan.v${version}.json`));
  return { version, approved: createHash('sha256').update(bytes).digest('hex') === approval.planSha256 };
}

export async function saveDesignDecisions(jobId: string, d: DesignDecisions): Promise<void> {
  const parsed = DesignDecisions.parse(d);
  const sorted = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  await writeJson(jobPath(jobId, 'review', 'design-decisions.json'), { ...parsed, pages: sorted(parsed.pages), parts: sorted(parsed.parts) });
}

export async function saveFrameMatches(jobId: string, matches: Record<string, string | null>): Promise<void> {
  await writeJson(jobPath(jobId, 'review', 'design-matches.json'), Object.fromEntries(Object.entries(matches).sort(([a], [b]) => a.localeCompare(b))));
}

/** Files the review page may show: Figma frame renders and mockup screenshots (PNG only). */
export function designImagePath(jobId: string, kind: 'frame' | 'shot', name: string): string | null {
  if (!/^[A-Za-z0-9_.-]+\.png$/.test(name) || name.includes('..')) return null;
  return kind === 'frame' ? jobPath(jobId, 'design', 'figma', 'frames', name) : jobPath(jobId, 'design', 'screenshots', name);
}
