'use server';

import { mkdir, writeFile } from 'node:fs/promises';
import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { jobPath } from '@wm/core';
import {
  audit,
  checkLogin,
  createJob,
  createSession,
  createTarget,
  endSession,
  enqueueStages,
  getJob,
  JobBusyError,
  loginBlocked,
  recordLogin,
  setLiveUrl,
  listRuns,
  listTargets,
  targetCredentials,
  transaction,
  type Stage,
} from '@wm/db';
import { assertPublicUrl } from '@wm/net';
import { approvePlan, latestPlanVersion, loadDecisions, saveDecisions, type ReviewDecisions } from '@wm/planner';
import { WpClient } from '@wm/wp-client';
import { planState } from './job-files';
import { isHttps, safeNext } from './safe-next';
import { dbReady, requireUser, SESSION_COOKIE } from './session';

export interface FormState {
  error?: string;
  ok?: string;
  /** What was submitted (never secrets), so a form that failed validation keeps its values. */
  values?: Record<string, string>;
}

/** The form's text fields, minus secrets and files. */
function kept(form: FormData, ...secret: string[]): Record<string, string> {
  return Object.fromEntries([...form.entries()].filter(([k, v]) => typeof v === 'string' && !secret.includes(k) && !k.startsWith('$')) as [string, string][]);
}

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

// ---------- Login ----------

export async function login(_: FormState, form: FormData): Promise<FormState> {
  await dbReady();
  const email = text(form, 'email');
  const h = await headers();
  // The client's address only when a trusted proxy sets it (WM_TRUST_PROXY=1); otherwise anyone could
  // send any X-Forwarded-For, and only the per-email limit applies.
  const ip = process.env.WM_TRUST_PROXY === '1' ? h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || null : null;
  if (await loginBlocked(email, ip)) return { error: 'Too many failed attempts: try again in 15 minutes.', values: kept(form, 'password') };
  const user = await checkLogin(email, String(form.get('password') ?? ''));
  await recordLogin(email, ip, !!user);
  if (!user) return { error: 'That email and password don’t match an account.', values: kept(form, 'password') };
  const { token, expiresAt } = await createSession(user.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Secure whenever the site is reached over https; a Secure cookie on plain http is never stored.
    secure: isHttps(await headers()),
    path: '/',
    expires: expiresAt,
  });
  redirect(safeNext(text(form, 'next')));
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await endSession(token);
  store.delete(SESSION_COOKIE);
  redirect('/login');
}

// ---------- Targets ----------

