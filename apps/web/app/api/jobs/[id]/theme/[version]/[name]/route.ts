import { readFile } from 'node:fs/promises';
import { audit, getJob } from '@wm/db';
import { themeDownload } from '@wm/design/review';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** A design job's theme change set: the zip, the patch, the README or its design plan (B3). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; version: string; name: string }> }) {
  const user = await currentUser();
  if (!user) return new Response('Log in first', { status: 401 });
  const { id, version, name } = await params;
  const job = await getJob(id);
  if (!job || job.kind !== 'design') return new Response('No such design job', { status: 404 });
  const d = themeDownload(id, Number(version), name);
  if (!d) return new Response('Not found', { status: 404 });
  const body = await readFile(d.file).catch(() => null);
  if (!body) return new Response('Not found', { status: 404 });
  await audit(id, user.id, 'design.theme_download', { version: Number(version), name });
  return new Response(new Uint8Array(body), {
    headers: { 'Content-Type': d.type, 'Content-Disposition': `attachment; filename="${d.filename}"`, 'Cache-Control': 'private, no-store' },
  });
}
