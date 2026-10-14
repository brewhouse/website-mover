import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { htmlToBlocks, restrictBlocks, serializeBlocks } from '@wm/blocks';
import { jobPath, readJson, readJsonl, sourceKey, writeJson, type ExtractedPage } from '@wm/core';
import { loadApprovedPlan, type Plan, type PlanItem, type PlanMedia } from '@wm/planner';
import type { WpClient } from '@wm/wp-client';
import { LinkMap, rewriteLinks } from './links.js';
import { probeTarget } from './target.js';

export type EntityKind = 'page' | 'post' | 'document' | 'image';

export interface RunEntity {
  kind: EntityKind;
  id: number;
  /** Root-relative URL on the target. */
  path: string;
  action: 'created' | 'updated';
  warnings: string[];
}

export interface RunState {
  jobId: string;
  planVersion: number;
  approvedBy: string;
  startedAt: string;
  finishedAt: string | null;
  cleanup: Record<string, string>;
  categories: Record<string, number>;
  entities: Record<string, RunEntity>;
  failures: { sourceKey: string; kind: EntityKind; step: string; error: string }[];
  redirects: { from: string; to: string }[];
  redirectImport: { imported: number; skipped: number; failed: number } | null;
}

type Post = { id: number; slug: string; link: string; status: string };
type Media = { id: number; source_url: string };

const stateFile = (jobId: string) => jobPath(jobId, 'run', 'state.json');

export async function loadRunState(jobId: string): Promise<RunState> {
  return readJson<RunState>(stateFile(jobId));
}

/**
 * Executes the approved plan against the target. Idempotent: objects are found again by their
 * `_wm_source_key` and updated in place, so a failed or repeated run can simply be re-run.
 */
