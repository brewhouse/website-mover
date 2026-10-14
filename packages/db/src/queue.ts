import { PgBoss } from 'pg-boss';
import { createRun, finishRun, sweepRuns, type Stage, type StageRun } from './jobs.js';
import { db } from './pool.js';

export const STAGE_QUEUE = 'stage-runs';

/** What a queued stage job carries: the run row holds everything else. */
export interface StageJobData {
  runId: number;
}

let boss: PgBoss | undefined;

/** The started pg-boss instance, with the stage queue created. */
export async function queue(): Promise<PgBoss> {
  if (!boss) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    const b = new PgBoss({ connectionString });
    b.on('error', (err) => console.error('[queue]', err));
    await b.start();
    if (!(await b.getQueue(STAGE_QUEUE))) {
      // Stages aren't retried automatically, and a migration may run for hours. One active stage per
      // job is enforced by stage_runs (a unique index), not by the queue: a queue singleton held the
      // next stage of a chain back until the queue's slow maintenance pass.
      await b.createQueue(STAGE_QUEUE, { retryLimit: 0, expireInSeconds: 8 * 3600 }).catch(async (err) => {
        // The web app and the worker may both create it at start-up.
        if (!(await b.getQueue(STAGE_QUEUE))) throw err;
      });
    }
    boss = b;
  }
  return boss;
}

export async function closeQueue(): Promise<void> {
  await boss?.stop({ graceful: true });
  boss = undefined;
}

/**
 * Records the run and queues its first stage; later stages are queued as each one succeeds. The run
 * is committed before it's queued, so the worker always finds it.
 */
export async function enqueueStages(jobId: string, stages: Stage[], requestedBy: number | null): Promise<StageRun> {
  const b = await queue();
  const run = await createRun(db(), jobId, stages, requestedBy);
  await sendRun(run.id);
  return run;
}

/** Puts a recorded run on the queue; if that fails, the run is marked failed so the job isn't stuck. */
export async function sendRun(runId: number): Promise<void> {
  try {
    await (await queue()).send(STAGE_QUEUE, { runId } satisfies StageJobData);
  } catch (err) {
    await finishRun(runId, { error: `Couldn't queue the stage: ${(err as Error).message}` });
    throw err;
  }
}

/**
 * Fails runs whose worker stopped, and re-queues runs that have waited a while with nothing on the
 * queue for them (e.g. a queue job lost to a database error). Claiming is atomic, so a run queued
 * twice still runs once.
 */
export async function recoverRuns(): Promise<{ failed: number; requeued: number }> {
  const b = await queue();
  const { failed, queued } = await sweepRuns();
  let requeued = 0;
  for (const runId of queued) {
    if ((await b.findJobs(STAGE_QUEUE, { data: { runId }, queued: true })).length) continue;
    await sendRun(runId);
    requeued++;
  }
  return { failed, requeued };
}
