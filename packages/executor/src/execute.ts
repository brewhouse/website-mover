import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { blocksToHtml, externalBlock, htmlToBlocks, loadWordPress, restrictBlocks, serializeBlocks, type Block } from '@wm/blocks';
import { escapeHtml, jobPath, readJson, readJsonl, sourceKey, writeJson, type ExtractedPage } from '@wm/core';
import { loadApprovedPlan, wpSlug, type Plan, type PlanContentType, type PlanItem, type PlanMedia, type PlanRecord, type TargetEntity } from '@wm/planner';
import { WpError, type WpClient } from '@wm/wp-client';
import { LinkMap, rewriteLinks } from './links.js';
import { probeTarget } from './target.js';
import { snapshotBefore, type PageFields } from './rollback.js';

export type EntityKind = 'page' | 'post' | 'document' | 'image' | 'event' | 'person' | 'form' | 'record';

export interface RunEntity {
  kind: EntityKind;
  id: number;
  /** Root-relative URL on the target ('' for objects without one, e.g. forms). */
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
  settings: Record<string, string>;
  categories: Record<string, number>;
  entities: Record<string, RunEntity>;
  failures: { sourceKey: string; kind: EntityKind | 'redirects' | 'setup'; step: string; error: string }[];
  redirects: { from: string; to: string }[];
  redirectImport: { imported: number; updated: number; skipped: number; failed: number } | null;
  /** Site structure applied (M3): menu name → item count, options result, homepage slides set. */
  site: { menus: Record<string, number>; options: Record<string, string>; homeSlides: number; homeQuickLinks?: number; warnings: string[] } | null;
}

type Post = { id: number; slug: string; link: string; status: string; meta?: Record<string, unknown> };
type Media = { id: number; source_url: string };
export type SeedField = { name: string; type?: string; choices?: Record<string, string>; min?: number | string; max?: number | string };
/** An ACF field group as the bridge's schema lists it. `local` is 'php' for groups defined in code, 'json' for acf-json ones. */
export type SeedGroup = { key: string; title?: string; local?: string | false; show_in_rest?: number | boolean; location: { param: string; value: string }[][]; fields: SeedField[] };
type Schema = {
  post_types: Record<string, { rest_base: string }>;
  acf: { field_groups: SeedGroup[] };
};

/**
 * A page template's field groups: for the homepage, the seed's Homepage Details plus any the theme adds
 * in code (T9). ACF locates them by "Page Template" or by the newer "Post Template" rule.
 */
export function templateGroupsOf(groups: SeedGroup[], template: string): SeedGroup[] {
  return groups.filter((g) => g.location.some((rules) => rules.some((r) => (r.param === 'page_template' || r.param === 'post_template') && r.value === template)));
}

export function homeGroupsOf(groups: SeedGroup[]): SeedGroup[] {
  return templateGroupsOf(groups, 'template-home.php');
}

/** Clears a template's text fields: on kept framework pages they hold the seed's demo content. */
export function clearedTextFields(fields: SeedField[]): Record<string, string> {
  return Object.fromEntries(fields.filter((f) => f.name && ['text', 'textarea', 'wysiwyg', 'email', 'url'].includes(f.type ?? '')).map((f) => [f.name, '']));
}

/**
 * The groups whose fields can be read and written through REST: "Show in REST API" is turned on for
 * the others. A group defined in PHP can't be changed that way (saving it would store a copy in the
 * database), so one without it is left out, with a warning. acf-json groups save normally.
 */
export async function restGroups(client: WpClient, groups: SeedGroup[], warn: (msg: string) => void): Promise<SeedGroup[]> {
  const usable: SeedGroup[] = [];
  for (const g of groups) {
    if (g.show_in_rest) usable.push(g);
    else if (g.local === 'php') warn(`The field group "${g.title ?? g.key}" is defined in code without "Show in REST API", so its fields (${g.fields.map((f) => f.name).filter(Boolean).join(', ')}) aren't set.`);
    else {
      await client.post(`/website-mover/v1/acf/field-groups/${g.key}/show-in-rest`, {});
      usable.push(g);
    }
  }
  return usable;
}

/**
 * Anything created as post-type content with block content: pages, posts, table pages, listing
 * pages and custom-type entries. They are created as drafts, published together, then relinked.
 */
