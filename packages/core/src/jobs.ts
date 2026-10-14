import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Root of all job directories: WM_DATA_DIR, or data/ at the repo root. */
export function dataDir(): string {
  return process.env.WM_DATA_DIR ?? path.resolve(import.meta.dirname, '../../../data');
}

/** Absolute path inside a job's directory. */
export function jobPath(jobId: string, ...parts: string[]): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(jobId)) throw new Error(`Invalid job id: ${jobId}`);
  return path.join(dataDir(), 'jobs', jobId, ...parts);
}

/**
 * Writes JSON atomically (a temporary file, then a rename), so a reader in another process (the web
 * app reading a plan the worker is writing) never sees half a file.
 */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}
