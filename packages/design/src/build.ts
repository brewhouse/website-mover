/**
 * B4: builds the approved design plan on the target (docs/build/PLAN.md "Flow" 5). Through the bridge
 * and core REST it creates the ACF post types, taxonomies and field groups, uploads the mockup's
 * images, creates the sample pages and entries with their fields, blocks and terms, writes the menus
 * and sets the front page. Everything it creates is stored natively and tagged with a source key, so
 * a re-run updates what it made rather than duplicating it.
 *
 * Before its first write it records what it will change (design/build/before.json): the existing
 * field groups it extends, the menus it rewrites and the front-page settings. Rollback restores
 * those and trashes what the build created. The theme is not touched: the team commits the theme
 * change set (B3) and reverts it with git.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { acfBlock, htmlToBlocks, serializeBlocks, type Block } from '@wm/blocks';
import { escapeHtml, jobPath, readJson, writeJson } from '@wm/core';
import { WpError, type WpClient } from '@wm/wp-client';
import type { DesignPlan, FieldType, PlanEntry, PlanField, PlanFieldGroup, PlanMenuItemT } from './plan-schema.js';
import { prepareImage } from './media-prep.js';
import { loadApprovedDesignPlan } from './plan-run.js';
import { safeFetch } from '@wm/net';
import { latestThemeChanges, type ThemeManifest } from './theme/theme-run.js';

type AcfItem = Record<string, unknown> & { key: string };
type SchemaGroup = AcfItem & { title: string; fields: AcfItem[] };
interface LiveSchema {
  post_types: Record<string, { label: string; rest_base: string; taxonomies: string[] }>;
  taxonomies: Record<string, { label: string; rest_base: string; object_type: string[]; hierarchical: boolean }>;
  acf: { field_groups: SchemaGroup[]; post_types: AcfItem[]; taxonomies: AcfItem[] } | null;
}
interface MenuItemSnapshot {
  id: number;
  title: string | { raw?: string };
  parent: number;
  menu_order: number;
  type: string;
  object: string;
  object_id: number;
  url: string;
  target: string;
  classes: string[];
}

/** What the build changed that existed before it (design/build/before.json, written once and added to). */
export interface BuildBefore {
  takenAt: string;
  /** Existing field groups the build extends: their full definition, to put back. */
  groups: Record<string, SchemaGroup>;
  /** Menus the build rewrites: null when the build created it. */
  menus: Record<string, { id: number; items: MenuItemSnapshot[] } | null>;
  settings: { show_on_front: string; page_on_front: number } | null;
}

export interface BuildEntity {
  kind: 'media' | 'entry';
  id: number;
  postType: string;
  /** Root-relative URL ('' when there's none). */
  path: string;
  title: string;
}

/** What a build run did (design/build/state.json). */
export interface BuildState {
  jobId: string;
  planVersion: number;
  planSha256: string;
  approvedBy: string;
  /** The target's address, for links to what was built. */
  targetUrl: string;
  startedAt: string;
  finishedAt: string | null;
  /** ACF items the build created (not ones it extended): trashed on rollback. */
  acf: { type: 'acf-post-type' | 'acf-taxonomy' | 'acf-field-group'; key: string }[];
  /** Terms the build created. */
  terms: { taxonomy: string; restBase: string; id: number; name: string }[];
  /** By source key. */
  entities: Record<string, BuildEntity>;
  menus: Record<string, number>;
  /** Fields the build filled on a page it didn't make (the site's front page): emptied on rollback. */
  filled?: { id: number; title: string; keys: string[] }[];
  frontPage: number | null;
  failures: { step: string; error: string }[];
  warnings: string[];
  rolledBackAt?: string | null;
}

const dir = (jobId: string, ...p: string[]) => jobPath(jobId, 'design', ...p);
const KEY_PREFIX = 'design:';
export const mediaKey = (src: string) => `${KEY_PREFIX}media:${src}`;
export const entryKey = (e: PlanEntry) => `${KEY_PREFIX}${e.postType}:${e.source.page}#${e.source.component ?? ''}#${e.source.index ?? ''}`;

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

export async function loadBuildState(jobId: string): Promise<BuildState | null> {
  return readJson<BuildState>(dir(jobId, 'build', 'state.json')).catch(() => null);
}

// ── Plan → ACF definitions ────────────────────────────────────────────────

/** A plan field in ACF's export format. */
export function acfField(f: Omit<PlanField, 'subFields'> & { subFields?: PlanField['subFields'] }): AcfItem {
  const base: AcfItem = { key: f.key, label: f.label, name: f.name, type: f.type };
  switch (f.type) {
    case 'image':
    case 'gallery':
      return { ...base, return_format: 'array', preview_size: 'medium', library: 'all' };
    case 'file':
    case 'link':
      return { ...base, return_format: 'array' };
    case 'post_object':
      return { ...base, post_type: f.relatesTo ? [f.relatesTo] : [], return_format: 'id', allow_null: 1, multiple: 0, ui: 1 };
    case 'repeater':
      return { ...base, layout: 'block', button_label: 'Add Row', sub_fields: (f.subFields ?? []).map((s) => acfField(s)) };
    case 'date_picker':
      return { ...base, display_format: 'F j, Y', return_format: 'F j, Y' };
    case 'true_false':
      return { ...base, ui: 1 };
    default:
      return base;
  }
}