interface ContentDoc {
  key: string;
  kind: 'page' | 'post' | 'record';
  /** Core REST collection route, e.g. /wp/v2/pages. */
  route: string;
  postType: string;
  slug: string;
  targetPath: string;
  build: () => { body: Record<string, unknown>; warnings: string[] };
  /** Source keys this doc links to, for relinking when one of them gets a different URL. */
  linksTo: Set<string>;
}

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
  // Loading the block library blocks the event loop for seconds. Do it before any request, or
  // pooled connections the server closes meanwhile get reused and writes fail ("other side closed").
  loadWordPress();
  // The approval covers the plan, and the plan records the hashes of the content it was built from.
  const extractFile = jobPath(jobId, 'extract', 'pages.jsonl');
  if ((await fileSha256(extractFile)) !== plan.inputs.extractSha256) {
    throw new Error('The extracted content changed after this plan was made: run "wm plan" and approve again');
  }
  for (const [name, sha] of Object.entries(plan.inputs.analysisSha256)) {
    if ((await fileSha256(jobPath(jobId, 'analyze', `${name}.json`)).catch(() => '')) !== sha) {
      throw new Error(`The ${name} analysis changed after this plan was made: run "wm plan" and approve again`);
    }
  }
  const pages = new Map((await readJsonl<ExtractedPage>(extractFile)).map((p) => [p.sourceKey, p]));
  await mkdir(jobPath(jobId, 'run'), { recursive: true });
  const events = createWriteStream(jobPath(jobId, 'run', 'events.jsonl'), { flags: 'a' });
  const event = (type: string, data: object = {}) => events.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`);

  const state: RunState = {
    jobId,
    planVersion: plan.version,
    approvedBy: approval.approvedBy,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cleanup: {},
    settings: {},
    categories: {},
    entities: {},
    failures: [],
    redirects: [],
    redirectImport: null,
    site: null,
  };
  const save = () => writeJson(stateFile(jobId), state);
  const fail = (key: string, kind: RunState['failures'][number]['kind'], step: string, err: unknown) => {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const error = (err instanceof Error ? err.message : String(err)) + (cause ? ` (${cause.code ?? ''} ${cause.message ?? ''})`.replace('( ', '(') : '');
    state.failures.push({ sourceKey: key, kind, step, error });
    event('failure', { sourceKey: key, kind, step, error });
    log(`  ✗ ${step} ${key}: ${error}`);
  };
  const action = (previous: TargetEntity | undefined) => (previous && previous.job_id !== jobId ? 'updated' : 'created');
  event('start', { planVersion: plan.version, approvedBy: approval.approvedBy });

  // Preflight: same target, bridge present.
  const { info, existing } = await probeTarget(client, plan.target.name);
  if (info.url !== plan.target.url) throw new Error(`Plan targets ${plan.target.url}, but the client points at ${info.url}`);
  if (JSON.stringify(info.disabledBlocks) !== JSON.stringify(plan.target.disabledBlocks)) {
    log('  ! The target\'s disabled blocks changed since planning; using the planned list');
  }
  const ours = new Map(existing.filter((e) => e.source_key).map((e) => [e.source_key!, e]));
  const meta = (key: string) => ({ _wm_source_key: key, _wm_job_id: jobId });

  // 0. What the job will change on the site structure, as it is now (once: rollback restores it).
  try {
    const before = await client.get<Schema>('/website-mover/v1/schema');
    const homeFields = (plan.site ? await restGroups(client, homeGroupsOf(before.acf.field_groups), log) : []).flatMap((g) => g.fields);
    // Kept framework pages: only the text fields the job clears, read through the bridge.
    const pages: PageFields[] = (plan.site?.clearPages ?? []).map((p) => ({
      pageId: p.pageId,
      fields: Object.keys(clearedTextFields(templateGroupsOf(before.acf.field_groups, p.template).flatMap((g) => g.fields))).map((name) => ({ name })),
    }));
    await snapshotBefore(client, jobId, plan, { pageId: existing.find((e) => e.front_page)?.id ?? null, fields: homeFields }, pages);
  } catch (err) {
    // Nothing has changed yet: stop rather than change the site with no way to restore it.
    throw new Error(`Couldn't save the site structure before changing it (rollback needs it): ${(err as Error).message}`);
  }

  // 1. Demo content → trash.
  if (plan.cleanup.length) {
    log(`Cleanup: ${plan.cleanup.length} items to the trash`);
    state.cleanup = await client.post<Record<string, string>>('/website-mover/v1/trash', { ids: plan.cleanup.map((c) => c.id) });
    event('cleanup', { result: state.cleanup });
    await save();
  }

  // 2. Site settings (e.g. timezone, so event times are local).
  for (const s of plan.settings) {
    try {
      await client.post('/wp/v2/settings', { [s.key]: s.to });
      state.settings[s.key] = s.to;
    } catch (err) {
      fail(s.key, 'setup', 'setting', err);
    }
  }

  // 3. Content types created through ACF (stored natively), then ACF values over REST on the field
  //    groups we write to (media library, people, the new types).
  for (const ct of plan.contentTypes) {
    try {
      await createContentType(client, ct, plan.records.filter((r) => r.postType === ct.postType));
    } catch (err) {
      fail(ct.postType, 'setup', 'content-type', err);
    }
  }
  const schema = await client.get<Schema>('/website-mover/v1/schema');
  const groupFor = (param: string, value?: string) =>
    schema.acf.field_groups.find((g) => g.location.some((rules) => rules.some((r) => r.param === param && (value === undefined || r.value === value))));
  for (const g of [groupFor('attachment'), plan.people.length ? groupFor('post_type', 'people') : undefined]) {
    if (g) await client.post(`/website-mover/v1/acf/field-groups/${g.key}/show-in-rest`, {});
  }
  const libraryChoices = new Map(
    Object.entries(groupFor('attachment')?.fields.find((f) => f.name === 'library_select')?.choices ?? {}).map(([value, label]) => [label, value]),
  );
  const restBase = (postType: string) => schema.post_types[postType]?.rest_base ?? postType;

  // 4. Terms: news categories, event categories, document types, community types.
  const terms = async (taxonomy: string, names: string[]) => {
    const ids: Record<string, number> = {};
    if (!names.length) return ids;
    const found = await allPages<{ id: number; name: string }>(client, `/wp/v2/${taxonomy}`);
    for (const name of names) {
      const match = found.find((c) => decode(c.name).toLowerCase() === name.toLowerCase());
      try {
        ids[name] = match ? match.id : (await client.post<{ id: number }>(`/wp/v2/${taxonomy}`, { name })).id;
      } catch (err) {
        fail(`${taxonomy}:${name}`, 'setup', 'term', err);
      }
    }
    return ids;
  };
  state.categories = await terms('categories', plan.categories);
  const eventCats = await terms('tribe_events_cat', plan.eventCategories);
  const docTypes = await terms('resource_type', plan.documentTypes);
  const recordTerms: Record<string, Record<string, number>> = {};
  for (const ct of plan.contentTypes) {
    if (ct.taxonomy) {
      const names = [...new Set(plan.records.filter((r) => r.postType === ct.postType && r.term).map((r) => r.term!))];
      recordTerms[ct.postType] = await terms(ct.taxonomy.name, names);
    }
  }
  await save();

  // 5. Media.
  const links = LinkMap.forPlan(plan);
  const images = new Map<string, { id: number; url: string }>();
  const mediaByKey = new Map<string, RunEntity>();
  const alts = imageAlts(pages);
  log(`Media: ${plan.media.length} files`);
  await mapLimit(plan.media, 3, async (m) => {
    try {
      const fields = {
        resource_type: m.documentType && docTypes[m.documentType] ? [docTypes[m.documentType]!] : undefined,
        library_select: m.fields.library_select ? libraryChoices.get(m.fields.library_select) ?? m.fields.library_select : null,
      };
      const entity = await uploadMedia(client, jobId, m, ours.get(m.sourceKey), alts.get(m.sourceKey) ?? '', meta(m.sourceKey), fields);
      state.entities[m.sourceKey] = entity;
      links.add(m, entity.path);
      for (const key of [m.sourceKey, ...m.redirectFrom.map((r) => safeKey(new URL(r, plan.source.origin).href))]) mediaByKey.set(key, entity);
      if (m.type === 'image') images.set(entity.path, { id: entity.id, url: entity.path });
    } catch (err) {
      fail(m.sourceKey, m.type, 'upload', err);
    }
  });
  await save();
  event('media', { done: Object.values(state.entities).length });
  const mediaId = (url: string | null) => (url ? mediaByKey.get(safeKey(url))?.id : undefined);

  // 6. Forms (needed before the pages that hold them).
  const formIds = new Map<string, number>();
  for (const f of plan.forms.filter((x) => x.action === 'rebuild')) {
    try {
      const res = await client.post<{ id: number }>('/website-mover/v1/forms', {
        source_key: f.key,
        title: f.title,
        description: f.description ?? '',
        fields: f.fields,
        sensitive_fields: f.sensitive,
        captcha: f.captcha,
        ...(f.retentionDays ? { retention_days: f.retentionDays } : {}),
      });
      formIds.set(f.key, res.id);
      state.entities[f.key] = { kind: 'form', id: res.id, path: '', action: action(ours.get(f.key)), warnings: [] };
    } catch (err) {
      fail(f.key, 'form', 'form', err);
    }
  }

  // 7. Content documents: pages, posts, table pages, listing pages, custom-type entries.
  const convert = (html: string, warnings: string[], formsInOrder: number[] = []) => {
    // Only forms that were rebuilt are swapped for their block; any other form stays as it was.
    if (!formsInOrder.length && /<form\b/i.test(html)) warnings.push('form-not-rebuilt: the page has a form that is not rebuilt; kept as HTML');
    const marked = formsInOrder.length ? withFormMarkers(html) : html;
    const { html: rewritten, unresolved } = rewriteLinks(marked, links, plan.source.origin);
    if (unresolved.length) warnings.push(`${unresolved.length} link(s) to source content not migrated yet`);
    let blocks = restrictBlocks(
      htmlToBlocks(rewritten, { demoteH1: true, onWarning: (w) => warnings.push(w), resolveImage: (url) => images.get(url) }),
      plan.target.disabledBlocks,
      (w) => warnings.push(w),
    );
    blocks = placeForms(blocks, formsInOrder);
    return serializeBlocks(blocks);
  };
  const linkedKeys = (page: ExtractedPage | undefined) =>
    new Set([...(page?.links ?? []), ...(page?.documents ?? [])].map((l) => safeKey(l.href)));
  const docs: ContentDoc[] = [];
  for (const item of plan.items) {
    const page = pages.get(item.sourceKey);
    docs.push({
      key: item.sourceKey,
      kind: item.type,
      route: item.type === 'post' ? '/wp/v2/posts' : '/wp/v2/pages',
      postType: item.type,
      slug: item.slug,
      targetPath: item.targetPath,
      linksTo: linkedKeys(page),
      build: () => {
        if (!page) throw new Error('no extracted content');
        const warnings: string[] = [];
        const forms = item.forms.map((k) => formIds.get(k)).filter((id): id is number => id !== undefined);
        const content = convert(page.contentHtml, warnings, forms);
        const extra = item.type === 'post' ? { ...postDate(item.date), categories: item.categories.map((c) => state.categories[c]).filter(Boolean) } : {};
        return { body: { title: item.title, content, ...extra }, warnings };
      },
    });
  }
  for (const table of plan.tables) {
    docs.push({
      key: `table:${table.key}`,
      kind: 'page',
      route: '/wp/v2/pages',
      postType: 'page',
      slug: table.slug,
      targetPath: table.targetPath,
      linksTo: new Set(),
      build: () => {
        const warnings: string[] = [];
        const head = `<thead><tr>${table.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
        const body = `<tbody>${table.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
        const notes = table.notes.map((n) => `<p>${escapeHtml(n)}</p>`).join('');
        return { body: { title: table.title, content: convert(`${notes}<table>${head}${body}</table>`, warnings) }, warnings };
      },
    });
  }
  for (const ct of plan.contentTypes) {
    const entries = plan.records.filter((r) => r.postType === ct.postType).sort((a, b) => a.title.localeCompare(b.title));
    docs.push({
      key: `listing:${ct.postType}`,
      kind: 'page',
      route: '/wp/v2/pages',
      postType: 'page',
      slug: ct.listing.slug,
      targetPath: ct.listing.targetPath,
      linksTo: new Set(entries.map((r) => r.sourceKey)),
      build: () => {
        const warnings: string[] = [];
        const path = (r: PlanRecord) => state.entities[r.sourceKey]?.path || r.targetPath;
        const list = `<ul>${entries.map((r) => `<li><a href="${escapeHtml(path(r))}">${escapeHtml(r.title)}</a></li>`).join('')}</ul>`;
        return { body: { title: ct.listing.title, content: convert(list, warnings) }, warnings };
      },
    });
    for (const r of entries) {
      const page = pages.get(r.sourceKey);
      docs.push({
        key: r.sourceKey,
        kind: 'record',
        route: `/wp/v2/${restBase(ct.postType)}`,
        postType: ct.postType,
        slug: r.slug,
        targetPath: r.targetPath,
        linksTo: linkedKeys(page),
        build: () => {
          const warnings: string[] = [];
          const termId = r.term ? recordTerms[ct.postType]?.[r.term] : undefined;
          const photo = mediaId(r.photo);
          return {
            body: {
              title: r.title,
              content: convert(page?.contentHtml ?? '', warnings),
              acf: r.fields,
              ...(ct.taxonomy && termId ? { [ct.taxonomy.name]: [termId] } : {}),
              ...(photo ? { featured_media: photo } : {}),
            },
            warnings,
          };
        },
      });
    }
  }

  const posts = new Map<string, Post>();
  const saveDoc = async (doc: ContentDoc, status?: string) => {
    const { body, warnings } = doc.build();
    // An earlier object of another type (the reviewer switched page ↔ post) is trashed by cleanup.
    const previous = ours.get(doc.key)?.type === doc.postType ? ours.get(doc.key) : undefined;
    const full = { ...body, slug: doc.slug, meta: meta(doc.key), ...(status ? { status } : {}) };
    const post = previous
      ? await client.post<Post>(`${doc.route}/${previous.id}`, full)
      : await createOnce(client, doc.route, full, doc.key, doc.postType);
    await assertTagged(client, post, doc.key, doc.postType);
    posts.set(doc.key, post);
    const path = post.status === 'publish' ? new URL(post.link).pathname : doc.targetPath;
    state.entities[doc.key] = { kind: doc.kind, id: post.id, path, action: action(previous), warnings };
  };
  // Custom-type entries first, so the listing page links to their real URLs.
  const docOrder = (d: ContentDoc) => (d.kind === 'record' ? 0 : 1);
  log(`Content: ${docs.length} pages, posts and entries`);
  for (const group of [docs.filter((d) => docOrder(d) === 0), docs.filter((d) => docOrder(d) === 1)]) {
    await mapLimit(group, 4, async (doc) => {
      try {
        await saveDoc(doc, ours.get(doc.key)?.type === doc.postType ? undefined : 'draft');
      } catch (err) {
        fail(doc.key, doc.kind, 'create', err);
      }
    });
  }
  await save();

  // 8. People.
  if (plan.people.length) log(`People: ${plan.people.length}`);
  for (const person of plan.people) {
    try {
      const previous = ours.get(person.key);
      const photo = mediaId(person.photo);
      const body = {
        title: person.name,
        slug: person.slug,
        status: 'publish',
        meta: meta(person.key),
        ...(photo ? { featured_media: photo } : {}),
        acf: {
          title: person.role ?? '',
          email: person.email ? [{ email_label: '', email: person.email }] : [],
          phone: person.phone ? [{ phone_label: '', phone_number: person.phone }] : [],
          biography: person.bio ?? '',
        },
      };
      const route = `/wp/v2/${restBase('people')}`;
      const post = previous ? await client.post<Post>(`${route}/${previous.id}`, body) : await createOnce(client, route, body, person.key, 'people');
      await assertTagged(client, post, person.key, 'people');
      // The framework's people type has no public page: people appear through blocks on pages.
      state.entities[person.key] = { kind: 'person', id: post.id, path: '', action: action(previous), warnings: [] };
    } catch (err) {
      fail(person.key, 'person', 'create', err);
    }
  }

  // 9. Events (The Events Calendar). Its classic editor stores HTML, so descriptions are the
  //    converted content rendered without block markup.
  if (plan.events.length) log(`Events: ${plan.events.length}`);
  const itemsByKey = new Map(plan.items.map((i) => [i.sourceKey, i]));
  await mapLimit(plan.events, 3, async (ev) => {
    try {
      const warnings: string[] = [];
      const parts = ev.sourceKeys.map((k) => pages.get(k)).filter((p): p is ExtractedPage => !!p);
      let html = parts.map((p, i) => (i === 0 ? '' : `<h2>${escapeHtml(p.title)}</h2>`) + p.contentHtml).join('\n');
      const news = ev.newsKeys.map((k) => itemsByKey.get(k)).filter((i): i is PlanItem => !!i);
      if (news.length) html += `<h2>News</h2><ul>${news.map((n) => `<li><a href="${escapeHtml(n.sourceUrl)}">${escapeHtml(n.title)}</a></li>`).join('')}</ul>`;
      const { html: rewritten, unresolved } = rewriteLinks(html, links, plan.source.origin);
      if (unresolved.length) warnings.push(`${unresolved.length} link(s) to source content not migrated yet`);
      const description = blocksToHtml(htmlToBlocks(rewritten, { demoteH1: true, resolveImage: (url) => images.get(url) }));
      const [start, end, allDay] = ev.startTime
        ? [`${ev.date} ${ev.startTime}:00`, `${ev.date} ${ev.endTime ?? ev.startTime}:00`, false]
        : [`${ev.date} 00:00:00`, `${ev.date} 23:59:59`, true];
      const body = {
        title: ev.title,
        slug: ev.slug,
        status: 'publish',
        description,
        start_date: start,
        end_date: end,
        all_day: allDay,
        categories: eventCats[ev.category] ? [eventCats[ev.category]] : [],
      };
      const previous = ours.get(ev.key);
      const created = previous
        ? await client.post<{ id: number; url: string }>(`/tribe/events/v1/events/${previous.id}`, body)
        : await client.post<{ id: number; url: string }>('/tribe/events/v1/events', body);
      // Tag it (The Events Calendar's API has no meta field).
      await assertTagged(client, await client.post<Post>(`/wp/v2/tribe_events/${created.id}`, { meta: meta(ev.key) }), ev.key, 'tribe_events');
      if (ev.cancelled) warnings.push('cancelled: the source says this meeting was cancelled; set the event status by hand');
      state.entities[ev.key] = { kind: 'event', id: created.id, path: new URL(created.url).pathname, action: action(previous), warnings };
    } catch (err) {
      fail(ev.key, 'event', 'create', err);
    }
  });
  await save();

  // 9b. Site structure: title, theme options, homepage fields, menus (after everything they link to exists).
  if (plan.site) {
    state.site = await applySite(client, plan, state, {
      frontPage: existing.find((e) => e.front_page)?.id ?? null,
      fieldGroups: schema.acf.field_groups,
      mediaId,
      html: (html) => rewriteLinks(html, links, plan.source.origin),
      postTypeOf: (key) => plan.records.find((r) => r.sourceKey === key)?.postType ?? (plan.items.find((i) => i.sourceKey === key)?.type === 'post' ? 'post' : 'page'),
      fail: (step, err) => fail('site', 'setup', step, err),
      log,
    });
  }

  // 10. Publish the drafts.
  const drafts = docs.filter((d) => posts.get(d.key)?.status === 'draft');
  log(`Publish: ${drafts.length} items`);
  await mapLimit(drafts, 4, async (doc) => {
    try {
      const post = await client.post<Post>(`${doc.route}/${posts.get(doc.key)!.id}`, { status: 'publish' });
      posts.set(doc.key, post);
      state.entities[doc.key]!.path = new URL(post.link).pathname;
    } catch (err) {
      fail(doc.key, doc.kind, 'publish', err);
    }
  });
  await save();

  // 11. WordPress makes slugs unique only on publish (and events get theirs from The Events
  //     Calendar): if anything got a different URL than planned, point links at the real one.
  const planned = new Map<string, { path: string; sourceKeys: string[]; redirectFrom: string[] }>();
  for (const d of docs) planned.set(d.key, { path: d.targetPath, sourceKeys: [d.key], redirectFrom: entryRedirects(plan, d.key) });
  for (const ev of plan.events) planned.set(ev.key, { path: ev.targetPath, sourceKeys: ev.sourceKeys, redirectFrom: ev.redirectFrom });
  const moved = [...planned].filter(([key, p]) => state.entities[key] && state.entities[key]!.path !== p.path);
  if (moved.length) {
    log(`Links: ${moved.length} items got a different URL than planned; updating links to them`);
    const movedKeys = new Set<string>();
    for (const [key, p] of moved) {
      const path = state.entities[key]!.path;
      links.set(key, path);
      links.addPaths(p.redirectFrom, path);
      for (const k of p.sourceKeys) movedKeys.add(k);
    }
    const affected = docs.filter((d) => [...d.linksTo].some((k) => movedKeys.has(k)));
    await mapLimit(affected, 4, (doc) => saveDoc(doc).catch((err) => fail(doc.key, doc.kind, 'relink', err)));
  }

  // 12. Redirects: every changed source URL → its new path.
  const redirectEntries: { key: string; redirectFrom: string[] }[] = [
    ...plan.items.map((i) => ({ key: i.sourceKey, redirectFrom: i.redirectFrom })),
    ...plan.media.map((m) => ({ key: m.sourceKey, redirectFrom: m.redirectFrom })),
    ...plan.events.map((e) => ({ key: e.key, redirectFrom: e.redirectFrom })),
    ...plan.records.map((r) => ({ key: r.sourceKey, redirectFrom: r.redirectFrom })),
    ...plan.tables.map((t) => ({ key: `table:${t.key}`, redirectFrom: t.redirectFrom })),
    ...plan.contentTypes.map((c) => ({ key: `listing:${c.postType}`, redirectFrom: c.listing.redirectFrom })),
  ];
  for (const entry of redirectEntries) {
    const entity = state.entities[entry.key];
    if (!entity?.path) continue;
    for (const from of entry.redirectFrom) if (from !== entity.path) state.redirects.push({ from, to: entity.path });
  }
  // Paths the framework links to that have no page of their own (e.g. its hard-coded news links).
  for (const r of plan.siteRedirects) state.redirects.push({ from: r.from, to: r.to });
  if (info.redirection) {
    try {
      state.redirectImport = await importRedirects(client, state.redirects, log);
    } catch (err) {
      // Redirects are still in the report's redirects.csv.
      fail('redirects', 'redirects', 'redirect-import', err);
    }
  }
  state.finishedAt = new Date().toISOString();
  await save();
  event('finish', { entities: Object.keys(state.entities).length, failures: state.failures.length });
  events.end();
  return state;
}

