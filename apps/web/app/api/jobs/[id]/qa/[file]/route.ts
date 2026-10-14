import { getJob } from '@wm/db';
import { qaScreenshot } from '@/lib/job-files';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** QA screenshots (file names as qa.json lists them). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  if (!(await currentUser())) return new Response('Log in first', { status: 401 });
  const { id, file } = await params;
  if (!(await getJob(id))) return new Response('No such job', { status: 404 });
  const body = await qaScreenshot(id, file);
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' } });
}