/** A new group, or an existing one with the plan's fields added (all its own fields kept: the bridge replaces the whole group). */
export function groupDefinition(g: PlanFieldGroup, current: SchemaGroup | undefined): AcfItem {
  if (g.action === 'create' || !current) {
    return { key: g.key, title: g.title, location: [[{ param: g.location.param, operator: '==', value: g.location.value }]], fields: g.fields.map((f) => acfField(f)), active: true, show_in_rest: 1, position: 'normal', style: 'default' };
  }
  const fields = current.fields.map((f) => ({ ...f }));
  for (const f of g.fields) {
    const have = fields.find((x) => x.key === f.key);
    if (!have) {
      fields.push(acfField(f));
      continue;
    }
    // A reused repeater can gain sub-fields.
    const subs = [...((have.sub_fields as AcfItem[] | undefined) ?? [])];
    for (const s of f.subFields) if (s.action === 'add' && !subs.some((x) => x.key === s.key)) subs.push(acfField(s));
    if (subs.length) have.sub_fields = subs;
  }
  return { ...current, fields };
}

// ── Values ────────────────────────────────────────────────────────────────

/** "June 22, 2026", "July 2, 2026 @ 6:00 pm – 9:00 pm" → local date-times (null when it's no date). */
export function parseWhen(text: string): { start: string; end: string | null } | null {
  const m = /^\s*([A-Za-z]+\.? \d{1,2},? \d{4})(?:\s*(?:@|at)?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?))?(?:\s*[-–—]\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?))?\s*$/i.exec(text);
  if (!m) return null;
  const day = new Date(`${m[1]!.replace('.', '')} 00:00:00 UTC`);
  if (Number.isNaN(day.getTime())) return null;
  const ymd = day.toISOString().slice(0, 10);
  const time = (t: string | undefined) => {
    if (!t) return null;
    const x = /^(\d{1,2})(?::(\d{2}))?\s*([ap])/i.exec(t)!;
    const h = (Number(x[1]) % 12) + (x[3]!.toLowerCase() === 'p' ? 12 : 0);
    return `${String(h).padStart(2, '0')}:${x[2] ?? '00'}:00`;
  };
  const start = time(m[2]) ?? '09:00:00';
  const end = time(m[3]);
  return { start: `${ymd}T${start}`, end: end ? `${ymd}T${end}` : null };
}

/** The same weekday and time, 52 weeks on at a time, until it's not past. */
export function upcoming(when: { start: string; end: string | null }, now: Date): { start: string; end: string | null } {
  const at = (s: string) => new Date(`${s}Z`).getTime();
  const shift = (s: string, weeks: number) => new Date(at(s) + weeks * 7 * 86_400_000).toISOString().slice(0, 19);
  let weeks = 0;
  while (at(shift(when.start, weeks)) < now.getTime() && weeks < 52 * 50) weeks += 52;
  return weeks ? { start: shift(when.start, weeks), end: when.end ? shift(when.end, weeks) : null } : when;
}

/** Whether a field's stored value has something in it (a link with a title or address, rows, text). */
export function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (Array.isArray(v)) return v.some(hasValue);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('url' in o || 'title' in o) return String(o.title ?? '').trim() !== '' || !['', '#'].includes(String(o.url ?? '').trim());
    return Object.values(o).some(hasValue);
  }
  return String(v).replace(/<[^>]*>/g, '').trim() !== '' || /<img/i.test(String(v));
}

interface ValueContext {
  media: (src: string) => Promise<number | null>;
  entry: (page: string) => number | null;
  link: (href: string) => string;
}

/** A plan sample value as ACF stores it: media as IDs, links with the site's URLs, entries as IDs. */
export async function acfValue(type: FieldType, value: unknown, subTypes: Map<string, FieldType>, ctx: ValueContext): Promise<unknown> {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'image':
    case 'file':
      return typeof value === 'string' ? ctx.media(value) : null;
    case 'gallery':
      return Array.isArray(value) ? (await Promise.all(value.map((v) => (typeof v === 'string' ? ctx.media(v) : null)))).filter((x) => x !== null) : [];
    case 'link': {
      const l = value as { title?: string; url?: string };
      return { title: l.title ?? '', url: ctx.link(l.url ?? '#'), target: '' };
    }
    case 'url':
      return typeof value === 'string' ? ctx.link(value) : null;
    case 'post_object':
    case 'relationship': {
      const ref = value as { entry?: string };
      return ref.entry ? ctx.entry(ref.entry) : null;
    }
    case 'repeater': {
      if (!Array.isArray(value)) return [];
      const rows: Record<string, unknown>[] = [];
      for (const row of value as Record<string, unknown>[]) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) out[k] = await acfValue(subTypes.get(k) ?? 'text', v, subTypes, ctx);
        rows.push(out);
      }
      return rows;
    }
    default:
      return typeof value === 'string' ? value : value;
  }
}

/** An ACF block's stored data: names with their keys under "_name", repeaters flattened as ACF saves them. */
export function blockData(values: Record<string, unknown>, fieldOf: (key: string) => { name: string; type: FieldType; subs: Map<string, string> } | undefined): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const f = fieldOf(key);
    if (!f) continue;
    if (f.type === 'repeater' && Array.isArray(value)) {
      data[f.name] = value.length;
      data[`_${f.name}`] = key;
      value.forEach((row: Record<string, unknown>, i) => {
        for (const [sk, sv] of Object.entries(row)) {
          const sn = f.subs.get(sk);
          if (!sn) continue;
          data[`${f.name}_${i}_${sn}`] = sv;
          data[`_${f.name}_${i}_${sn}`] = sk;
        }
      });
      continue;
    }
    data[f.name] = value;
    data[`_${f.name}`] = key;
  }
  return data;
}