/**
 * Every object must keep its source key: re-runs find objects by it, and untagged objects of the
 * seed's own types look like demo content to the next plan.
 */
async function assertTagged(client: WpClient, post: Post, key: string, postType: string): Promise<void> {
  if (post.meta?._wm_source_key !== key) {
    // An untagged object would be duplicated by a re-run and look like demo content to the next plan.
    await client.post('/website-mover/v1/trash', { ids: [post.id] }).catch(() => {});
    throw new Error(`The target did not store the source key on this ${postType} (is the bridge active and up to date?); the object was moved to the trash`);
  }
}

/**
 * Site title, theme options, homepage fields and the framework's named menus. Each part is applied
 * on its own, so a failure in one (e.g. a homepage field ACF rejects) doesn't leave the seed's
 * demo menus in place.
 */
async function applySite(
  client: WpClient,
  plan: Plan,
  state: RunState,
  ctx: {
    frontPage: number | null;
    /** The seed's field groups (the templates' fields, their types and row limits). */
    fieldGroups: SeedGroup[];
    mediaId: (url: string | null) => number | undefined;
    /** Rewrites source links in HTML to the migrated pages. */
    html: (html: string) => { html: string; unresolved: string[] };
    postTypeOf: (key: string) => string;
    fail: (step: string, err: unknown) => void;
    log: (msg: string) => void;
  },
): Promise<NonNullable<RunState['site']>> {
  const site = plan.site!;
  const warnings: string[] = [];
  const attempt = async (step: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      ctx.fail(step, err);
    }
  };

  await attempt('site title', async () => {
    if (site.title) await client.post('/wp/v2/settings', { title: site.title });
  });
  let options: Record<string, string> = {};
  await attempt('theme options', async () => {
    options = await client.post<Record<string, string>>('/website-mover/v1/acf/options', { values: site.options });
    const unknown = Object.keys(options).filter((k) => options[k] === 'unknown field');
    if (unknown.length) warnings.push(`The seed has no theme option ${unknown.map((k) => `"${k}"`).join(', ')}: not set.`);
  });

  const home = { slides: 0, quickLinks: 0 };
  const { frontPage } = ctx;
  const homeGroups = homeGroupsOf(ctx.fieldGroups);
  if (frontPage && homeGroups.length) {
    await attempt('homepage fields', async () => {
      const groups = await restGroups(client, homeGroups, (msg) => warnings.push(msg));
      const values = homeFieldValues(groups.flatMap((g) => g.fields), site.home, {
        link: (key, url) => (key && state.entities[key]?.path) || url,
        mediaId: ctx.mediaId,
        html: (html) => {
          const { html: rewritten, unresolved } = ctx.html(html);
          if (unresolved.length) warnings.push(`Homepage introduction: links to content that isn't migrated stay as they are: ${unresolved.join(', ')}`);
          return rewritten;
        },
      });
      warnings.push(...values.warnings);
      if (Object.keys(values.acf).length) await client.post(`/wp/v2/pages/${frontPage}`, { acf: values.acf });
      Object.assign(home, values.counts);
    });
  }

  // Kept framework pages (the News page): the seed's demo text in their template fields.
  for (const p of site.clearPages ?? []) {
    await attempt(`page fields: ${p.title}`, async () => {
      const values = clearedTextFields(templateGroupsOf(ctx.fieldGroups, p.template).flatMap((g) => g.fields));
      if (!Object.keys(values).length) return void warnings.push(`The "${p.title}" page: the seed has no text fields for ${p.template}, so nothing was cleared.`);
      // Through the bridge: the template can show fields from a group that's switched off (the seed's
      // News Page group), which core REST doesn't expose.
      const result = await client.post<Record<string, string>>(`/website-mover/v1/acf/posts/${p.pageId}/fields`, { values }).catch((err: unknown) => {
        if (err instanceof WpError && err.status === 404) throw new Error(`the target's Website Mover Bridge is older than 0.1.1 (no page fields endpoint): update it to clear the "${p.title}" page's demo text`);
        throw err;
      });
      const unknown = Object.keys(result).filter((k) => result[k] === 'unknown field');
      if (unknown.length) warnings.push(`The "${p.title}" page: no fields ${unknown.join(', ')}: not cleared.`);
    });
  }

  // Named menus are replaced as a whole: the seed's items are demo links.
  const menus: Record<string, number> = {};
  let existingMenus: { id: number; name: string }[] = [];
  await attempt('menus', async () => {
    existingMenus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 });
  });
  for (const menu of site.menus) {
    await attempt(`menu ${menu.name}`, async () => {
      let id = existingMenus.find((m) => m.name === menu.name)?.id;
      if (!id && !menu.items.length) return; // nothing to empty
      id ??= (await client.post<{ id: number }>('/wp/v2/menus', { name: menu.name })).id;
      // Deleting shifts the list, so take the first page until none are left.
      for (let old = await menuItems(client, id); old.length; old = await menuItems(client, id)) {
        for (const item of old) await client.delete(`/wp/v2/menu-items/${item.id}`, { force: 'true' });
      }
      const ids: number[] = [];
      for (const [order, item] of menu.items.entries()) {
        const entity = item.key ? state.entities[item.key] : undefined;
        // Link to the object itself where it's a page, post or entry, so the menu follows slug changes.
        const target =
          entity && (entity.kind === 'page' || entity.kind === 'post' || entity.kind === 'record')
            ? { type: 'post_type', object: ctx.postTypeOf(item.key!), object_id: entity.id }
            : { type: 'custom', url: entity?.path || item.url };
        const created = await client.post<{ id: number }>('/wp/v2/menu-items', {
          title: item.title,
          menus: id,
          menu_order: order + 1,
          parent: item.parent === null ? 0 : ids[item.parent] ?? 0,
          status: 'publish',
          ...target,
        });
        ids.push(created.id);
      }
      menus[menu.name] = ids.length;
    });
  }
  ctx.log(`Site: title, ${Object.keys(site.options).length} options, ${home.slides} homepage slides, ${home.quickLinks} quick links, menus ${Object.entries(menus).map(([n, c]) => `${n} (${c})`).join(', ')}`);
  for (const w of warnings) ctx.log(`  ! ${w}`);
  return { menus, options, homeSlides: home.slides, homeQuickLinks: home.quickLinks, warnings };
}

