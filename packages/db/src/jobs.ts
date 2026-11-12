import type pg from 'pg';
import { decryptSecret, encryptSecret } from './crypto.js';
import { db } from './pool.js';

// ---------- Targets ----------

export interface Target {
  id: number;
  name: string;
  url: string;
  wpUser: string;
  createdAt: Date;
}

const targetCols = 'id, name, url, wp_user as "wpUser", created_at as "createdAt"';

export async function createTarget(t: { name: string; url: string; wpUser: string; appPassword: string; createdBy: number | null }): Promise<Target> {
  const { rows } = await db().query<Target>(
    `insert into targets (name, url, wp_user, app_password_enc, created_by) values ($1, $2, $3, $4, $5) returning ${targetCols}`,
    [t.name, t.url.replace(/\/+$/, ''), t.wpUser, encryptSecret(t.appPassword), t.createdBy],
  );
  return rows[0]!;
}

export async function listTargets(): Promise<Target[]> {
  return (await db().query<Target>(`select ${targetCols} from targets order by name`)).rows;
}

export async function getTarget(id: number): Promise<Target | null> {
  return (await db().query<Target>(`select ${targetCols} from targets where id = $1`, [id])).rows[0] ?? null;
}

/** URL, user and decrypted Application Password: for the worker and "test connection" only. */
export async function targetCredentials(id: number): Promise<{ name: string; baseUrl: string; user: string; appPassword: string }> {
  const { rows } = await db().query<{ name: string; url: string; wp_user: string; app_password_enc: string }>('select name, url, wp_user, app_password_enc from targets where id = $1', [id]);
  const row = rows[0];
  if (!row) throw new Error(`No target #${id}`);
  return { name: row.name, baseUrl: row.url, user: row.wp_user, appPassword: decryptSecret(row.app_password_enc) };
}

// ---------- Jobs ----------

/** How a job migrates (see PlanOptions in @wm/planner, which the plan records). */
export interface JobOptions {
  /** Only content that isn't on the target yet; nothing already there is changed or trashed. */
  incremental: boolean;
  /** Content only: no menus, theme options, homepage fields, branding or site settings. */
  contentOnly: boolean;
  /** Add the source's side navigation to the main menu as dropdowns. */
  sideNavMenu: boolean;
  /** The source's side navigation on the pages that show it (one menu per section, shown by the theme). */
  sideNavPages: boolean;
}

export const NO_OPTIONS: JobOptions = { incremental: false, contentOnly: false, sideNavMenu: false, sideNavPages: false };

export type JobKind = 'migrate' | 'design';

export interface Job {
  id: string;
  /** migrate: copy a site; design: build one from mockups (sourceUrl is then the Figma link). */
  kind: JobKind;
  sourceUrl: string;
  profile: string;
  targetId: number;
  targetName: string;
  timezone: string | null;
  ga4Id: string | null;
  styleGuide: string | null;
  /** The live address, once launched (post-launch check). */
  liveUrl: string | null;
  options: JobOptions;
  createdBy: string;
  createdAt: Date;
}

const jobSelect = `select j.id, j.kind, j.source_url as "sourceUrl", j.profile, j.target_id as "targetId", t.name as "targetName", j.timezone,
  j.ga4_id as "ga4Id", j.style_guide as "styleGuide", j.live_url as "liveUrl", j.options, u.name as "createdBy", j.created_at as "createdAt"
  from jobs j join targets t on t.id = j.target_id join users u on u.id = j.created_by`;

export async function createJob(j: {
  id: string;
  kind?: JobKind;
  sourceUrl: string;
  profile: string;
  targetId: number;
  timezone: string | null;
  ga4Id: string | null;
  styleGuide: string | null;
  options?: JobOptions;
  userId: number;
}): Promise<void> {
  await db().query(
    `insert into jobs (id, source_url, profile, target_id, timezone, ga4_id, style_guide, rights_confirmed_by, created_by, options, kind)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10)`,
    [j.id, j.sourceUrl, j.profile, j.targetId, j.timezone, j.ga4Id, j.styleGuide, j.userId, JSON.stringify(j.options ?? NO_OPTIONS), j.kind ?? 'migrate'],
  );
}

export async function setJobOptions(id: string, options: JobOptions): Promise<void> {
  await db().query('update jobs set options = $2 where id = $1', [id, JSON.stringify(options)]);
}

export async function setLiveUrl(id: string, liveUrl: string | null): Promise<void> {
  await db().query('update jobs set live_url = $2 where id = $1', [id, liveUrl]);
}

/** Options stored before a field existed read as off. */
const withOptions = (j: Job): Job => ({ ...j, options: { ...NO_OPTIONS, ...(j.options ?? {}) } });

export async function getJob(id: string): Promise<Job | null> {
  const job = (await db().query<Job>(`${jobSelect} where j.id = $1`, [id])).rows[0];
  return job ? withOptions(job) : null;
}

export async function listJobs(): Promise<(Job & { lastRun: StageRun | null })[]> {
  const jobs = (await db().query<Job>(`${jobSelect} order by j.created_at desc`)).rows.map(withOptions);
  const runs = (await db().query<StageRun>(`select distinct on (job_id) ${runCols} from stage_runs order by job_id, id desc`)).rows;
  return jobs.map((j) => ({ ...j, lastRun: runs.find((r) => r.jobId === j.id) ?? null }));
}

// ---------- Stage runs ----------

export const STAGES = ['scan', 'extract', 'analyze', 'plan', 'execute', 'report', 'qa', 'postlaunch', 'rollback', 'ingest', 'model', 'design_plan', 'design_theme', 'design_build', 'design_rollback'] as const;
/** A design job's stages (docs/build/PLAN.md): mockups and Figma in, an approvable plan out. */
export const DESIGN_STAGES = ['ingest', 'model', 'design_plan'] as const;
export type Stage = (typeof STAGES)[number];

