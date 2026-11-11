/**
 * `wm design theme` and the worker's design_theme stage: the approved plan → a theme change set in
 * design/theme-changes/v<plan>/:
 *   files/wp-content/themes/<theme>/…   the changed and new files, at their repo paths
 *   changes.patch                       git diff against the uploaded theme (git apply from the repo root)
 *   theme-changes-v<N>.zip              files/ zipped
 *   README.md                           what changes, how to install it, what to check
 *   manifest.json                       files, lint results, warnings
 * The team reviews and commits it; nothing is pushed anywhere (docs/build/PLAN.md "Decisions").
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jobPath, readJson, writeJson } from '@wm/core';
import type { DesignModel } from '../model.js';
import type { DesignPlan } from '../plan-schema.js';
import { loadApprovedDesignPlan } from '../plan-run.js';
import { writeZip } from '../zip.js';
import { generateTheme, type ThemeChangeSet } from './generate.js';

export interface ThemeRunOptions {
  jobId: string;
  /** The original theme folder (default: design/theme, unpacked from the upload). */
  themeRoot?: string;
  log?: (msg: string) => void;
}

export interface ThemeManifest {
  jobId: string;
  planVersion: number;
  createdAt: string;
  theme: string;
  files: { path: string; action: 'replace' | 'create'; bytes: number; from: string; lint: 'ok' | 'error' | 'skipped'; lintMessage?: string }[];
  templates: ThemeChangeSet['templates'];
  missingAssets: string[];
  warnings: string[];
  lint: 'ok' | 'errors' | 'unavailable';
  patch: boolean;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const dir = (jobId: string, ...p: string[]) => jobPath(jobId, 'design', ...p);

/** The theme's name in the repo (wp-content/themes/<name>): its text domain, else planeteriaweb. */
function themeName(root: string): string {
  const css = existsSync(path.join(root, 'style.css')) ? readFileSync(path.join(root, 'style.css'), 'utf8') : '';
  return /Text Domain:\s*([\w-]+)/i.exec(css)?.[1] ?? 'planeteriaweb';
}

export async function generateThemeChanges(opts: ThemeRunOptions): Promise<ThemeManifest> {
  const log = opts.log ?? (() => {});
  const { jobId } = opts;
  const { plan } = await loadApprovedDesignPlan(jobId);
  checkPlan(plan);
  const modelRaw = await readFile(dir(jobId, 'model.json')).catch(() => {
    throw new Error('No model: run the model stage first');
  });
  if (sha256(modelRaw) !== plan.inputs.modelSha256) throw new Error(`The model changed since design plan v${plan.version} was made: re-plan and approve again`);
  const model = JSON.parse(modelRaw.toString()) as DesignModel;
  const themeRoot = path.resolve(opts.themeRoot ?? dir(jobId, 'theme'));
  if (!existsSync(path.join(themeRoot, 'functions.php'))) throw new Error(`No theme at ${themeRoot}: upload the framework theme zip and run ingest`);
  const theme = themeName(themeRoot);
  const source = dir(jobId, 'source');
  const pages = new Map<string, string>();
  for (const t of plan.templates) {
    const html = await readFile(path.join(source, t.page), 'utf8').catch(() => null);
    if (html !== null) pages.set(t.page, html);
  }
  const inside = (root: string, rel: string) => {
    const full = path.resolve(root, rel);
    return full.startsWith(root + path.sep) ? full : null;
  };
  const changes = generateTheme({
    plan,
    model,
    pages,
    slug: jobId.replace(/[^a-z0-9-]+/gi, '-').toLowerCase(),
    readSource: (rel) => {
      const full = inside(source, rel);
      return full && existsSync(full) ? readFileSync(full) : null;
    },
    readTheme: (rel) => {
      const full = inside(themeRoot, rel);
      return full && existsSync(full) ? readFileSync(full, 'utf8') : null;
    },
  });

  const out = dir(jobId, 'theme-changes', `v${plan.version}`);
  await rm(out, { recursive: true, force: true });
  const repoPath = (p: string) => `wp-content/themes/${theme}/${p}`;
  for (const f of changes.files) {
    const file = path.join(out, 'files', repoPath(f.path));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, f.data);
  }