function menuItems(client: WpClient, menu: number) {
  return client.get<{ id: number }[]>('/wp/v2/menu-items', { menus: menu, per_page: 100 });
}

/**
 * The homepage template's ACF values: the source's slides and quick links within the template's
 * row limits; with `clearOthers`, every other field emptied in a form ACF's REST check accepts
 * (`[]` only for repeaters, `null` for relationships and images). A field that requires rows is
 * left as the seed has it and reported, since ACF won't save it empty.
 */
export function homeFieldValues(
  fields: SeedField[],
  home: NonNullable<Plan['site']>['home'],
  resolve: { link: (key: string | null, url: string) => string; mediaId: (url: string | null) => number | undefined; html?: (html: string) => string },
): { acf: Record<string, unknown>; warnings: string[]; counts: { slides: number; quickLinks: number } } {
  const warnings: string[] = [];
  const link = (title: string, key: string | null, url: string | null) => {
    const href = url ? resolve.link(key, url) : '';
    return href ? { title, url: href, target: '' } : null;
  };
  const filled: Record<string, { label: string; rows: unknown[]; names: string[] }> = {};
  if (home.banner.length) {
    for (const b of home.banner) if (b.image && !resolve.mediaId(b.image)) warnings.push(`Homepage slide "${b.title}": its image wasn't uploaded, so the slide has none.`);
    filled.banner = {
      label: 'slides',
      rows: home.banner.map((b) => ({ select_image: resolve.mediaId(b.image) ?? null, title: b.title, link: link(b.linkTitle ?? '', b.linkKey, b.linkUrl) })),
      names: home.banner.map((b) => b.title),
    };
  }
  if (home.quickLinks.length) {
    filled.banner_icon = {
      label: 'quick links',
      rows: home.quickLinks.map((q) => ({ banner_icon: null, icon_link: link(q.title, q.key, q.url) })),
      names: home.quickLinks.map((q) => q.title),
    };
  }
  // Single-value fields the plan fills.
  const values: Record<string, string> = {};
  if (home.intro) {
    if (fields.some((f) => f.name === 'home_intro')) values.home_intro = resolve.html ? resolve.html(home.intro) : home.intro;
    else warnings.push('The homepage template has no introduction field (theme change T9): the source\'s introduction isn\'t on the homepage.');
  }
  const acf: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.name || ['tab', 'message', 'accordion'].includes(field.type ?? '')) continue;
    if (Object.hasOwn(values, field.name)) {
      acf[field.name] = values[field.name];
      continue;
    }
    const fill = filled[field.name];
    const [min, max] = [Number(field.min) || 0, Number(field.max) || 0];
    if (fill) {
      const rows = max ? fill.rows.slice(0, max) : fill.rows;
      if (rows.length < fill.rows.length) warnings.push(`The homepage template takes at most ${max} ${fill.label}; left out: ${fill.names.slice(max).map((n) => `"${n}"`).join(', ')}`);
      acf[field.name] = rows;
    } else if (home.clearOthers) {
      if (min > 0) warnings.push(`The homepage template requires at least ${min} "${field.name}" row(s): the seed's placeholders stay until an editor replaces them.`);
      else acf[field.name] = ['repeater', 'flexible_content'].includes(field.type ?? '') ? [] : ['text', 'textarea', 'wysiwyg', 'email', 'url'].includes(field.type ?? '') ? '' : null;
    }
  }
  const count = (name: string) => (Array.isArray(acf[name]) ? (acf[name] as unknown[]).length : 0);
  return { acf, warnings, counts: { slides: count('banner'), quickLinks: count('banner_icon') } };
}

