import { getJob } from '@wm/db';
import { brandLogo } from '@/lib/job-files';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** The brand's logos (inputs/brand/logos), for the review's Design tab. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  if (!(await currentUser())) return new Response('Log in first', { status: 401 });
  const { id, file } = await params;
  if (!(await getJob(id))) return new Response('No such job', { status: 404 });
  const logo = await brandLogo(id, file);
  if (!logo) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(logo.body), { headers: { 'Content-Type': logo.type, 'Cache-Control': 'private, max-age=300' } });
}