export interface StageRun {
  id: number;
  jobId: string;
  stage: Stage;
  status: 'queued' | 'running' | 'done' | 'failed';
  thenStages: Stage[];
  requestedBy: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  summary: unknown;
}

const runCols = `id, job_id as "jobId", stage, status, then_stages as "thenStages",
  (select name from users where id = requested_by) as "requestedBy",
  queued_at as "queuedAt", started_at as "startedAt", finished_at as "finishedAt", error, summary`;

export class JobBusyError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} is already running a stage: wait for it to finish`);
    this.name = 'JobBusyError';
  }
}

/** Queues a stage run (the unique index refuses a second active run for the job). */
export async function createRun(client: pg.PoolClient | pg.Pool, jobId: string, stages: Stage[], requestedBy: number | null): Promise<StageRun> {
  const [stage, ...then] = stages;
  if (!stage) throw new Error('No stage to run');
  try {
    const { rows } = await client.query<StageRun>(
      `insert into stage_runs (job_id, stage, then_stages, requested_by) values ($1, $2, $3, $4) returning ${runCols}`,
      [jobId, stage, then, requestedBy],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).constraint === 'stage_runs_one_active') throw new JobBusyError(jobId);
    throw err;
  }
}

export async function getRun(id: number): Promise<StageRun | null> {
  return (await db().query<StageRun>(`select ${runCols} from stage_runs where id = $1`, [id])).rows[0] ?? null;
}

export async function listRuns(jobId: string, limit = 50): Promise<StageRun[]> {
  return (await db().query<StageRun>(`select ${runCols} from stage_runs where job_id = $1 order by id desc limit $2`, [jobId, limit])).rows;
}

/** Claims a queued run for this worker. Only one claimant wins, so a run never runs twice. */
export async function claimRun(id: number): Promise<boolean> {
  const { rowCount } = await db().query(`update stage_runs set status = 'running', started_at = now(), heartbeat_at = now() where id = $1 and status = 'queued'`, [id]);
  return rowCount === 1;
}

export async function heartbeat(id: number): Promise<void> {
  await db().query(`update stage_runs set heartbeat_at = now() where id = $1 and status = 'running'`, [id]);
}

export async function finishRun(id: number, result: { error: string } | { summary: unknown }): Promise<void> {
  if ('error' in result) await db().query(`update stage_runs set status = 'failed', finished_at = now(), error = $2 where id = $1`, [id, result.error]);
  else await db().query(`update stage_runs set status = 'done', finished_at = now(), summary = $2 where id = $1`, [id, JSON.stringify(result.summary ?? null)]);
}

/** A running stage whose worker hasn't sent a heartbeat for this long is treated as stopped. */
export const STALE_SECONDS = 180;

/**
 * Housekeeping for runs a worker can't finish: running runs whose worker stopped (stale heartbeat)
 * are marked failed, and the ids of runs queued longer than `queuedSeconds` are returned so the
 * caller can check they're still on the queue.
 */
export async function sweepRuns(queuedSeconds = 120): Promise<{ failed: number; queued: number[] }> {
  const { rowCount } = await db().query(
    `update stage_runs set status = 'failed', finished_at = now(), error = 'The worker stopped while this stage was running'
     where status = 'running' and coalesce(heartbeat_at, started_at) < now() - make_interval(secs => $1)`,
    [STALE_SECONDS],
  );
  const { rows } = await db().query<{ id: number }>(`select id from stage_runs where status = 'queued' and queued_at < now() - make_interval(secs => $1)`, [queuedSeconds]);
  return { failed: rowCount ?? 0, queued: rows.map((r) => r.id) };
}

// ---------- Live log ----------

export interface LogEvent {
  id: number;
  runId: number | null;
  at: Date;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export async function appendEvent(jobId: string, runId: number | null, message: string, level: LogEvent['level'] = 'info'): Promise<void> {
  await db().query('insert into events (job_id, run_id, level, message) values ($1, $2, $3, $4)', [jobId, runId, level, message.slice(0, 4000)]);
}

export async function eventsSince(jobId: string, afterId: number, limit = 500): Promise<LogEvent[]> {
  return (
    await db().query<LogEvent>(
      'select id::int, run_id as "runId", at, level, message from events where job_id = $1 and id > $2 order by id limit $3',
      [jobId, afterId, limit],
    )
  ).rows;
}

/** The last `limit` log lines for a job, oldest first. */
export async function recentEvents(jobId: string, limit = 300): Promise<LogEvent[]> {
  const { rows } = await db().query<LogEvent>(
    'select * from (select id::int, run_id as "runId", at, level, message from events where job_id = $1 order by id desc limit $2) e order by id',
    [jobId, limit],
  );
  return rows;
}

// ---------- Audit ----------

export interface AuditEntry {
  id: number;
  user: string | null;
  action: string;
  detail: unknown;
  at: Date;
}

export async function audit(jobId: string | null, userId: number | null, action: string, detail?: unknown): Promise<void> {
  await db().query('insert into audit (job_id, user_id, action, detail) values ($1, $2, $3, $4)', [jobId, userId, action, detail === undefined ? null : JSON.stringify(detail)]);
}

export async function listAudit(jobId: string, limit = 100): Promise<AuditEntry[]> {
  return (
    await db().query<AuditEntry>(
      'select a.id::int, u.name as "user", a.action, a.detail, a.at from audit a left join users u on u.id = a.user_id where a.job_id = $1 order by a.id desc limit $2',
      [jobId, limit],
    )
  ).rows;
}