function entryRedirects(plan: Plan, key: string): string[] {
  if (key.startsWith('table:')) return plan.tables.find((t) => `table:${t.key}` === key)?.redirectFrom ?? [];
  if (key.startsWith('listing:')) return plan.contentTypes.find((c) => `listing:${c.postType}` === key)?.listing.redirectFrom ?? [];
  return plan.items.find((i) => i.sourceKey === key)?.redirectFrom ?? plan.records.find((r) => r.sourceKey === key)?.redirectFrom ?? [];
}

/** Creates (or updates) a custom post type, its taxonomy and its field group through the bridge's ACF endpoints. */
async function createContentType(client: WpClient, ct: PlanContentType, entries: PlanRecord[]): Promise<void> {
  if (ct.taxonomy) {
    await client.post('/website-mover/v1/acf/taxonomies', {
      key: `taxonomy_wm_${ct.taxonomy.name}`,
      title: ct.taxonomy.label,
      taxonomy: ct.taxonomy.name,
      object_type: [ct.postType],
      hierarchical: true,
      public: true,
      show_in_rest: true,
      labels: { name: ct.taxonomy.label, singular_name: ct.taxonomy.singular },
    });
  }
  await client.post('/website-mover/v1/acf/post-types', {
    key: `post_type_wm_${ct.postType}`,
    title: ct.label,
    post_type: ct.postType,
    public: true,
    show_in_rest: true,
    has_archive: false,
    rewrite: { permalink_rewrite: 'custom_permalink', slug: ct.rewriteSlug, with_front: true },
    supports: ['title', 'editor', 'thumbnail', 'excerpt', 'custom-fields'],
    taxonomies: ct.taxonomy ? [ct.taxonomy.name] : [],
    labels: { name: ct.label, singular_name: ct.singular },
  });
  // Long or multi-line values get a textarea; everything else is a text field.
  const long = (name: string) => entries.some((r) => (r.fields[name] ?? '').length > 120 || (r.fields[name] ?? '').includes('\n'));
  await client.post('/website-mover/v1/acf/field-groups', {
    key: `group_wm_${ct.postType}_details`,
    title: `${ct.singular} details`,
    show_in_rest: 1,
    location: [[{ param: 'post_type', operator: '==', value: ct.postType }]],
    fields: Object.entries(ct.fields).map(([name, label]) => ({
      key: `field_wm_${ct.postType}_${name}`,
      label,
      name,
      type: long(name) ? 'textarea' : 'text',
    })),
  });
}

