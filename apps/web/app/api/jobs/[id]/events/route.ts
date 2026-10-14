import { eventsSince, getJob, listRuns } from '@wm/db';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The job's live log as server-sent events: `log` events (one per line) and a `run` event whenever
 * the latest stage run changes, so the page can refresh. Polls Postgres once a second.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new Response('Log in first', { status: 401 });
  const { id } = await params;
  if (!(await getJob(id))) return new Response('No such job', { status: 404 });
  let after = Number(new URL(request.url).searchParams.get('after') ?? request.headers.get('last-event-id') ?? 0) || 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown, eventId?: number) =>
        controller.enqueue(encoder.encode(`${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      let lastRun = '';
      while (!request.signal.aborted) {
        try {
          for (const e of await eventsSince(id, after)) {
            after = e.id;
            send('log', e, e.id);
          }
          const [run] = await listRuns(id, 1);
          const runKey = run ? `${run.id}:${run.status}` : '';
          if (runKey !== lastRun) {
            lastRun = runKey;
            send('run', run ? { id: run.id, stage: run.stage, status: run.status } : null);
          }
        } catch (err) {
          send('error', { message: (err as Error).message });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