export async function executePlan({ jobId, client, log = console.log }: { jobId: string; client: WpClient; log?: (msg: string) => void }): Promise<RunState> {
  const { plan, approval } = await loadApprovedPlan(jobId);
  const pages = new Map((await readJsonl<ExtractedPage>(jobPath(jobId, 'extract', 'pages.jsonl'))).map((p) => [p.sourceKey, p]));
  const events = createWriteStream(jobPath(jobId, 'run', 'events.jsonl'), { flags: 'a' });
  const event = (type: string, data: object = {}) => events.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);

  const state: RunState = {
    jobId,
    planVersion: plan.version,
    approvedBy: approval.approvedBy,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cleanup: {},
    categories: {},
    entities: {},
    failures: [],
    redirects: [],
    redirectImport: null,
  };
  const save = () => writeJson(stateFile(jobId), state);
  const fail = (key: string, kind: EntityKind, step: string, err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    state.failures.push({ sourceKey: key, kind, step, error });
    event('failure', { sourceKey: key, kind, step, error });
    log(`  ✗ ${step} ${key}: ${error}`);
  };
  event('start', { planVersion: plan.version, approvedBy: approval.approvedBy });

  // Preflight: same target, bridge present.
  const { info, existing } = await probeTarget(client, plan.target.name);
  if (info.url !== plan.target.url) throw new Error(`Plan targets ${plan.target.url}, but the client points at ${info.url}`);
  if (JSON.stringify(info.disabledBlocks) !== JSON.stringify(plan.target.disabledBlocks)) {
    log('  ! The target\'s disabled blocks changed since planning; using the planned list');
  }
  const ours = new Map(existing.filter((e) => e.source_key).map((e) => [e.source_key!, e]));
  const meta = (key: string) => ({ _wm_source_key: key, _wm_job_id: jobId });

  // 1. Demo content → trash.
  if (plan.cleanup.length) {
    log(`Cleanup: ${plan.cleanup.length} items to the trash`);
    state.cleanup = await client.post<Record<string, string>>('/website-mover/v1/trash', { ids: plan.cleanup.map((c) => c.id) });
    event('cleanup', { result: state.cleanup });
    await save();
  }

  // 2. Allow ACF values on media over REST (the seed's "Media Library" field group).
  const schema = await client.get<{ acf: { field_groups: { key: string; location: { param: string }[][] }[] } }>('/website-mover/v1/schema');
  const mediaGroup = schema.acf.field_groups.find((g) => g.location.some((rules) => rules.some((r) => r.param === 'attachment')));
  if (mediaGroup) await client.post(`/website-mover/v1/acf/field-groups/${mediaGroup.key}/show-in-rest`, {});

  // 3. Categories.
  const cats = await allPages<{ id: number; name: string }>(client, '/wp/v2/categories');
  for (const name of plan.categories) {
    const found = cats.find((c) => decode(c.name).toLowerCase() === name.toLowerCase());
    state.categories[name] = found ? found.id : (await client.post<{ id: number }>('/wp/v2/categories', { name })).id;
  }
  await save();

  // 4. Media.
  const links = LinkMap.forPlan(plan);
  const images = new Map<string, { id: number; url: string }>();
  const alts = imageAlts(pages);
  log(`Media: ${plan.media.length} files`);
  await mapLimit(plan.media, 3, async (m) => {
    try {
      const entity = await uploadMedia(client, jobId, m, ours.get(m.sourceKey), alts.get(m.sourceKey) ?? '', meta(m.sourceKey));
      state.entities[m.sourceKey] = entity;
      links.add(m, entity.path);
      if (m.type === 'image') images.set(entity.path, { id: entity.id, url: entity.path });
    } catch (err) {
      fail(m.sourceKey, m.type, 'upload', err);
    }
  });
  await save();
  event('media', { done: Object.values(state.entities).length });

  // 5. Pages and posts, as drafts (published together at the end).
  const render = (item: PlanItem) => {
    const page = pages.get(item.sourceKey);
    if (!page) throw new Error('no extracted content');
    const warnings: string[] = [];
    const { html, unresolved } = rewriteLinks(page.contentHtml, links, plan.source.origin);
    if (unresolved.length) warnings.push(`${unresolved.length} link(s) to source content not migrated yet`);
    const blocks = restrictBlocks(
      htmlToBlocks(html, { demoteH1: true, onWarning: (w) => warnings.push(w), resolveImage: (url) => images.get(url) }),
      plan.target.disabledBlocks,
      (w) => warnings.push(w),
    );
    return { content: serializeBlocks(blocks), warnings };
  };
  const posts = new Map<string, Post>();
  const save1 = async (item: PlanItem, status?: string) => {
    const { content, warnings } = render(item);
    const previous = ours.get(item.sourceKey);
    const body = {
      title: item.title,
      slug: item.slug,
      content,
      meta: meta(item.sourceKey),
      ...(status ? { status } : {}),
      ...(item.type === 'post'
        ? { date: item.date ? `${item.date}T00:00:00` : undefined, categories: item.categories.map((c) => state.categories[c]!) }
        : {}),
    };
    const route = item.type === 'post' ? '/wp/v2/posts' : '/wp/v2/pages';
    const post = previous ? await client.post<Post>(`${route}/${previous.id}`, body) : await client.post<Post>(route, body);
    posts.set(item.sourceKey, post);
    const path = post.status === 'publish' ? new URL(post.link).pathname : item.targetPath;
    state.entities[item.sourceKey] = { kind: item.type, id: post.id, path, action: previous ? 'updated' : 'created', warnings };
  };
  log(`Content: ${plan.items.length} pages and posts`);
  await mapLimit(plan.items, 4, async (item) => {
    try {
      await save1(item, ours.get(item.sourceKey) ? undefined : 'draft');
    } catch (err) {
      fail(item.sourceKey, item.type, 'create', err);
    }
  });
  await save();

  // 6. If WordPress gave anything a different slug than planned, fix links to it.
  const moved = plan.items.filter((i) => posts.has(i.sourceKey) && posts.get(i.sourceKey)!.slug !== i.slug);
  if (moved.length) {
    log(`Links: ${moved.length} items got a different slug; updating links to them`);
    for (const item of moved) {
      const path = `/${posts.get(item.sourceKey)!.slug}/`;
      links.add(item, path);
      state.entities[item.sourceKey]!.path = path;
    }
    const movedKeys = new Set(moved.map((m) => m.sourceKey));
    const affected = plan.items.filter((i) => pages.get(i.sourceKey)?.links.some((l) => movedKeys.has(safeKey(l.href))));
    await mapLimit(affected, 4, (item) => save1(item).catch((err) => fail(item.sourceKey, item.type, 'relink', err)));
  }

  // 7. Publish.
  const drafts = plan.items.filter((i) => posts.get(i.sourceKey)?.status === 'draft');
  log(`Publish: ${drafts.length} items`);
  await mapLimit(drafts, 4, async (item) => {
    try {
      const route = item.type === 'post' ? '/wp/v2/posts' : '/wp/v2/pages';
      const post = await client.post<Post>(`${route}/${posts.get(item.sourceKey)!.id}`, { status: 'publish' });
      state.entities[item.sourceKey]!.path = new URL(post.link).pathname;
    } catch (err) {
      fail(item.sourceKey, item.type, 'publish', err);
    }
  });
  await save();

  // 8. Redirects: every changed source URL → its new path.
  for (const entry of [...plan.items, ...plan.media]) {
    const entity = state.entities[entry.sourceKey];
    if (!entity) continue;
    for (const from of entry.redirectFrom) if (from !== entity.path) state.redirects.push({ from, to: entity.path });
  }
  if (info.redirection) state.redirectImport = await importRedirects(client, state.redirects, log);
  state.finishedAt = new Date().toISOString();
  await save();
  event('finish', { entities: Object.keys(state.entities).length, failures: state.failures.length });
  events.end();
  return state;
}