const FORM_MARKER = 'wm-form-marker';

/** Replaces each <form> with a marker paragraph, so the rebuilt form's block lands where it was. */
function withFormMarkers(html: string): string {
  let n = 0;
  return html.replace(/<form\b[\s\S]*?<\/form>/gi, () => `<p>${FORM_MARKER}-${n++}</p>`);
}

/** Swaps marker paragraphs for form blocks (in order); forms without a marker go at the end. */
function placeForms(blocks: Block[], formIds: number[]): Block[] {
  const remaining = [...formIds];
  const out = blocks.flatMap((b) => {
    const marker = b.name === 'core/paragraph' && new RegExp(`^${FORM_MARKER}-\\d+$`).test(String(b.attributes.content ?? '').trim());
    if (!marker) return [b];
    const id = remaining.shift();
    return id === undefined ? [] : [formBlock(id)];
  });
  return [...out, ...remaining.map(formBlock)];
}

/** The form's block, without its own title (the page already has it). */
function formBlock(id: number): Block {
  return externalBlock('gravityforms/form', { formId: String(id), title: false });
}

/**
 * Creates a post. If the connection drops (the server may still have saved it), looks the post up
 * by its source key before trying again, so a retry never makes a duplicate.
 */
/**
 * The write may or may not have happened: the connection dropped, or a gateway in front of WordPress
 * gave up waiting (Pantheon answers 502 while WordPress is still saving a large upload).
 */