// ── The build ─────────────────────────────────────────────────────────────

export interface BuildOptions {
  jobId: string;
  client: WpClient;
  log?: (msg: string) => void;
}

export async function buildDesign({ jobId, client, log = () => {} }: BuildOptions): Promise<BuildState> {
  const { plan, approval } = await loadApprovedDesignPlan(jobId);
  const status = await client.get<{ bridge?: string; front_page?: number; reserved_slugs?: string[] }>('/website-mover/v1/status').catch((err: unknown) => {
    throw new Error(`The Website Mover bridge isn't reachable on ${client.baseUrl} (${err instanceof Error ? err.message : String(err)}): install and activate it`);
  });
  log(`Target ${client.baseUrl}, bridge ${status.bridge ?? '?'}; design plan v${plan.version} (approved by ${approval.approvedBy})`);

  const previous = await loadBuildState(jobId);
  const state: BuildState = {
    jobId,
    planVersion: plan.version,
    planSha256: approval.planSha256,
    approvedBy: approval.approvedBy,
    targetUrl: client.baseUrl,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    acf: previous && !previous.rolledBackAt ? previous.acf : [],
    terms: previous && !previous.rolledBackAt ? previous.terms : [],
    entities: previous && !previous.rolledBackAt ? previous.entities : {},
    filled: previous && !previous.rolledBackAt ? (previous.filled ?? []) : [],
    menus: {},
    frontPage: null,
    failures: [],
    warnings: [],
    rolledBackAt: null,
  };
  const save = () => writeJson(dir(jobId, 'build', 'state.json'), state);
  const warn = (msg: string) => {
    state.warnings.push(msg);
    log(`  ! ${msg}`);
  };
  const attempt = async <T>(step: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof WpError ? `${err.message}` : err instanceof Error ? err.message : String(err);
      state.failures.push({ step, error });
      log(`  ✗ ${step}: ${error}`);
      return null;
    }
  };

  const theme = await latestThemeChanges(jobId);
  if (theme) {
    const missing = await missingThemeFiles(client.baseUrl, theme);
    if (missing === null) log(`Theme change set v${theme.planVersion}: couldn't check the target's theme files`);
    else if (missing.length) warn(`Theme change set v${theme.planVersion} isn't fully on the target: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''} not found (404). Deploy it before checking the pages${missing.some((f) => f.startsWith('inc/')) ? '; a missing inc/ file the theme loads stops every page' : ''}`);
    else log(`Theme change set v${theme.planVersion}: its library and assets are on the target`);
    if (theme.planVersion !== plan.version) warn(`The latest theme change set is v${theme.planVersion}, but plan v${plan.version} is approved: run "Theme change set" and deploy it`);
  }

  let schema = await client.get<LiveSchema>('/website-mover/v1/schema');
  if (!schema.acf) throw new Error('ACF is not active on the target');
  await snapshotBefore(jobId, plan, schema, client);
  await save();

  // ── ACF post types and taxonomies ──
  for (const pt of plan.postTypes.filter((t) => t.action === 'create')) {
    const key = `post_type_wm_${pt.name}`;
    const ok = await attempt(`post type ${pt.name}`, () =>
      client.post('/website-mover/v1/acf/post-types', {
        key,
        title: pt.label,
        post_type: pt.name,
        labels: { name: pt.label, singular_name: pt.singular },
        public: true,
        show_in_rest: true,
        hierarchical: false,
        has_archive: pt.hasArchive,
        supports: ['title', 'editor', 'thumbnail', 'excerpt', 'custom-fields'],
        taxonomies: pt.taxonomies,
        active: true,
      }),
    );
    if (ok !== null && !state.acf.some((a) => a.key === key)) state.acf.push({ type: 'acf-post-type', key });
    log(`Post type ${pt.name}`);
  }
  for (const tax of plan.taxonomies.filter((t) => t.action === 'create')) {
    const key = `taxonomy_wm_${tax.name}`;
    const ok = await attempt(`taxonomy ${tax.name}`, () =>
      client.post('/website-mover/v1/acf/taxonomies', { key, title: tax.label, taxonomy: tax.name, object_type: tax.postTypes, labels: { name: tax.label, singular_name: tax.label }, public: true, show_in_rest: true, hierarchical: true, active: true }),
    );
    if (ok !== null && !state.acf.some((a) => a.key === key)) state.acf.push({ type: 'acf-taxonomy', key });
    log(`Taxonomy ${tax.name}`);
  }
  await save();
  // ACF registers what it just stored on the next request: read the schema again.
  if (plan.postTypes.some((t) => t.action === 'create') || plan.taxonomies.some((t) => t.action === 'create')) schema = await client.get<LiveSchema>('/website-mover/v1/schema');

  // ── Field groups ──
  const current = new Map(schema.acf!.field_groups.map((g) => [g.key, g]));
  for (const g of plan.fieldGroups) {
    if (g.action === 'reuse' && g.fields.every((f) => f.action === 'reuse' && f.subFields.every((s) => s.action === 'reuse'))) continue;
    const existing = current.get(g.key);
    if (g.action !== 'create' && !existing) {
      warn(`Field group "${g.title}" (${g.key}) isn't on the target any more: skipped`);
      continue;
    }
    if (existing?.local === 'php') {
      warn(`Field group "${g.title}" is defined in code on the target: add its new fields there`);
      continue;
    }
    const ok = await attempt(`field group ${g.title}`, () => client.post('/website-mover/v1/acf/field-groups', groupDefinition(g, existing)));
    if (ok !== null && !existing && !state.acf.some((a) => a.key === g.key)) state.acf.push({ type: 'acf-field-group', key: g.key });
  }
  log(`Field groups: ${plan.fieldGroups.length}`);
  await save();

  // ── Terms ──
  const termIds = new Map<string, number>(); // "taxonomy|name" → id
  const termFor = async (taxonomy: string, name: string): Promise<number | null> => {
    const k = `${taxonomy}|${name}`;
    if (termIds.has(k)) return termIds.get(k)!;
    const base = schema.taxonomies[taxonomy]?.rest_base;
    if (!base) return null;
    const found = (await client.get<{ id: number; name: string }[]>(`/wp/v2/${base}`, { search: name, per_page: 100 })).find((t) => decodeEntities(t.name) === name);
    let id = found?.id;
    if (!id) {
      id = (await client.post<{ id: number }>(`/wp/v2/${base}`, { name })).id;
      state.terms.push({ taxonomy, restBase: base, id, name });
    }
    termIds.set(k, id);
    return id;
  };
  for (const tax of plan.taxonomies) for (const term of tax.terms) await attempt(`term ${tax.name} "${term}"`, () => termFor(tax.name, term));

  // ── Media ──
  const onSite = await client.get<{ id: number; type: string; slug: string; template: string | null; front_page: boolean; source_key: string | null; link: string }[]>('/website-mover/v1/entities');
  const existing = new Map(onSite.filter((e) => e.source_key).map((e) => [e.source_key!, e]));
  // What an earlier run made but the site no longer has (trashed by hand, or the database was
  // restored or cloned from another environment): make it again rather than update a missing ID.
  const ids = new Set(onSite.map((e) => e.id));
  const gone = Object.entries(state.entities).filter(([key, e]) => !ids.has(e.id) || (existing.has(key) && existing.get(key)!.id !== e.id));
  for (const [key] of gone) delete state.entities[key];
  if (gone.length) warn(`${gone.length} of the pages, entries and images an earlier build made aren't on the target any more (database restored or cloned?): made again`);
  /** A page someone else made (B0, the seed, an editor) where the plan puts one: the build leaves it as it is. */
  const othersPage = (e: PlanEntry) => {
    if (e.postType !== 'page' || existing.has(entryKey(e)) || state.entities[entryKey(e)]) return undefined;
    return onSite.find((x) => x.type === 'page' && !x.source_key?.startsWith(KEY_PREFIX) && (e.frontPage ? x.front_page : x.slug === e.slug));
  };
  const source = dir(jobId, 'source');
  const mediaIds = new Map<string, { id: number; url: string }>();
  const mediaFailed = new Set<string>(); // tried once this run: don't fail (or warn) again per use
  const uploadMedia = async (data: Buffer, filename: string, contentType: string, key: string) => {
    const prepared = await prepareImage(data, filename, contentType);
    if (prepared.resized) log(`  ${filename}: ${prepared.resized.width}×${prepared.resized.height}, ${(prepared.resized.bytes / 1024 / 1024).toFixed(1)} MB → ${(prepared.data.length / 1024 / 1024).toFixed(1)} MB ${prepared.filename}`);
    try {
      return await client.upload<{ id: number; source_url: string }>(prepared.data, prepared.filename, prepared.contentType, { 'meta[_wm_source_key]': key, 'meta[_wm_job_id]': jobId });
    } catch (err) {
      // Pantheon answers 502 while WordPress is still making thumbnails: the file may have landed.
      if (err instanceof WpError && ![502, 503, 504].includes(err.status)) throw err;
      const saved = (await client.get<{ id: number; source_key: string | null; link: string }[]>('/website-mover/v1/entities', { types: 'attachment' })).find((e) => e.source_key === key);
      if (!saved) throw err;
      log(`  ${filename}: the upload timed out but arrived`);
      return client.get<{ id: number; source_url: string }>(`/wp/v2/media/${saved.id}`, { context: 'edit', _fields: 'id,source_url' });
    }
  };
  const media = async (src: string): Promise<number | null> => {
    const clean = src.split(/[?#]/)[0]!.replace(/^\.?\//, '');
    if (mediaIds.has(clean)) return mediaIds.get(clean)!.id;
    if (mediaFailed.has(clean)) return null;
    const key = mediaKey(clean);
    const file = path.resolve(source, clean);
    const inMockups = file.startsWith(path.resolve(source) + path.sep) && existsSync(file);
    const onTarget = existing.get(key);
    // An earlier run's upload that timed out (so this build never recorded it) may be the full-size
    // original with thumbnails half made: upload it again, smaller, and trash that one.
    const halfMade = !state.entities[key] && onTarget && inMockups ? onTarget : undefined;
    const had = state.entities[key] ?? (onTarget && !halfMade ? { kind: 'media' as const, id: onTarget.id, postType: 'attachment', path: new URL(onTarget.link, client.baseUrl).pathname, title: clean } : undefined);
    if (had) {
      mediaIds.set(clean, { id: had.id, url: had.path });
      state.entities[key] = had;
      return had.id;
    }
    if (!inMockups) {
      mediaFailed.add(clean);
      warn(`Image ${clean} isn't in the mockups`);
      return null;
    }
    const ext = path.extname(clean).slice(1).toLowerCase();
    const up = await attempt(`upload ${clean}`, async () => uploadMedia(await readFile(file), path.basename(clean), MIME[ext] ?? 'application/octet-stream', key));
    if (!up) {
      mediaFailed.add(clean);
      return null;
    }
    mediaIds.set(clean, { id: up.id, url: up.source_url });
    state.entities[key] = { kind: 'media', id: up.id, postType: 'attachment', path: new URL(up.source_url).pathname, title: path.basename(clean) };
    if (halfMade && halfMade.id !== up.id) await attempt(`trash the earlier upload of ${clean}`, () => client.post('/website-mover/v1/trash', { ids: [halfMade.id] }));
    return up.id;
  };
  for (const m of plan.media) await media(m.src);
  log(`Media: ${plan.media.length} images`);
  await save();

  // ── Entries and pages ──
  const fieldByKey = new Map<string, { name: string; type: FieldType; subs: Map<string, string>; subTypes: Map<string, FieldType> }>();
  for (const g of plan.fieldGroups)
    for (const f of g.fields) fieldByKey.set(f.key, { name: f.name, type: f.type, subs: new Map(f.subFields.map((s) => [s.key, s.name])), subTypes: new Map(f.subFields.map((s) => [s.key, s.type])) });
  const entryIds = new Map<string, number>(); // key → id
  const entryByPage = (page: string) => plan.entries.find((e) => e.source.page === page && e.source.component === null);
  const entryId = (page: string) => {
    const e = entryByPage(page);
    return e ? entryIds.get(entryKey(e)) ?? null : null;
  };
  const link = (href: string) => {
    if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
    const file = href.split(/[?#]/)[0]!.split('/').pop() ?? '';
    const e = file ? entryByPage(file) : undefined;
    const id = e ? entityPath(state, entryKey(e)) : null;
    if (id) return id;
    // A list page a plugin renders (calendar.html → the events archive). WordPress redirects the
    // query to the archive's pretty URL, whatever the plugin's slug is.
    const t = !e && file ? plan.templates.find((x) => x.page === file && x.kind === 'archive' && x.postType) : undefined;
    return t ? `/?post_type=${encodeURIComponent(t.postType!)}` : '#';
  };
  const ctx: ValueContext = { media, entry: entryId, link };
  const fieldValues = async (e: PlanEntry) => {
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.fields)) {
      const f = fieldByKey.get(k);
      if (!f) continue;
      const val = await acfValue(f.type, v, f.subTypes, ctx);
      if (val !== null) values[k] = val;
    }
    return values;
  };
  const restBase = (pt: string) => (pt === 'page' ? 'pages' : pt === 'post' ? 'posts' : schema.post_types[pt]?.rest_base ?? null);
  const termTaxonomy = (pt: string) => plan.taxonomies.find((t) => t.postTypes.includes(pt))?.name ?? (schema.post_types[pt]?.taxonomies ?? []).find((t) => schema.taxonomies[t]?.hierarchical && !['post_format'].includes(t)) ?? null;

  // Pages first (others link to them), then entries that point at entries last.
  const order = [...plan.entries].sort((a, b) => rank(a) - rank(b));
  for (const e of order) {
    const key = entryKey(e);
    const base = restBase(e.postType);
    if (!base) {
      warn(`${e.title}: post type ${e.postType} isn't on the target`);
      continue;
    }
    const theirs = othersPage(e);
    if (theirs) {
      entryIds.set(key, theirs.id);
      if (!e.frontPage) {
        warn(`${e.title}: /${e.slug}/ is already there (page ${theirs.id}${theirs.template ? `, ${theirs.template}` : ''}), not made by this build; it's left as it is and linked to`);
        continue;
      }
      // The site's front page: its template is the mockup's home page, so its empty fields get the
      // mockup's values. Fields that have a value (an editor's, or the seed's) are left as they are.
      await attempt(`front page fields`, async () => {
        const values = await fieldValues(e);
        const keys = Object.keys(values);
        if (!keys.length) return;
        const mine = state.filled!.find((f) => f.id === theirs.id);
        const current = await client.get<Record<string, unknown>>(`/website-mover/v1/acf/posts/${theirs.id}/fields`, { names: keys.join(',') });
        const fill = keys.filter((k) => mine?.keys.includes(k) || !hasValue(current[k]));
        if (fill.length) await client.post(`/website-mover/v1/acf/posts/${theirs.id}/fields`, { values: Object.fromEntries(fill.map((k) => [k, values[k]])) });
        if (mine) mine.keys = [...new Set([...mine.keys, ...fill])];
        else if (fill.length) state.filled!.push({ id: theirs.id, title: e.title, keys: fill });
        warn(`${e.title}: the site’s front page (page ${theirs.id}) isn't made by this build; ${fill.length} of its ${keys.length} fields were empty and got the mockup's values, the rest and its content are left as they are`);
      });
      continue;
    }
    if (e.postType === 'page' && e.slug && status.reserved_slugs?.includes(e.slug)) warn(`${e.title}: /${e.slug}/ is a post type's archive URL on the target, so the page there can't be reached; rename it on review`);
    if (e.postType === 'attachment') {
      warn(`${e.title}: sample documents aren't created (no file in the mockups)`);
      continue;
    }
    await attempt(`${e.postType} "${e.title}"`, async () => {
      const body: Record<string, unknown> = { title: e.title, status: 'publish', meta: { _wm_source_key: key, _wm_job_id: jobId } };
      if (e.slug) body.slug = e.slug;
      if (typeof e.core.excerpt === 'string') body.excerpt = e.core.excerpt;
      const blocks: Block[] = [];
      for (const b of e.blocks) {
        const values: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b.fields)) {
          const f = fieldByKey.get(k);
          if (f) values[k] = await acfValue(f.type, v, f.subTypes, ctx);
        }
        blocks.push(acfBlock(`acf/${b.block}`, blockData(values, (k) => fieldByKey.get(k))));
      }
      if (typeof e.core.content === 'string' && e.core.content.trim()) blocks.push(...htmlToBlocks(/<[a-z]/i.test(e.core.content) ? e.core.content : `<p>${escapeHtml(e.core.content)}</p>`));
      if (blocks.length) body.content = serializeBlocks(blocks);
      if (typeof e.core.featured_image === 'string') {
        const id = await media(e.core.featured_image);
        if (id) body.featured_media = id;
      }
      const when = typeof e.core.date === 'string' ? parseWhen(e.core.date) : null;
      if (when && e.postType !== 'tribe_events') body.date = when.start;
      const terms = Array.isArray(e.core.terms) ? e.core.terms : [];
      const tax = terms.length ? termTaxonomy(e.postType) : null;
      if (tax && schema.taxonomies[tax]) {
        const ids = (await Promise.all(terms.map((t) => termFor(tax, t)))).filter((x): x is number => x !== null);
        if (ids.length) body[schema.taxonomies[tax]!.rest_base] = ids;
      }
      if (e.template) body.template = e.template;

      const had = state.entities[key] ?? existingEntity(existing.get(key), e.postType, client.baseUrl, e.title);
      const route = `/wp/v2/${base}`;
      let post: { id: number; link: string };
      try {
        post = await client.post(had ? `${route}/${had.id}` : route, body);
      } catch (err) {
        // The template isn't in the theme on the target yet (the change set isn't deployed).
        if (!(err instanceof WpError) || !body.template || !/template/i.test(err.message)) throw err;
        warn(`${e.title}: template ${e.template} isn't in the target's theme yet; deploy the theme change set and run the build again`);
        delete body.template;
        post = await client.post(had ? `${route}/${had.id}` : route, body);
      }
      entryIds.set(key, post.id);
      state.entities[key] = { kind: 'entry', id: post.id, postType: e.postType, path: new URL(post.link, client.baseUrl).pathname, title: e.title };

      // Fields (through the bridge, whatever the group's REST setting).
      const values = await fieldValues(e);
      if (Object.keys(values).length) {
        const r = await client.post<Record<string, string>>(`/website-mover/v1/acf/posts/${post.id}/fields`, { values });
        const unknown = Object.entries(r).filter(([, s]) => s === 'unknown field').map(([k]) => k);
        if (unknown.length) warn(`${e.title}: fields not on the target: ${unknown.join(', ')}`);
      }

      // Events: their dates through The Events Calendar.
      if (e.postType === 'tribe_events') {
        if (!when) warn(`${e.title}: "${String(e.core.date ?? '')}" isn't a date, so the event has none`);
        else {
          // A sample event whose date is past moves on by whole years of weeks (same weekday and
          // time), so lists of upcoming events show it.
          const next = upcoming(when, new Date());
          const fmt = (s: string) => s.replace('T', ' ');
          await client.post(`/tribe/events/v1/events/${post.id}`, { start_date: fmt(next.start), end_date: fmt(next.end ?? next.start) }).catch((err: unknown) => warn(`${e.title}: The Events Calendar didn't take its dates (${err instanceof Error ? err.message : String(err)})`));
          if (next.start !== when.start) warn(`${e.title}: the mockup's date (${e.core.date}) is past; the event is on ${next.start.slice(0, 10)} instead (same weekday and time)`);
        }
      }
    });
    if (entryIds.size % 10 === 0) await save();
  }
  // Fields that point at entries made later in the loop: set them again now that all exist.
  for (const e of plan.entries) {
    const refs = Object.entries(e.fields).filter(([, v]) => v && typeof v === 'object' && 'entry' in (v as object));
    const id = entryIds.get(entryKey(e));
    if (!refs.length || !id) continue;
    const values = Object.fromEntries(refs.map(([k, v]) => [k, entryId((v as { entry: string }).entry)]).filter(([, v]) => v !== null));
    if (Object.keys(values).length) await attempt(`links of "${e.title}"`, () => client.post(`/website-mover/v1/acf/posts/${id}/fields`, { values }));
  }
  log(`Pages and entries: ${entryIds.size} of ${plan.entries.length}`);
  await save();

  // ── Menus ──
  const menus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 }).catch(() => [] as { id: number; name: string }[]);
  for (const menu of plan.menus) {
    await attempt(`menu ${menu.name}`, async () => {
      const id = menus.find((m) => m.name === menu.name)?.id ?? (await client.post<{ id: number }>('/wp/v2/menus', { name: menu.name })).id;
      for (let old = await menuItemsOf(client, id); old.length; old = await menuItemsOf(client, id)) for (const item of old) await client.delete(`/wp/v2/menu-items/${item.id}`, { force: 'true' });
      let n = 0;
      const add = async (items: PlanMenuItemT[], parent: number) => {
        for (const item of items) {
          const created = await client.post<{ id: number }>('/wp/v2/menu-items', { title: item.label, menus: id, menu_order: ++n, parent, status: 'publish', ...menuTarget(item, (page) => {
            const id = entryId(page);
            return id ? { id, postType: entryByPage(page)!.postType } : null;
          }, (postType, title) => {
            const e = Object.values(state.entities).find((x) => x.kind === 'entry' && x.postType === postType && x.title === title);
            return e ? { id: e.id, postType } : null;
          }, client.baseUrl) });
          await add(item.children, created.id);
        }
      };
      await add(menu.items, 0);
      state.menus[menu.name] = n;
    });
  }
  log(`Menus: ${Object.entries(state.menus).map(([k, v]) => `${k} (${v})`).join(', ') || 'none'}`);

  // ── Front page ──
  const front = plan.entries.find((e) => e.frontPage);
  const frontId = front ? entryIds.get(entryKey(front)) : undefined;
  if (frontId && frontId !== status.front_page) {
    await attempt('front page', () => client.post('/wp/v2/settings', { show_on_front: 'page', page_on_front: frontId }));
    state.frontPage = frontId;
  }

  state.finishedAt = new Date().toISOString();
  await save();
  log(`Built: ${Object.values(state.entities).filter((x) => x.kind === 'entry').length} pages and entries, ${Object.values(state.entities).filter((x) => x.kind === 'media').length} images, ${state.failures.length} failures, ${state.warnings.length} warnings`);
  return state;
}

