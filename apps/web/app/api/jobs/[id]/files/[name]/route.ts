import { getJob } from '@wm/db';
import { DOWNLOADS, reportFile } from '@/lib/job-files';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** The report's CSVs and Markdown (an allowlist of file names). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  if (!(await currentUser())) return new Response('Log in first', { status: 401 });
  const { id, name } = await params;
  if (!(await getJob(id))) return new Response('No such job', { status: 404 });
  const body = await reportFile(id, name);
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(body), {
    headers: { 'Content-Type': `${DOWNLOADS[name as keyof typeof DOWNLOADS]}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${id}-${name}"` },
  });
}
