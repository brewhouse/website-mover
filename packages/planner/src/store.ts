import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { jobPath, readJson, writeJson } from '@wm/core';
import { Approval, Plan } from './schema.js';
import { renderPlan } from './render.js';

const planFile = (jobId: string, version: number) => jobPath(jobId, 'plan', `plan.v${version}.json`);

/** Highest plan version saved for the job, or 0. */
export async function latestPlanVersion(jobId: string): Promise<number> {
  const names = await readdir(jobPath(jobId, 'plan')).catch(() => [] as string[]);
  return Math.max(0, ...names.map((n) => Number(/^plan\.v(\d+)\.json$/.exec(n)?.[1] ?? 0)));
}

/** Saves the plan (JSON + Markdown) and returns its sha256. */
export async function savePlan(plan: Plan): Promise<string> {
  const file = planFile(plan.jobId, plan.version);
  await writeJson(file, plan);
  await writeFile(file.replace(/\.json$/, '.md'), renderPlan(plan));
  return sha256(await readFile(file));
}

export async function loadPlan(jobId: string, version?: number): Promise<{ plan: Plan; sha256: string }> {
  const v = version ?? (await latestPlanVersion(jobId));
  if (!v) throw new Error(`Job ${jobId} has no plan yet`);
  const raw = await readFile(planFile(jobId, v));
  return { plan: Plan.parse(JSON.parse(raw.toString())), sha256: sha256(raw) };
}

export async function approvePlan(jobId: string, approvedBy: string): Promise<Approval> {
  const { plan, sha256: planSha256 } = await loadPlan(jobId);
  const approval = Approval.parse({
    jobId,
    planVersion: plan.version,
    planSha256,
    approvedBy,
    approvedAt: new Date().toISOString(),
  });
  await writeJson(jobPath(jobId, 'plan', 'approval.json'), approval);
  return approval;
}

/** The latest plan, only if its exact bytes were approved. */
export async function loadApprovedPlan(jobId: string): Promise<{ plan: Plan; approval: Approval }> {
  const approval = Approval.parse(await readJson(jobPath(jobId, 'plan', 'approval.json')).catch(() => {
    throw new Error(`Plan for ${jobId} is not approved: run "wm approve" first`);
  }));
  const { plan, sha256: current } = await loadPlan(jobId);
  if (plan.version !== approval.planVersion || current !== approval.planSha256) {
    throw new Error(
      `Approval is for plan v${approval.planVersion}, but the current plan is v${plan.version}` +
        (plan.version === approval.planVersion ? ' and has changed since' : '') +
        ': review and approve it again',
    );
  }
  return { plan, approval };
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
