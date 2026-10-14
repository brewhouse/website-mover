import { PgBoss } from 'pg-boss';
import { createRun, type Stage, type StageRun } from './jobs.js';
import { transaction } from './pool.js';

export const STAGE_QUEUE = 'stage';

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
      // One active stage per job (singleton key = job id); stages aren't retried automatically, and
      // a migration may run for hours.
      await b.createQueue(STAGE_QUEUE, { policy: 'singleton', retryLimit: 0, expireInSeconds: 8 * 3600 });
    }
    boss = b;
  }
  return boss;
}

export async function closeQueue(): Promise<void> {
  await boss?.stop({ graceful: true });
  boss = undefined;
}

/** Records the run and queues its first stage; later stages are queued as each one succeeds. */
export async function enqueueStages(jobId: string, stages: Stage[], requestedBy: number | null): Promise<StageRun> {
  const b = await queue();
  return transaction(async (client) => {
    const run = await createRun(client, jobId, stages, requestedBy);
    await b.send(STAGE_QUEUE, { runId: run.id } satisfies StageJobData, { singletonKey: jobId });
    return run;
  });
}