export function outcomeUnknown(err: unknown): boolean {
  return !(err instanceof WpError) || [502, 503, 504].includes(err.status);
}

async function createOnce(client: WpClient, route: string, body: object, key: string, postType: string): Promise<Post> {
  try {
    return await client.post<Post>(route, body);
  } catch (err) {
    if (!outcomeUnknown(err)) throw err; // WordPress answered: it didn't save it
    const saved = (await client.get<{ id: number; source_key: string | null }[]>('/website-mover/v1/entities', { types: postType }))
      .find((e) => e.source_key === key);
    return saved ? client.post<Post>(`${route}/${saved.id}`, body) : client.post<Post>(route, body);
  }
}

/**
 * Uploads a file tagged with its source key. If the outcome is unknown, looks for the tagged
 * attachment before failing, so a file that did arrive isn't reported as failed or uploaded twice.
 */
export async function uploadOnce(client: WpClient, data: Uint8Array<ArrayBuffer>, filename: string, contentType: string, meta: Record<string, string>): Promise<Media> {
  try {
    return await client.upload<Media>(data, filename, contentType, { 'meta[_wm_source_key]': meta._wm_source_key!, 'meta[_wm_job_id]': meta._wm_job_id! });
  } catch (err) {
    if (!outcomeUnknown(err)) throw err;
    const saved = (await client.get<{ id: number; source_key: string | null }[]>('/website-mover/v1/entities', { types: 'attachment' })).find(
      (e) => e.source_key === meta._wm_source_key,
    );
    if (!saved) throw err;
    return client.get<Media>(`/wp/v2/media/${saved.id}`, { context: 'edit', _fields: 'id,source_url' });
  }
}

