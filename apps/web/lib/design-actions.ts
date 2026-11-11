'use server';

/**
 * Build-from-design jobs (docs/build/PLAN.md): intake, running the design stages, reviewers'
 * decisions and approval. The large inputs (mockup and theme zips) are uploaded separately, straight
 * to disk (app/api/jobs/[id]/inputs/[name]/route.ts).
 */
import { existsSync } from 'node:fs';
import { revalidatePath } from 'next/cache';
import { jobPath, readJson } from '@wm/core';
import { audit, createJob, DESIGN_STAGES, enqueueStages, getJob, JobBusyError, listRuns, listTargets, transaction, type Stage } from '@wm/db';
import {
  approveDesignPlan,
  Binding,
  latestDesignPlanVersion,
  loadDesignDecisions,
  PageKind,
  parseFigmaUrl,
  partKey,
  saveDesignDecisions,
  saveFrameMatches,
  type DesignDecisions,
  type Proposal,
} from '@wm/design/review';
import type { FormState } from './actions';
import { DESIGN_INPUTS } from './design-inputs';
import { requireUser } from './session';

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();


/** Creates the job; the page then uploads the zips and calls startDesignJob. */
export async function createDesignJob(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const id = text(form, 'id').toLowerCase();
  const figma = text(form, 'figma');
  const targetId = Number(form.get('targetId'));
  const values = { id, figma, targetId: String(targetId) };
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return { error: 'Job name: lowercase letters, numbers and dashes (e.g. newport).', values };
  if (await getJob(id)) return { error: `There is already a job called ${id}.`, values };
  try {
    parseFigmaUrl(figma);
  } catch (err) {
    return { error: `Figma link: ${(err as Error).message}`, values };
  }
  if (!(await listTargets()).some((t) => t.id === targetId)) return { error: 'Choose a target.', values };
  if (form.get('rights') !== 'on') return { error: 'Confirm we may use these designs for the client’s site.', values };
  await createJob({ id, kind: 'design', sourceUrl: figma, profile: 'design', targetId, timezone: null, ga4Id: null, styleGuide: null, userId: user.id });
  await audit(id, user.id, 'job.create', { kind: 'design', figma, targetId, rightsConfirmed: true });
  return { ok: id };
}

/** Queues ingest → model → plan once both zips are on disk. */
export async function startDesignJob(jobId: string): Promise<FormState> {
  const user = await requireUser();
  const job = await getJob(jobId);
  if (!job || job.kind !== 'design') return { error: 'Unknown design job.' };
  const missing = Object.entries(DESIGN_INPUTS).filter(([f]) => !existsSync(jobPath(jobId, 'inputs', f)));
  if (missing.length) return { error: `Upload first: ${missing.map(([, l]) => l).join(', ')}.` };
  return queue(jobId, [...DESIGN_STAGES], user.id);
}

const DESIGN_RUNS: Record<string, Stage[]> = {
  all: [...DESIGN_STAGES],
  model: ['model', 'design_plan'],
  plan: ['design_plan'],
};

export async function runDesignStages(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const jobId = text(form, 'jobId');
  const stages = DESIGN_RUNS[text(form, 'run')];
  const job = await getJob(jobId);
  if (!stages || !job || job.kind !== 'design') return { error: 'Unknown job or action.' };
  return queue(jobId, stages, user.id);
}

async function queue(jobId: string, stages: Stage[], userId: number): Promise<FormState> {
  try {
    await enqueueStages(jobId, stages, userId);
  } catch (err) {
    if (err instanceof JobBusyError) return { error: 'This job is already running a stage. Wait for it to finish.' };
    throw err;
  }
  await audit(jobId, userId, 'run', { stages });
  revalidatePath(`/jobs/${jobId}`);
  return { ok: `Queued: ${stages.join(' → ')}` };
}

// ---------- Decisions ----------

/** Serializes reviewers per job (advisory lock), so neither change is lost. */
async function changeDesignDecisions(jobId: string, action: string, detail: unknown, change: (d: DesignDecisions) => void): Promise<void> {
  const user = await requireUser();
  const job = await getJob(jobId);
  if (!job || job.kind !== 'design') throw new Error('Unknown design job');
  await transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`design-decisions:${jobId}`]);
    const d = await loadDesignDecisions(jobId);
    change(d);
    await saveDesignDecisions(jobId, d);
  });
  await audit(jobId, user.id, `design.${action}`, detail);
  revalidatePath(`/jobs/${jobId}/design`);
}

