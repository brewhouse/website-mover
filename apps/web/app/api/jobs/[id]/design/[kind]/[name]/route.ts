import { readFile } from 'node:fs/promises';
import { getJob } from '@wm/db';
import { designImagePath } from '@wm/design/review';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Figma frame renders ("frame") and mockup screenshots ("shot") for the design review (PNG only). */
export async function GET(_: Request, { params }: { params: Promise<{ id: string; kind: string; name: string }> }) {
  if (!(await currentUser())) return new Response('Log in first', { status: 401 });
  const { id, kind, name } = await params;
  if (!(await getJob(id))) return new Response('No such job', { status: 404 });
  const file = kind === 'frame' || kind === 'shot' ? designImagePath(id, kind, name) : null;
  if (!file) return new Response('Not found', { status: 404 });
  const body = await readFile(file).catch(() => null);
  if (!body) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(body), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=3600' } });
}