async function uploadMedia(
  client: WpClient,
  jobId: string,
  m: PlanMedia,
  previous: { id: number; link: string; job_id: string | null } | undefined,
  alt: string,
  meta: Record<string, string>,
  doc: { resource_type?: number[]; library_select: string | null },
): Promise<RunEntity> {
  let id = previous?.id;
  let url = previous?.link;
  if (!id) {
    const data = new Uint8Array(await readFile(jobPath(jobId, m.path)));
    // Tag it in the upload request itself, so a failure before the update below can't leave an
    // untagged attachment that a re-run would upload again.
    const media = await uploadOnce(client, data, m.filename, m.contentType, meta);
    id = media.id;
    url = media.source_url;
  }
  const title = m.filename.replace(/\.[a-z0-9]+$/i, '');
  await client.post(`/wp/v2/media/${id}`, {
    title,
    // Attachments and pages share one slug namespace in WordPress; keep files out of the pages' way.
    slug: `${wpSlug(title, 80) || 'file'}-file`,
    ...(m.type === 'image' ? { alt_text: alt } : {}),
    meta,
    ...(doc.resource_type ? { resource_type: doc.resource_type } : {}),
    acf: {
      index_for_library: m.fields.index_for_library,
      ...(m.fields.publication_date ? { publication_date: m.fields.publication_date.replace(/-/g, '') } : {}),
      ...(doc.library_select ? { library_select: [doc.library_select] } : {}),
    },
  });
  const action = previous && previous.job_id !== meta._wm_job_id ? 'updated' : 'created';
  return { kind: m.type, id, path: new URL(url!).pathname, action, warnings: [] };
}

/** Imports redirects into the Redirection plugin (301, exact query match), skipping ones already there. */
async function importRedirects(client: WpClient, redirects: RunState['redirects'], log: (m: string) => void) {
  const groups = await client.get<{ items: { id: number; name: string }[] }>('/redirection/v1/group');
  const group =
    groups.items.find((g) => g.name === 'Website Mover') ??
    (await client.post<{ items: { id: number; name: string }[] }>('/redirection/v1/group', { name: 'Website Mover', moduleId: 1 })).items.find(
      (g) => g.name === 'Website Mover',
    )!;
  type Existing = { id: number; url: string; action_data: string | { url?: string } };
  const existing = new Map<string, Existing>();
  for (let page = 0; ; page++) {
    const res = await client.get<{ items: Existing[]; total: number }>('/redirection/v1/redirect', {
      'filterBy[group]': group.id,
      per_page: 200,
      page,
    });
    for (const r of res.items) existing.set(r.url, r);
    if (res.items.length < 200) break;
  }
  const result = { imported: 0, updated: 0, skipped: 0, failed: 0 };
  for (const r of redirects) {
    const found = existing.get(r.from);
    const target = found && (typeof found.action_data === 'string' ? found.action_data : found.action_data?.url);
    if (found && target === r.to) {
      result.skipped++;
      continue;
    }
    try {
      await client.post(found ? `/redirection/v1/redirect/${found.id}` : '/redirection/v1/redirect', {
        status: 'enabled',
        url: r.from,
        match_type: 'url',
        action_type: 'url',
        action_code: 301,
        action_data: { url: r.to },
        group_id: group.id,
        match_data: { source: { flag_query: 'exact', flag_case: true, flag_trailing: true, flag_regex: false } },
      });
      result[found ? 'updated' : 'imported']++;
    } catch {
      result.failed++;
    }
  }
  log(`Redirects: ${result.imported} imported, ${result.updated} updated, ${result.skipped} unchanged, ${result.failed} failed`);
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

/**
 * Post date for a source date. WordPress schedules posts dated in the future instead of
 * publishing them; the source shows them now, so those get the migration time (the plan flags
 * them). That one is sent as GMT: `date` is read in the site's timezone.
 */
function postDate(date: string | null): { date?: string; date_gmt?: string } {
  if (!date) return {};
  const now = new Date();
  // An explicit current date also publishes a post an earlier run left scheduled.
  return new Date(`${date}T00:00:00`) > now ? { date_gmt: now.toISOString().slice(0, 19) } : { date: `${date}T00:00:00` };
}

async function fileSha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
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
