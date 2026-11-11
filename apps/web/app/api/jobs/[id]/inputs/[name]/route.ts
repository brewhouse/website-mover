import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { jobPath } from '@wm/core';
import { audit, getJob } from '@wm/db';
import { DESIGN_INPUTS, MAX_INPUT_BYTES, type DesignInput } from '@/lib/design-inputs';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * A design job's mockup or theme zip, sent as the raw request body and streamed to disk (a form
 * would hold hundreds of megabytes in memory). Checked: logged in, a design job, a ZIP signature and
 * the size limit. The next ingest unpacks it.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const user = await currentUser();
  if (!user) return new Response('Log in first', { status: 401 });
  const { id, name } = await params;
  const job = await getJob(id);
  if (!job || job.kind !== 'design') return new Response('No such design job', { status: 404 });
  if (!(name in DESIGN_INPUTS)) return new Response('Unknown input', { status: 404 });
  if (!request.body) return new Response('Empty upload', { status: 400 });
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_INPUT_BYTES) return new Response(`Over ${MAX_INPUT_BYTES / 1024 / 1024} MB`, { status: 413 });

  const dir = jobPath(id, 'inputs');
  await mkdir(dir, { recursive: true });
  const final = jobPath(id, 'inputs', name);
  const partial = `${final}.${Date.now()}.part`;
  let bytes = 0;
  let head = Buffer.alloc(0);
  const check = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (head.length < 4) head = Buffer.concat([head, chunk]).subarray(0, 4);
      if (bytes > MAX_INPUT_BYTES) return done(new Error('too large'));
      if (head.length >= 4 && head.readUInt32LE(0) !== 0x04034b50) return done(new Error('not a zip'));
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(request.body as import('node:stream/web').ReadableStream), check, createWriteStream(partial));
    if (bytes < 22) throw new Error('not a zip');
    await rename(partial, final);
  } catch (err) {
    await rm(partial, { force: true });
    const msg = (err as Error).message;
    if (msg === 'too large') return new Response(`Over ${MAX_INPUT_BYTES / 1024 / 1024} MB`, { status: 413 });
    if (msg === 'not a zip') return new Response('That file isn’t a ZIP archive', { status: 415 });
    throw err;
  }
  await audit(id, user.id, 'design.upload', { name, bytes });
  return Response.json({ name: name as DesignInput, bytes: (await stat(final)).size });
}
