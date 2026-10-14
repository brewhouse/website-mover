/**
 * The queue worker (docs/m4/design.md): runs the stages the web app queues, one at a time per job,
 * and writes their log to Postgres for the live view.
 *
 *   pnpm --filter @wm/worker worker
 */
import { appendEvent, closeDb, closeQueue, createRun, db, failAbandonedRuns, finishRun, getJob, getRun, migrate, queue, STAGE_QUEUE, startRun, targetCredentials, type StageJobData, type StageRun } from '@wm/db';
import { WpClient } from '@wm/wp-client';
import { runStage } from './stages.js';

await migrate();
const abandoned = await failAbandonedRuns();
if (abandoned) console.log(`Marked ${abandoned} interrupted stage run(s) as failed`);

const boss = await queue();
// Different jobs run side by side; the queue's singleton key keeps each job to one stage at a time.
await boss.work<StageJobData>(STAGE_QUEUE, { localConcurrency: 2 }, async ([job]) => {
  if (job) await handle(job.data.runId);
});
console.log('Worker ready');

async function handle(runId: number): Promise<void> {
  const run = await getRun(runId);
  if (!run || run.status !== 'queued') return; // already handled (e.g. a redelivered job)
  // Log lines are written one after another, so the live view shows them in order.
  let written = Promise.resolve();
  const log = (message: string) => {
    console.log(`[${run.jobId} ${run.stage}] ${message}`);
    written = written.then(() => appendEvent(run.jobId, run.id, message, /^\s*!/.test(message) ? 'warn' : 'info')).catch((err) => console.error('log write failed', err));
  };
  await startRun(run.id);
  log(`Started ${run.stage}${run.requestedBy ? ` (requested by ${run.requestedBy})` : ''}`);
  try {
    const job = (await getJob(run.jobId)) ?? fail(`Job ${run.jobId} is not registered`);
    const needsTarget = ['plan', 'execute', 'report'].includes(run.stage);
    const summary = await runStage(run.stage, {
      jobId: job.id,
      source: { origin: job.sourceUrl, profile: job.profile },
      target: needsTarget ? { name: job.targetName, client: new WpClient(await targetCredentials(job.targetId)) } : undefined,
      timezone: job.timezone,
      log,
    });
    log(`Finished ${run.stage}`);
    await written;
    await finishRun(run.id, { summary });
    await queueNext(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await written;
    await appendEvent(run.jobId, run.id, `${run.stage} failed: ${message}`, 'error');
    await finishRun(run.id, { error: message });
    console.error(`[${run.jobId} ${run.stage}] failed`, err);
  }
}

/** "Run through to the plan": queue the next stage once this one has succeeded. */
async function queueNext(run: StageRun): Promise<void> {
  const [next, ...rest] = run.thenStages;
  if (!next) return;
  const requestedBy = (await db().query<{ requested_by: number | null }>('select requested_by from stage_runs where id = $1', [run.id])).rows[0]?.requested_by ?? null;
  const nextRun = await createRun(db(), run.jobId, [next, ...rest], requestedBy);
  await boss.send(STAGE_QUEUE, { runId: nextRun.id } satisfies StageJobData, { singletonKey: run.jobId });
}

function fail(message: string): never {
  throw new Error(message);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    console.log('Stopping: finishing the current stages first');
    await closeQueue();
    await closeDb();
    process.exit(0);
  });
}