/**
 * The change set's files that the target doesn't serve: its inc/ library (which exits at once when
 * opened directly) and its stylesheets and scripts. Templates aren't requested, since opening one
 * outside WordPress is a PHP error. null when the target can't be reached.
 */
export async function missingThemeFiles(baseUrl: string, m: ThemeManifest): Promise<string[] | null> {
  const files = m.files.map((f) => f.path).filter((p) => /^inc\/[\w-]+\.php$/.test(p) || /^assets\/[^/]+\/(css|js)\/[\w.-]+\.(css|js)$/.test(p));
  const missing: string[] = [];
  let reached = false;
  for (const p of files.slice(0, 40)) {
    const url = new URL(`/wp-content/themes/${m.theme}/${p}`, baseUrl);
    const res = await safeFetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!res) continue;
    reached = true;
    if (res.status === 404) missing.push(p);
  }
  return reached || !files.length ? missing : null;
}

const rank = (e: PlanEntry) => (e.postType === 'page' ? 0 : Object.values(e.fields).some((v) => v && typeof v === 'object' && 'entry' in (v as object)) ? 2 : 1);

function entityPath(state: BuildState, key: string): string | null {
  return state.entities[key]?.path ?? null;
}

function existingEntity(e: { id: number; link: string } | undefined, postType: string, base: string, title: string): BuildEntity | undefined {
  return e ? { kind: 'entry', id: e.id, postType, path: new URL(e.link, base).pathname, title } : undefined;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#0?39;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function menuItemsOf(client: WpClient, menu: number) {
  return client.get<MenuItemSnapshot[]>('/wp/v2/menu-items', { menus: menu, per_page: 100, context: 'edit' });
}