export async function addTarget(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const name = text(form, 'name').toLowerCase();
  const url = text(form, 'url');
  const wpUser = text(form, 'wpUser');
  const appPassword = String(form.get('appPassword') ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return { error: 'Name: lowercase letters, numbers and dashes.', values: kept(form, 'appPassword') };
  if (!wpUser || !appPassword) return { error: 'Enter the WordPress user and its Application Password.', values: kept(form, 'appPassword') };
  try {
    await assertPublicUrl(url);
  } catch (err) {
    return { error: `Site URL: ${(err as Error).message}`, values: kept(form, 'appPassword') };
  }
  if ((await listTargets()).some((t) => t.name === name)) return { error: `There is already a target called ${name}.`, values: kept(form, 'appPassword') };
  const target = await createTarget({ name, url, wpUser, appPassword, createdBy: user.id });
  await audit(null, user.id, 'target.add', { target: target.name, url: target.url });
  revalidatePath('/targets');
  return { ok: `Saved ${target.name}. Test the connection before using it.` };
}

/** Checks the credentials and that the bridge plugin answers. */
export async function testTarget(_: FormState, form: FormData): Promise<FormState> {
  await requireUser();
  try {
    const client = new WpClient(await targetCredentials(Number(form.get('targetId'))));
    const status = await client.get<{ wordpress: string; theme: { stylesheet: string }; active_plugins: Record<string, string> }>('/website-mover/v1/status');
    const redirection = 'redirection' in status.active_plugins ? 'Redirection active' : 'Redirection not active';
    return { ok: `Connected: WordPress ${status.wordpress}, theme ${status.theme.stylesheet}, bridge active, ${redirection}.` };
  } catch (err) {
    const e = err as Error & { status?: number; cause?: { message?: string } };
    if (e.status === 404) return { error: 'Connected, but the Website Mover Bridge plugin isn’t active on that site.' };
    if (e.status === 401 || e.status === 403) return { error: 'WordPress refused the user or Application Password.' };
    return { error: `Couldn’t connect: ${e.cause?.message ?? e.message}` };
  }
}

// ---------- Jobs ----------

const PROFILES = ['bjm', 'generic'];
const MAX_PDF_BYTES = 50 * 1024 * 1024;

export async function createJobAction(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const id = text(form, 'id').toLowerCase();
  const sourceUrl = text(form, 'sourceUrl');
  const profile = text(form, 'profile');
  const targetId = Number(form.get('targetId'));
  const timezone = text(form, 'timezone') || null;
  const ga4Id = text(form, 'ga4Id').toUpperCase() || null;
  const pdf = form.get('styleGuide');

  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return { error: 'Job name: lowercase letters, numbers and dashes (e.g. jha).', values: kept(form) };
  if (await getJob(id)) return { error: `There is already a job called ${id}.`, values: kept(form) };
  try {
    await assertPublicUrl(sourceUrl);
  } catch (err) {
    return { error: `Source URL: ${(err as Error).message}`, values: kept(form) };
  }
  if (!PROFILES.includes(profile)) return { error: 'Choose a site profile.', values: kept(form) };
  if (!(await listTargets()).some((t) => t.id === targetId)) return { error: 'Choose a target.', values: kept(form) };
  if (timezone && !Intl.supportedValuesOf('timeZone').includes(timezone)) return { error: `Unknown timezone: ${timezone}`, values: kept(form) };
  if (ga4Id && !/^G-[A-Z0-9]{4,12}$/.test(ga4Id)) return { error: 'GA4 measurement IDs look like G-XXXXXXXXXX.', values: kept(form) };
  if (form.get('rights') !== 'on') return { error: 'Confirm we have the rights to copy this site’s content.', values: kept(form) };

  let styleGuide: string | null = null;
  if (pdf instanceof File && pdf.size > 0) {
    if (pdf.size > MAX_PDF_BYTES) return { error: 'The style guide is over 50 MB.', values: kept(form) };
    const bytes = Buffer.from(await pdf.arrayBuffer());
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'The style guide must be a PDF.', values: kept(form) };
    styleGuide = 'style-guide.pdf';
    await mkdir(jobPath(id, 'inputs'), { recursive: true });
    await writeFile(jobPath(id, 'inputs', styleGuide), bytes);
  }

  await createJob({ id, sourceUrl: new URL(sourceUrl).origin, profile, targetId, timezone, ga4Id, styleGuide, userId: user.id });
  await audit(id, user.id, 'job.create', { sourceUrl, profile, targetId, rightsConfirmed: true });
  await enqueueStages(id, ['scan', 'extract', 'analyze', 'plan'], user.id);
  redirect(`/jobs/${id}`);
}

/** What the job page's buttons run. */
const RUNS: Record<string, Stage[]> = {
  'through-plan': ['scan', 'extract', 'analyze', 'plan'],
  analyze: ['analyze', 'plan'],
  plan: ['plan'],
  execute: ['execute', 'report', 'qa'],
  report: ['report'],
  qa: ['qa'],
  postlaunch: ['postlaunch'],
};

export async function runStages(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const jobId = text(form, 'jobId');
  const which = text(form, 'run');
  const stages = RUNS[which];
  if (!stages || !(await getJob(jobId))) return { error: 'Unknown job or action.' };
  if (which === 'execute' && !user.canApprove) return { error: 'Only approvers can run a migration.' };
  if (which === 'execute') {
    // Execution follows only an approved plan; the executor checks again before it writes anything.
    const state = await planState(jobId);
    if (!state?.approved) return { error: state ? `Plan v${state.plan.version} isn’t approved yet.` : 'There is no plan yet.' };
  }
  try {
    await enqueueStages(jobId, stages, user.id);
  } catch (err) {
    if (err instanceof JobBusyError) return { error: 'This job is already running a stage. Wait for it to finish.' };
    throw err;
  }
  await audit(jobId, user.id, 'run', { stages });
  revalidatePath(`/jobs/${jobId}`);
  return { ok: `Queued: ${stages.join(' → ')}` };
}

/** The site's live address, for the post-launch check (empty: check the target). */
export async function saveLiveUrl(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const jobId = text(form, 'jobId');
  const url = text(form, 'liveUrl');
  if (!(await getJob(jobId))) return { error: 'Unknown job.' };
  if (url) {
    try {
      await assertPublicUrl(url);
    } catch (err) {
      return { error: `Live address: ${(err as Error).message}`, values: kept(form) };
    }
  }
  await setLiveUrl(jobId, url ? new URL(url).origin : null);
  await audit(jobId, user.id, 'job.live-url', { liveUrl: url || null });
  revalidatePath(`/jobs/${jobId}`);
  return { ok: url ? `Post-launch checks will use ${new URL(url).origin}.` : 'Post-launch checks will use the target.' };
}