async function uploadMedia(
  client: WpClient,
  jobId: string,
  m: PlanMedia,
  previous: { id: number; link: string } | undefined,
  alt: string,
  meta: Record<string, string>,
): Promise<RunEntity> {
  let id = previous?.id;
  let url = previous?.link;
  if (!id) {
    const data = new Uint8Array(await readFile(jobPath(jobId, m.path)));
    const media = await client.upload<Media>(data, m.filename, m.contentType);
    id = media.id;
    url = media.source_url;
  }
  await client.post(`/wp/v2/media/${id}`, {
    title: m.filename.replace(/\.[a-z0-9]+$/i, ''),
    ...(m.type === 'image' ? { alt_text: alt } : {}),
    meta,
    acf: {
      index_for_library: m.fields.index_for_library,
      ...(m.fields.publication_date ? { publication_date: m.fields.publication_date } : {}),
    },
  });
  return { kind: m.type, id, path: new URL(url!).pathname, action: previous ? 'updated' : 'created', warnings: [] };
}

/** Imports redirects into the Redirection plugin (301, exact query match), skipping ones already there. */
async function importRedirects(client: WpClient, redirects: RunState['redirects'], log: (m: string) => void) {
  const groups = await client.get<{ items: { id: number; name: string }[] }>('/redirection/v1/group');
  const group =
    groups.items.find((g) => g.name === 'Website Mover') ??
    (await client.post<{ items: { id: number; name: string }[] }>('/redirection/v1/group', { name: 'Website Mover', moduleId: 1 })).items.find(
      (g) => g.name === 'Website Mover',
    )!;
  const existing = new Set<string>();
  for (let page = 0; ; page++) {
    const res = await client.get<{ items: { url: string }[]; total: number }>('/redirection/v1/redirect', {
      'filterBy[group]': group.id,
      per_page: 200,
      page,
    });
    for (const r of res.items) existing.add(r.url);
    if (res.items.length < 200) break;
  }
  const result = { imported: 0, skipped: 0, failed: 0 };
  for (const r of redirects) {
    if (existing.has(r.from)) {
      result.skipped++;
      continue;
    }
    try {
      await client.post('/redirection/v1/redirect', {
        status: 'enabled',
        url: r.from,
        match_type: 'url',
        action_type: 'url',
        action_code: 301,
        action_data: { url: r.to },
        group_id: group.id,
        match_data: { source: { flag_query: 'exact', flag_case: true, flag_trailing: true, flag_regex: false } },
      });
      result.imported++;
    } catch {
      result.failed++;
    }
  }
  log(`Redirects: ${result.imported} imported, ${result.skipped} already there, ${result.failed} failed`);
  return result;
}

/** Alt text of each source image, from the pages that use it. */
function imageAlts(pages: Map<string, ExtractedPage>): Map<string, string> {
  const alts = new Map<string, string>();
  for (const page of pages.values()) {
    for (const img of page.images) {
      const key = safeKey(img.src);
      if (img.alt && !alts.has(key)) alts.set(key, img.alt);
    }
  }
  return alts;
}

function safeKey(url: string): string {
  try {
    return sourceKey(url);
  } catch {
    return url;
  }
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"');
}

async function allPages<T>(client: WpClient, route: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const rows = await client.get<T[]>(route, { per_page: 100, page });
    out.push(...rows);
    if (rows.length < 100) return out;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type { Plan };