/** Where a menu item goes: an entry or page, a post type's archive, the home page, or the mockup's own link. */
export function menuTarget(
  item: PlanMenuItemT,
  entryOf: (page: string) => { id: number; postType: string } | null,
  entryTitled: (postType: string, title: string) => { id: number; postType: string } | null,
  baseUrl: string,
): Record<string, unknown> {
  const [kind, ref] = (item.target ?? '').split(/:(.*)/);
  if (kind === 'front') return { type: 'custom', url: new URL('/', baseUrl).toString() };
  if (kind === 'title' && ref) {
    const [postType, title] = ref.split(/:(.*)/);
    const e = postType && title ? entryTitled(postType, title) : null;
    if (e) return { type: 'post_type', object: e.postType, object_id: e.id };
  }
  if ((kind === 'page' || kind === 'entry') && ref) {
    const e = entryOf(ref);
    if (e) return { type: 'post_type', object: e.postType, object_id: e.id };
  }
  if (kind === 'archive' && ref) return { type: 'post_type_archive', object: ref };
  return { type: 'custom', url: /^(https?:|mailto:|tel:)/i.test(item.href) ? item.href : '#' };
}

// ── Before state and rollback ─────────────────────────────────────────────

async function snapshotBefore(jobId: string, plan: DesignPlan, schema: LiveSchema, client: WpClient): Promise<void> {
  const file = dir(jobId, 'build', 'before.json');
  const before: BuildBefore = (await readJson<BuildBefore>(file).catch(() => null)) ?? { takenAt: new Date().toISOString(), groups: {}, menus: {}, settings: null };
  for (const g of plan.fieldGroups) {
    if (g.action === 'create' || before.groups[g.key]) continue;
    const cur = schema.acf?.field_groups.find((x) => x.key === g.key);
    if (cur) before.groups[g.key] = cur;
  }
  const menus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 }).catch(() => [] as { id: number; name: string }[]);
  for (const m of plan.menus) {
    if (m.name in before.menus) continue;
    const had = menus.find((x) => x.name === m.name);
    before.menus[m.name] = had ? { id: had.id, items: await menuItemsOf(client, had.id) } : null;
  }
  if (!before.settings && plan.entries.some((e) => e.frontPage)) {
    const s = await client.get<{ show_on_front: string; page_on_front: number }>('/wp/v2/settings');
    before.settings = { show_on_front: s.show_on_front, page_on_front: s.page_on_front };
  }
  await writeJson(file, before);
}