  // PHP lint (php -l), when PHP is installed.
  const phpOk = spawnSync('php', ['-v'], { encoding: 'utf8' }).status === 0;
  const lint = new Map<string, { ok: boolean; message: string }>();
  if (phpOk) {
    for (const f of changes.files.filter((x) => x.path.endsWith('.php'))) {
      const r = spawnSync('php', ['-l', path.join(out, 'files', repoPath(f.path))], { encoding: 'utf8' });
      const first = `${r.stderr}\n${r.stdout}`.split('\n').find((l) => /error/i.test(l)) ?? '';
      lint.set(f.path, { ok: r.status === 0, message: first.replace(/^PHP\s+/, '').replace(/ in \S+ on line/, ' on line').trim() });
    }
  } else log('PHP isn\'t installed here: the change set is not linted');
  const lintErrors = [...lint.values()].filter((l) => !l.ok).length;
  if (lintErrors) log(`PHP lint: ${lintErrors} files with errors`);

  // The patch: originals of the replaced files against the new ones (git diff of two folders).
  const work = path.join(out, '.diff');
  for (const f of changes.files) {
    await mkdir(path.dirname(path.join(work, 'new', repoPath(f.path))), { recursive: true });
    await writeFile(path.join(work, 'new', repoPath(f.path)), f.data);
    const orig = inside(themeRoot, f.path);
    if (f.action === 'replace' && orig) {
      await mkdir(path.dirname(path.join(work, 'old', repoPath(f.path))), { recursive: true });
      await writeFile(path.join(work, 'old', repoPath(f.path)), readFileSync(orig));
    }
  }
  await mkdir(path.join(work, 'old'), { recursive: true });
  const diff = spawnSync('git', ['diff', '--no-index', '--binary', 'old', 'new'], { cwd: work, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  const patch = diff.status === 1 ? diff.stdout.replace(/(^|[\s])([ab])\/(old|new)\//gm, '$1$2/') : null;
  if (patch) await writeFile(path.join(out, 'changes.patch'), patch);
  else log(`No patch (git ${diff.error ? "isn't installed" : `said: ${diff.stderr.trim().slice(0, 200)}`}); the files/ folder has every file`);
  await rm(work, { recursive: true, force: true });

  const zipName = `theme-changes-v${plan.version}.zip`;
  await writeFile(path.join(out, zipName), writeZip(changes.files.map((f) => ({ name: repoPath(f.path), data: f.data }))));

  const manifest: ThemeManifest = {
    jobId,
    planVersion: plan.version,
    createdAt: new Date().toISOString(),
    theme,
    files: changes.files.map((f) => {
      const l = lint.get(f.path);
      return { path: f.path, action: f.action, bytes: f.data.length, from: f.from, lint: l ? (l.ok ? 'ok' : 'error') : 'skipped', ...(l && !l.ok ? { lintMessage: l.message } : {}) };
    }),
    templates: changes.templates,
    missingAssets: changes.missingAssets,
    warnings: changes.warnings,
    lint: phpOk ? (lintErrors ? 'errors' : 'ok') : 'unavailable',
    patch: !!patch,
  };
  await writeJson(path.join(out, 'manifest.json'), manifest);
  await writeFile(path.join(out, 'README.md'), renderThemeReadme(manifest, plan));
  const php = manifest.files.filter((f) => f.path.endsWith('.php'));
  log(`Theme change set v${plan.version}: ${manifest.files.filter((f) => f.action === 'replace').length} files replaced, ${manifest.files.filter((f) => f.action === 'create').length} new (${php.length} PHP), ${manifest.templates.length} templates, ${plan.blocks.length} blocks; lint ${manifest.lint}; ${manifest.warnings.length} warnings`);
  return manifest;
}

/** Plans made before B3 don't say where each value sits in the mockup. */
function checkPlan(plan: DesignPlan): void {
  const bound = plan.templates.flatMap((t) => t.parts).filter((p) => p.fields.length > 0);
  if (bound.length && bound.every((p) => p.values.length === 0)) throw new Error(`Design plan v${plan.version} was made before the theme generator: re-plan and approve it again`);
}

export async function latestThemeChanges(jobId: string): Promise<ThemeManifest | null> {
  const names = await readdir(dir(jobId, 'theme-changes')).catch(() => [] as string[]);
  const v = Math.max(0, ...names.map((n) => Number(/^v(\d+)$/.exec(n)?.[1] ?? 0)));
  return v ? readJson<ThemeManifest>(dir(jobId, 'theme-changes', `v${v}`, 'manifest.json')).catch(() => null) : null;
}

export function renderThemeReadme(m: ThemeManifest, plan: DesignPlan): string {
  const root = `wp-content/themes/${m.theme}`;
  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const code = m.files.filter((f) => !f.path.startsWith('assets/'));
  const assets = m.files.filter((f) => f.path.startsWith('assets/'));
  const newTypes = plan.postTypes.filter((t) => t.action === 'create');
  const lines = [
    `# Theme change set v${m.planVersion}: ${m.jobId} (${m.theme})`,
    '',
    `Generated by Website Mover from design plan v${m.planVersion} on ${m.createdAt.slice(0, 10)}. The team reviews it and commits it to the site's repo; the tool doesn't push anything.`,
    '',
    '## Install',
    '',
    'From the root of a clone of the site\'s repo, on the branch that deploys to **dev**:',
    '',
    '```',
    m.patch ? 'git apply --whitespace=nowarn /path/to/changes.patch' : `unzip /path/to/theme-changes-v${m.planVersion}.zip`,
    `git add ${root}`,
    `git commit -m "Design build: theme change set v${m.planVersion}"`,
    '```',
    '',
    `Or unzip \`theme-changes-v${m.planVersion}.zip\` over the repo root: it has the same paths. Don't merge to test or live until the build (B4) has created the content types, fields and menus these templates read.`,
    '',
    `**PHP lint:** ${m.lint === 'ok' ? 'every PHP file passes `php -l`' : m.lint === 'errors' ? `${m.files.filter((f) => f.lint === 'error').length} files fail \`php -l\` (below)` : 'not run (PHP isn\'t installed where this was generated)'}.`,
    '',
    '## Files',
    '',
    '| File | Change | From |',
    '|---|---|---|',
    ...code.map((f) => `| \`${f.path}\` | ${f.action === 'replace' ? 'Replaced' : '**New**'}${f.lint === 'error' ? ' ⚠ lint' : ''} | ${f.from} |`),
    `| \`assets/${m.jobId}/\` | **New** | ${assets.length} files from the mockups (${kb(assets.reduce((n, f) => n + f.bytes, 0))}): stylesheets, scripts, fonts and the images the CSS and templates use |`,
    '',
    '## How it works',
    '',
    '- **Assets:** the mockup\'s stylesheets and scripts load from `assets/` with their folder layout kept, so the CSS\'s `url()`s work unchanged. `inc/wm-design.php` enqueues them and drops the theme\'s Bootstrap 4 and old stylesheets; the theme\'s other scripts (jQuery, Owl Carousel, match-height) stay. WordPress\'s `wp-block-styles` is turned off, because the design styles core blocks itself.',
    '- **Shell:** `header.php` keeps the theme\'s `<head>` and prints the mockup\'s header. `sidebar.php` and `footer.php` print the mockup\'s sidebar and footer. Menus are WordPress menus with the mockup\'s classes, the user card shows the signed-in user, and the footer keeps everything from `wp_footer()` on.',
    '- **Templates:** each is the mockup\'s own markup. Values are bound to the plan\'s fields (`get_field`), lists to repeaters (`have_rows`) or queries of their post type (`wmd_query`), filter lists to taxonomy terms, and titles, content, images and dates to WordPress\'s own. Text the plan leaves to the template (headings like "View all") stays as written.',
    '- **Blocks:** restyled framework blocks get a new render template; new blocks are registered in `inc/wm-design.php`.',
    '',
    '## What the templates expect (made by the build, B4)',
    '',
    `- Field groups: ${plan.fieldGroups.filter((g) => g.action !== 'reuse').map((g) => g.title).join(', ') || 'none new'}.`,
    `- Post types: ${newTypes.map((t) => `${t.label} (\`${t.name}\`)`).join(', ') || 'none new'}.`,
    `- Menus: ${plan.menus.map((x) => `"${x.name}"`).join(', ') || 'none'}.`,
    '',
  ];
  if (m.files.some((f) => f.lint === 'error')) lines.push('## Lint errors', '', ...m.files.filter((f) => f.lint === 'error').map((f) => `- \`${f.path}\`: ${f.lintMessage}`), '');
  if (m.warnings.length) lines.push('## To check', '', ...m.warnings.map((w) => `- ${w}`), '');
  if (m.missingAssets.length) lines.push('## Missing from the mockups', '', 'The mockup CSS or markup refers to these, but the zip doesn\'t have them (they 404 in the mockup too):', '', ...m.missingAssets.map((a) => `- \`${a}\``), '');
  return lines.join('\n');
}
