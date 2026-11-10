/**
 * `wm design model`: reads the ingested mockups, the framework theme and the target's schema, and
 * writes design/model.json and design/model.md (see model.ts).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jobPath, readJson, writeJson } from '@wm/core';
import { indexFramework } from './framework.js';
import type { Inventory } from './ingest.js';
import { buildModel, type Collection, type DesignModel } from './model.js';
import type { TargetSchema } from './schema.js';

/** The two things the model needs from a WordPress client (WpClient fits). */
export interface SchemaSource {
  baseUrl: string;
  get<T>(path: string): Promise<T>;
}

export interface ModelOptions {
  jobId: string;
  /** The framework theme folder in the site's clone (read-only). */
  themeRoot: string;
  /** The target; omitted: reuse the schema read last time. */
  target?: SchemaSource;
  log?: (msg: string) => void;
}

export async function modelDesign(opts: ModelOptions): Promise<DesignModel> {
  const log = opts.log ?? (() => {});
  const dir = (...p: string[]) => jobPath(opts.jobId, 'design', ...p);
  const inventory = await readJson<Inventory>(dir('inventory.json')).catch(() => {
    throw new Error('Run "wm design ingest" first');
  });

  let schema: TargetSchema;
  if (opts.target) {
    schema = await opts.target.get<TargetSchema>('/website-mover/v1/schema');
    await writeJson(dir('target', 'schema.json'), { readAt: new Date().toISOString(), url: opts.target.baseUrl, schema });
    log(`Target ${opts.target.baseUrl}: ${Object.keys(schema.post_types).length} post types, ${schema.acf?.field_groups.length ?? 0} ACF field groups`);
  } else {
    const cached = await readJson<{ url: string; readAt: string; schema: TargetSchema }>(dir('target', 'schema.json')).catch(() => {
      throw new Error('No target schema yet: give the target (--target)');
    });
    schema = cached.schema;
    log(`Target ${cached.url}: using the schema read ${cached.readAt.slice(0, 16)}`);
  }

  const framework = await indexFramework(path.resolve(opts.themeRoot));
  log(`Framework: ${framework.files.length} theme files, ${framework.files.filter((f) => f.block).length} ACF block templates`);

  const frames = (file: string) => inventory.pages.find((p) => p.file === file)?.frames ?? [];
  const pages = await Promise.all(inventory.pages.map(async (p) => ({ file: p.file, html: await readFile(dir('source', p.file), 'utf8'), frames: frames(p.file) })));
  const model = buildModel({ pages, framework, schema });
  await writeJson(dir('model.json'), model);
  await writeFile(dir('model.md'), renderModel(model, opts.jobId));
  const sections = model.pages.reduce((n, p) => n + p.sections.length, 0);
  log(`Model: ${model.components.length} components in ${sections} sections on ${model.pages.length} pages; ${model.components.filter((c) => c.framework).length} restyle a framework file; ${model.shell.menus.length} menus`);
  log(`Existing post types fit ${model.schema.pages.length} pages and ${model.schema.collections.length} lists`);
  return model;
}

export function renderModel(m: DesignModel, jobId: string): string {
  const out: string[] = [`# Design model: ${jobId}`, ''];
  out.push('## Shell', '', `Content root: \`${m.shell.contentRoot}\`. Landmarks on most pages: ${m.shell.landmarks.map((l) => `\`${l.signature}\` (${l.pages})`).join(', ')}.`, '');
  for (const menu of m.shell.menus) {
    out.push(`**Menu in the ${menu.location}** (\`${menu.signature}\`):`, '');
    const walk = (items: DesignModel['shell']['menus'][number]['items'], depth: number) => {
      for (const i of items) {
        out.push(`${'  '.repeat(depth)}- ${i.label}${i.href && i.href !== '#' ? ` → ${i.href}` : ''}`);
        walk(i.children, depth + 1);
      }
    };
    walk(menu.items, 0);
    out.push('');
  }
  out.push('## Components', '', '| Component | Pages | Headings | Framework file (share of classes) |', '|---|---|---|---|');
  for (const c of m.components) {
    const fw = c.framework ? `${c.framework.file}${c.framework.block ? ` (block \`${c.framework.block}\`)` : ''} ${Math.round(c.framework.share * 100)}%` : 'new';
    out.push(`| \`${c.id}\` | ${c.pages.join(', ')} | ${c.headings.slice(0, 3).join(' / ') || '—'} | ${fw} |`);
  }
  out.push('', '## Pages', '');
  const coll = (c: Collection, depth: number): string[] => [
    `${'  '.repeat(depth)}- ${c.role === 'filters' ? 'filter choices' : 'list'} of ${c.count} \`${c.item}\`${c.path ? ` in \`${c.path}\`` : ''}: ${
      c.leaves
        .filter((l) => l.kind !== 'icon')
        .map((l) => `${l.label} (${l.kind})`)
        .join(', ') || '—'
    }`,
    ...c.collections.flatMap((x) => coll(x, depth + 1)),
  ];
  for (const p of m.pages) {
    out.push(`### ${p.file}${p.frames.length ? ` (frames ${p.frames.join(', ')})` : ''}`, '');
    for (const s of p.sections) {
      const leaves = s.leaves.filter((l) => l.kind !== 'icon');
      const shown = leaves.slice(0, 8).map((l) => `${l.label} ${l.kind}`);
      out.push(`- **${s.component}**${s.heading ? ` "${s.heading}"` : ''}: ${leaves.length} values${leaves.length ? ` (${shown.join(', ')}${leaves.length > 8 ? ', …' : ''})` : ''}`);
      for (const c of s.collections) out.push(...coll(c, 1));
    }
    out.push('');
  }
  out.push('## Existing post types that fit', '');
  for (const p of m.schema.pages) out.push(`- ${p.file} → \`${p.postType}\` (${p.label}) ${p.as}`);
  for (const c of m.schema.collections) out.push(`- list in \`${c.component}\`${c.path ? ` (\`${c.path}\`)` : ''} → \`${c.postType}\` (${c.label})`);
  out.push('');
  return out.join('\n');
}
