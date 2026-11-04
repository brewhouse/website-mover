/**
 * The queue worker (docs/m4/design.md): runs the stages the web app queues, one at a time per job,
 * and writes their log to Postgres for the live view.
 *
 *   pnpm --filter @wm/worker worker
 */
import {
  appendEvent,
  claimRun,
  closeDb,
  closeQueue,
  createRun,
  db,
  finishRun,
  getJob,
  getRun,
  heartbeat,
  migrate,
  queue,
  recoverRuns,
  sendRun,
  STAGE_QUEUE,
  targetCredentials,
  type StageJobData,
  type StageRun,
} from '@wm/db';
import { WpClient } from '@wm/wp-client';
import { runStage, type StageName } from './stages.js';

await migrate();
const boss = await queue();
// Different jobs run side by side; stage_runs keeps each job to one stage at a time.
await boss.work<StageJobData>(STAGE_QUEUE, { localConcurrency: 2 }, async ([job]) => {
  if (job) await handle(job.data.runId);
});

// Runs whose worker stopped are failed (stale heartbeat); runs that lost their queue job are re-queued.
const recover = () =>
  recoverRuns()
    .then(({ failed, requeued }) => {
      if (failed || requeued) console.log(`Recovered runs: ${failed} failed (worker stopped), ${requeued} re-queued`);
    })
    .catch((err) => console.error('Run recovery failed', err));
await recover();
const sweep = setInterval(recover, 60_000);
console.log('Worker ready');

async function handle(runId: number): Promise<void> {
  // Claiming is atomic: a run delivered twice (or re-queued by recovery) still runs once.
  if (!(await claimRun(runId))) return;
  const run = (await getRun(runId))!;
  // Log lines are written one after another, so the live view shows them in order.
  let written = Promise.resolve();
  const log = (message: string) => {
    console.log(`[${run.jobId} ${run.stage}] ${message}`);
    written = written.then(() => appendEvent(run.jobId, run.id, message, /^\s*!/.test(message) ? 'warn' : 'info')).catch((err) => console.error('log write failed', err));
  };
  const beat = setInterval(() => void heartbeat(run.id).catch((err) => console.error('heartbeat failed', err)), 30_000);
  let succeeded = false;
  try {
    log(`Started ${run.stage}${run.requestedBy ? ` (requested by ${run.requestedBy})` : ''}`);
    const job = (await getJob(run.jobId)) ?? fail(`Job ${run.jobId} is not registered`);
    const needsTarget = ['plan', 'execute', 'report', 'qa', 'postlaunch', 'rollback'].includes(run.stage);
    const summary = await runStage(run.stage as StageName, {
      jobId: job.id,
      source: { origin: job.sourceUrl, profile: job.profile },
      target: needsTarget ? { name: job.targetName, client: new WpClient(await targetCredentials(job.targetId)) } : undefined,
      timezone: job.timezone,
      ga4Id: job.ga4Id,
      liveUrl: job.liveUrl,
      options: job.options,
      log,
    });
    log(`Finished ${run.stage}`);
    await written;
    await finishRun(run.id, { summary });
    succeeded = true;
  } catch (err) {
    const message = describe(err);
    await written;
    await appendEvent(run.jobId, run.id, `${run.stage} failed: ${message}`, 'error').catch(() => {});
    await finishRun(run.id, { error: message });
    console.error(`[${run.jobId} ${run.stage}] failed`, err);
  } finally {
    clearInterval(beat);
  }
  // Outside the stage's try: if the next stage can't be queued, this one still succeeded.
  if (succeeded) {
    await queueNext(run).catch((err) => appendEvent(run.jobId, run.id, `Couldn't start the next stage: ${describe(err)}`, 'warn'));
  }
}

/** "Run through to the plan": queue the next stage once this one has succeeded. */
async function queueNext(run: StageRun): Promise<void> {
  const [next, ...rest] = run.thenStages;
  if (!next) return;
  const requestedBy = (await db().query<{ requested_by: number | null }>('select requested_by from stage_runs where id = $1', [run.id])).rows[0]?.requested_by ?? null;
  const nextRun = await createRun(db(), run.jobId, [next, ...rest], requestedBy);
  await sendRun(nextRun.id);
}

/** The error and its causes: "fetch failed" alone doesn't say that the connection was refused. */
function describe(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e && parts.length < 4; e = (e as { cause?: unknown }).cause) {
    const message = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: string }).code;
    parts.push(code && !message.includes(code) ? `${message} (${code})` : message);
  }
  return parts.join(': ');
}

function fail(message: string): never {
  throw new Error(message);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    console.log('Stopping: finishing the current stages first');
    clearInterval(sweep);
    await closeQueue();
    await closeDb();
    process.exit(0);
  });
}