/** The proposal the latest plan was built from (rules, AI and decisions applied), for edits that start from it. */
async function currentProposal(jobId: string): Promise<Proposal> {
  const v = await latestDesignPlanVersion(jobId);
  const p = await readJson<{ draft: Proposal; proposal: Proposal | null }>(jobPath(jobId, 'design', 'plan', `proposal.v${v}.json`));
  return p.proposal ?? p.draft;
}

export async function setPageDecision(jobId: string, page: string, form: FormData): Promise<void> {
  const title = text(form, 'title');
  const kind = PageKind.safeParse(text(form, 'kind'));
  const postType = text(form, 'postType');
  await changeDesignDecisions(jobId, 'page', { page, title, kind: kind.data, postType }, (d) => {
    const next = { ...(d.pages[page] ?? {}) };
    if (title) next.title = title;
    if (kind.success) next.kind = kind.data;
    next.postType = postType || null;
    d.pages[page] = next;
  });
}

/** A part's binding and post type, and its fields' names and labels. */
export async function setPartDecision(jobId: string, key: string, form: FormData): Promise<void> {
  const proposal = await currentProposal(jobId);
  const part = proposal.parts.find((p) => partKey(p) === key);
  if (!part) throw new Error('That part isn’t in the latest plan');
  const binding = Binding.safeParse(text(form, 'binding'));
  const fields = part.fields.map((f, i) => ({ ...f, name: text(form, `name.${i}`) || f.name, label: text(form, `label.${i}`) || f.label }));
  await changeDesignDecisions(jobId, 'part', { key, binding: binding.data }, (d) => {
    d.parts[key] = {
      ...(d.parts[key] ?? {}),
      ...(binding.success ? { binding: binding.data } : {}),
      postType: text(form, 'postType') || null,
      taxonomy: text(form, 'taxonomy') || null,
      block: text(form, 'block') || null,
      fields,
    };
  });
}

export async function clearDesignDecision(jobId: string, kind: 'page' | 'part', key: string): Promise<void> {
  await changeDesignDecisions(jobId, `${kind}.clear`, { key }, (d) => {
    if (kind === 'page') delete d.pages[key];
    else delete d.parts[key];
  });
}

/** A reviewer's frame ↔ page match ("page.html", "shell", "reference", or "" to let the tool decide). */
export async function setFrameMatch(jobId: string, frameId: string, value: string): Promise<void> {
  const user = await requireUser();
  const job = await getJob(jobId);
  if (!job || job.kind !== 'design') throw new Error('Unknown design job');
  await transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`design-matches:${jobId}`]);
    const current = await readJson<Record<string, string | null>>(jobPath(jobId, 'review', 'design-matches.json')).catch(() => ({}) as Record<string, string | null>);
    if (value) current[frameId] = value === 'none' ? null : value;
    else delete current[frameId];
    await saveFrameMatches(jobId, current);
  });
  await audit(jobId, user.id, 'design.frame', { frameId, value: value || null });
  revalidatePath(`/jobs/${jobId}/design`);
}

// ---------- Approval ----------

export async function approveDesign(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  if (!user.canApprove) return { error: 'Only approvers can approve a plan.' };
  const jobId = text(form, 'jobId');
  const version = Number(form.get('version'));
  const sha = text(form, 'sha256');
  if (form.get('reviewed') !== 'on') return { error: 'Tick the box to confirm you reviewed this plan.' };
  const runs = await listRuns(jobId, 1);
  if (runs[0] && (runs[0].status === 'queued' || runs[0].status === 'running')) return { error: 'A stage is running: approve once it has finished.' };
  try {
    await approveDesignPlan(jobId, user.name, { version, sha256: sha });
  } catch (err) {
    return { error: (err as Error).message };
  }
  await audit(jobId, user.id, 'plan.approve', { version, sha256: sha, kind: 'design' });
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/jobs/${jobId}/design`);
  return { ok: `Approved design plan v${version}.` };
}