/**
 * Undoes the job on its target (docs/m5/design.md §5). Approvers only, and only when the job's name
 * is typed to confirm.
 */
export async function rollback(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  if (!user.canApprove) return { error: 'Only approvers can roll a migration back.' };
  const jobId = text(form, 'jobId');
  if (!(await getJob(jobId))) return { error: 'Unknown job.' };
  if (text(form, 'confirm') !== jobId) return { error: `Type the job name (${jobId}) to confirm.` };
  try {
    await enqueueStages(jobId, ['rollback'], user.id);
  } catch (err) {
    if (err instanceof JobBusyError) return { error: 'This job is running a stage. Wait for it to finish.' };
    throw err;
  }
  await audit(jobId, user.id, 'rollback', {});
  revalidatePath(`/jobs/${jobId}`);
  return { ok: 'Rollback queued: follow it in the live log.' };
}

// ---------- Review decisions ----------

/**
 * Changes the job's saved decisions. Concurrent reviewers are serialized per job (advisory lock), so
 * neither change is lost.
 */
async function changeDecisions(jobId: string, action: string, detail: unknown, change: (d: ReviewDecisions) => void): Promise<void> {
  const user = await requireUser();
  if (!(await getJob(jobId))) throw new Error('Unknown job');
  await transaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`decisions:${jobId}`]);
    const decisions = await loadDecisions(jobId);
    change(decisions);
    await saveDecisions(jobId, decisions);
  });
  await audit(jobId, user.id, `decision.${action}`, detail);
  revalidatePath(`/jobs/${jobId}/review`);
}

const toggle = <T,>(list: T[], value: T, on: boolean) => {
  const i = list.indexOf(value);
  if (on && i < 0) list.push(value);
  if (!on && i >= 0) list.splice(i, 1);
};

export async function setExcluded(jobId: string, key: string, excluded: boolean): Promise<void> {
  await changeDecisions(jobId, excluded ? 'exclude' : 'unexclude', { key }, (d) => toggle(d.exclude, key, excluded));
}

export async function setIncluded(jobId: string, key: string, included: boolean): Promise<void> {
  await changeDecisions(jobId, included ? 'include' : 'uninclude', { key }, (d) => toggle(d.include, key, included));
}

export async function setType(jobId: string, key: string, type: 'page' | 'post' | null): Promise<void> {
  await changeDecisions(jobId, 'type', { key, type }, (d) => {
    if (type) d.type[key] = type;
    else delete d.type[key];
  });
}

export async function setSlug(jobId: string, key: string, form: FormData): Promise<void> {
  const slug = text(form, 'slug');
  await changeDecisions(jobId, 'slug', { key, slug: slug || null }, (d) => {
    if (slug) d.slug[key] = slug;
    else delete d.slug[key];
  });
}

/** Sets (or, with an empty slug, clears) the chosen slug without a form. */
export async function setSlugTo(jobId: string, key: string, slug = ''): Promise<void> {
  await changeDecisions(jobId, 'slug', { key, slug: slug || null }, (d) => {
    if (slug) d.slug[key] = slug;
    else delete d.slug[key];
  });
}

export async function setKept(jobId: string, id: number, kept: boolean): Promise<void> {
  await changeDecisions(jobId, kept ? 'keep' : 'unkeep', { id }, (d) => toggle(d.keep, id, kept));
}

// ---------- Approval ----------

export async function approve(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  if (!user.canApprove) return { error: 'Only approvers can approve a plan.' };
  const jobId = text(form, 'jobId');
  const version = Number(form.get('version'));
  const sha = text(form, 'sha256');
  if (form.get('reviewed') !== 'on') return { error: 'Tick the box to confirm you reviewed this plan.' };
  const runs = await listRuns(jobId, 1);
  if (runs[0] && (runs[0].status === 'queued' || runs[0].status === 'running')) return { error: 'A stage is running: approve once it has finished.' };
  // The approval binds the exact plan the reviewer was looking at.
  if ((await latestPlanVersion(jobId)) !== version) return { error: 'There is a newer plan version: review that one.' };
  try {
    await approvePlan(jobId, user.name, { version, sha256: sha });
  } catch (err) {
    return { error: (err as Error).message };
  }
  await audit(jobId, user.id, 'plan.approve', { version, sha256: sha });
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/jobs/${jobId}/review`);
  return { ok: `Approved plan v${version}.` };
}