export interface BuildRollbackResult {
  trashed: number;
  terms: number;
  acf: number;
  groupsRestored: number;
  menus: number;
  problems: string[];
}

/** Puts the target back as it was before the build: see the file header. */
export async function rollbackDesignBuild({ jobId, client, log = () => {} }: BuildOptions): Promise<BuildRollbackResult> {
  const state = await loadBuildState(jobId);
  if (!state) throw new Error(`Nothing to roll back: ${jobId} hasn't been built`);
  if (state.rolledBackAt) throw new Error(`The build was already rolled back (${state.rolledBackAt})`);
  const before = await readJson<BuildBefore>(dir(jobId, 'build', 'before.json')).catch(() => null);
  const r: BuildRollbackResult = { trashed: 0, terms: 0, acf: 0, groupsRestored: 0, menus: 0, problems: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      const msg = `${name}: ${err instanceof Error ? err.message : String(err)}`;
      r.problems.push(msg);
      log(`  ✗ ${msg}`);
    }
  };

  if (before?.settings) await step('front page', async () => void (await client.post('/wp/v2/settings', before.settings!)));

  for (const [name, had] of Object.entries(before?.menus ?? {})) {
    await step(`menu ${name}`, async () => {
      const menus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 });
      const now = menus.find((m) => m.name === name);
      if (!had) {
        if (now) await client.delete(`/wp/v2/menus/${now.id}`, { force: 'true' });
      } else {
        const id = now?.id ?? had.id;
        for (let old = await menuItemsOf(client, id); old.length; old = await menuItemsOf(client, id)) for (const item of old) await client.delete(`/wp/v2/menu-items/${item.id}`, { force: 'true' });
        const ids = new Map<number, number>();
        for (const item of [...had.items].sort((a, b) => a.menu_order - b.menu_order)) {
          const target = item.type === 'custom' ? { type: 'custom', url: item.url } : item.type === 'post_type_archive' ? { type: item.type, object: item.object } : { type: item.type, object: item.object, object_id: item.object_id };
          const c = await client.post<{ id: number }>('/wp/v2/menu-items', { title: decodeEntities(typeof item.title === 'string' ? item.title : (item.title.raw ?? '')), menus: id, menu_order: item.menu_order, parent: ids.get(item.parent) ?? 0, status: 'publish', target: item.target, classes: item.classes, ...target });
          ids.set(item.id, c.id);
        }
      }
      r.menus++;
    });
  }

  for (const f of state.filled ?? []) await step(`fields of ${f.title}`, async () => {
    await client.post(`/website-mover/v1/acf/posts/${f.id}/fields`, { values: Object.fromEntries(f.keys.map((k) => [k, null])) });
  });

  const ids = Object.values(state.entities).map((e) => e.id);
  if (ids.length) await step('trash', async () => {
    const res = await client.post<Record<string, string>>('/website-mover/v1/trash', { ids });
    r.trashed = Object.values(res).filter((s) => s === 'trashed').length;
  });
  for (const t of state.terms) await step(`term ${t.name}`, async () => {
    await client.delete(`/wp/v2/${t.restBase}/${t.id}`, { force: 'true' });
    r.terms++;
  });

  for (const def of Object.values(before?.groups ?? {})) await step(`field group ${def.title}`, async () => {
    await client.post('/website-mover/v1/acf/field-groups', def);
    r.groupsRestored++;
  });
  for (const type of ['acf-field-group', 'acf-taxonomy', 'acf-post-type'] as const) {
    const keys = state.acf.filter((a) => a.type === type).map((a) => a.key);
    if (keys.length) await step(type, async () => {
      const res = await client.post<Record<string, string>>('/website-mover/v1/acf/trash', { type, keys });
      r.acf += Object.values(res).filter((s) => s === 'trashed').length;
    });
  }

  state.rolledBackAt = new Date().toISOString();
  await writeJson(dir(jobId, 'build', 'state.json'), state);
  // The next build takes a fresh snapshot.
  await writeJson(dir(jobId, 'build', `before-${state.rolledBackAt.replace(/[:.]/g, '-')}.json`), before ?? {});
  await writeJson(dir(jobId, 'build', 'before.json'), { takenAt: '', groups: {}, menus: {}, settings: null }).catch(() => {});
  log(`Rolled back: ${r.trashed} trashed, ${r.terms} terms, ${r.groupsRestored} field groups restored, ${r.acf} ACF items trashed, ${r.menus} menus, ${r.problems.length} problems`);
  return r;
}
