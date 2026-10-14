import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
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
