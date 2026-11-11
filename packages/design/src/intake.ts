/**
 * Mockup intake (PLAN "Flow" 1): unpacks the HTML/CSS zip into the job folder, keeping only what a
 * browser needs to show the pages. Version control, editor settings, node_modules, SCSS sources and
 * build configs are dropped and counted.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZip, type ZipLimits } from './zip.js';

const KEEP = new Set([
  'html', 'htm', 'css', 'js', 'mjs',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp4', 'webm', 'mp3', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt',
]);
const DROP_DIRS = new Set(['node_modules', '__MACOSX', 'bower_components']);

export interface IntakeResult {
  /** Folder the mockups were unpacked into. */
  root: string;
  kept: number;
  bytes: number;
  /** Dropped files, counted by reason. */
  dropped: Record<string, number>;
  /** A single top-level folder the archive was wrapped in, removed from the paths. */
  strippedPrefix: string | null;
}

/** Why a path is dropped, or null to keep it. */
export function dropReason(file: string): string | null {
  const parts = file.split('/');
  if (parts.some((p) => p.startsWith('.'))) return parts.find((p) => p === '.git') ? 'version control (.git)' : 'hidden files and editor settings';
  if (parts.some((p) => DROP_DIRS.has(p))) return 'dependencies (node_modules)';
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'scss' || ext === 'sass' || ext === 'less') return 'stylesheet sources (compiled CSS is kept)';
  if (ext === 'map') return 'source maps';
  if (!KEEP.has(ext)) return 'build and project files';
  return null;
}

/**
 * The framework theme from a zip (the theme folder, or the whole site repo): only its PHP and JSON
 * files and style.css, which is what the framework match reads. The theme is the folder holding
 * functions.php and style.css nearest the top (a "wp-content/themes/planeteriaweb/" inside is found).
 */
export async function unpackTheme(zipFile: string, dest: string, theme = 'planeteriaweb', limits?: ZipLimits): Promise<{ root: string; files: number; prefix: string }> {
  const entries = readZip(await readFile(zipFile), limits).filter((e) => !e.isDirectory);
  const dirs = entries.filter((e) => /(^|\/)functions\.php$/.test(e.name)).map((e) => e.name.replace(/functions\.php$/, ''));
  const withStyle = dirs.filter((d) => entries.some((e) => e.name === `${d}style.css`));
  // Prefer the named theme (a repo zip holds a parent theme too), then the shallowest.
  const prefix = [...withStyle].sort((a, b) => Number(b.includes(`${theme}/`)) - Number(a.includes(`${theme}/`)) || a.split('/').length - b.split('/').length)[0];
  if (prefix === undefined) throw new Error('No theme in the zip: it needs a folder with functions.php and style.css');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  let files = 0;
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const rel = e.name.slice(prefix.length);
    if (!/\.(php|json)$|^style\.css$/.test(rel) || rel.split('/').some((p) => p.startsWith('.') || p === 'node_modules' || p === 'vendor')) continue;
    const out = path.join(dest, rel);
    if (!out.startsWith(dest + path.sep)) throw new Error(`Unsafe path in ZIP: ${e.name}`);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, e.read());
    files++;
  }
  return { root: dest, files, prefix };
}

export async function unpackMockups(zipFile: string, dest: string, limits?: ZipLimits): Promise<IntakeResult> {
  const entries = readZip(await readFile(zipFile), limits).filter((e) => !e.isDirectory);
  // Most zips wrap everything in one folder ("Newport-beach/"): drop it so pages sit at the root.
  const tops = new Set(entries.map((e) => (e.name.includes('/') ? e.name.split('/')[0] : '')));
  const prefix = tops.size === 1 && !tops.has('') ? `${[...tops][0]}/` : '';

  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const dropped: Record<string, number> = {};
  let kept = 0;
  let bytes = 0;
  for (const entry of entries) {
    const rel = entry.name.slice(prefix.length);
    const reason = dropReason(rel);
    if (reason) {
      dropped[reason] = (dropped[reason] ?? 0) + 1;
      continue;
    }
    const out = path.join(dest, rel);
    if (!out.startsWith(dest + path.sep)) throw new Error(`Unsafe path in ZIP: ${entry.name}`);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, entry.read());
    kept++;
    bytes += entry.size;
  }
  return { root: dest, kept, bytes, dropped, strippedPrefix: prefix ? prefix.slice(0, -1) : null };
}
