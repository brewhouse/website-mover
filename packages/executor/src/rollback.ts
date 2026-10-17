/**
 * Rollback (docs/m5/design.md §5): undoes what a job did to the target. Before a job first touches
 * the site structure, it saves what it will change (run/before.json); rollback removes what it
 * created and puts that back.
 */
import { existsSync } from 'node:fs';
import { readdir, rename } from 'node:fs/promises';
import { dataDir, jobPath, readJson, writeJson } from '@wm/core';
import { loadPlan, type Plan, type TargetEntity } from '@wm/planner';
import { WpError, type WpClient } from '@wm/wp-client';
import { loadRunState } from './execute.js';
import { brandCssOf, findFontFamily, fontFaces, userGlobalStyles, withoutBrandCss } from './design.js';

interface MenuItemSnapshot {
  id: number;
  title: string;
  attr_title?: string;
  description?: string;
  xfn?: string[];
  url: string;
  type: string;
  object: string;
  object_id: number;
  parent: number;
  menu_order: number;
  target: string;
  classes: string[];
}

/** What a job changes on the site structure, as it was before the job's first run. */
export interface BeforeState {
  takenAt: string;
  settings: Record<string, unknown>;
  options: Record<string, unknown>;
  /** The homepage template's fields; `types` lets restore send what ACF's REST check accepts. */
  home: PageState | null;
  /** Kept framework pages' template text fields the job clears (the News page), read through the bridge. */
  pages?: PageState[];
  menus: { name: string; existed: boolean; items: MenuItemSnapshot[] }[];
  /** The brand's font families as they were: whether each was installed, and which faces ("400 normal"). */
  fonts?: { slug: string; existed: boolean; faces: string[] }[];
  /** The tool's brand CSS block as it was (an earlier job's), or null if there was none. */
  brandCss?: string | null;
}

type PageState = { pageId: number; acf: Record<string, unknown>; types?: Record<string, string> };
/** A page and the template fields the job changes on it (the homepage's are readable through REST by now: restGroups). */
export type PageFields = { pageId: number | null; fields: { name: string; type?: string }[] };

const beforeFile = (jobId: string) => jobPath(jobId, 'run', 'before.json');

/** Settings and theme options the plan changes: the site structure's and the design's (logos, header). */
function settingKeysOf(plan: Plan): string[] {
  return ['title', ...plan.settings.map((s) => s.key), ...(plan.design?.logos.header ? ['site_logo'] : [])];
}
function optionNamesOf(plan: Plan): string[] {
  return [...Object.keys(plan.site?.options ?? {}), ...Object.keys(plan.design?.options ?? {}), ...(plan.design?.logos.footer ? ['site_footer_logo'] : [])];
}
/** A setting's value as REST takes it back: WordPress reports "no logo" as null but only accepts 0. */
function restorable(key: string, value: unknown): unknown {
  return key === 'site_logo' && value === null ? 0 : value;
}

const faceKey = (f: { font_face_settings: { fontStyle: string; fontWeight: string | number } }) => `${f.font_face_settings.fontWeight} ${f.font_face_settings.fontStyle}`;

/** The tool's brand CSS block now; null when there's none, or no Global Styles to hold one (a classic theme). */
async function currentBrandCss(client: WpClient): Promise<string | null> {
  const gs = await userGlobalStyles(client).catch(() => null);
  return gs ? brandCssOf(String(gs.styles.css ?? '')) : null;
}

/** The brand's font families as they are now. */
async function fontsState(client: WpClient, slugs: string[]): Promise<NonNullable<BeforeState['fonts']>> {
  const out: NonNullable<BeforeState['fonts']> = [];
  for (const slug of slugs) {
    const family = await findFontFamily(client, slug);
    const faces = family ? await fontFaces(client, family.id) : [];
    out.push({ slug, existed: !!family, faces: faces.map(faceKey) });
  }
  return out;
}

/**
 * Saves the site structure the job is about to change, on its first run only: re-runs keep that
 * snapshot, and a job that already ran without one (before M5) gets none, since the site then holds
 * its own earlier changes, not the original. A re-run that changes something the snapshot doesn't
 * have yet (a setting or field a newer plan adds) records it first: the job hasn't changed it before.
 */
export async function snapshotBefore(client: WpClient, jobId: string, plan: Plan, home: PageFields, pages: PageFields[] = []): Promise<void> {
  if (existsSync(beforeFile(jobId))) return addToSnapshot(client, jobId, plan, home, pages);
  if (await hasRunBefore(jobId)) return;
  const settingKeys = settingKeysOf(plan);
  const settings = await client.get<Record<string, unknown>>('/wp/v2/settings');
  const optionNames = optionNamesOf(plan);
  const options = optionNames.length ? await client.get<Record<string, unknown>>('/website-mover/v1/acf/options', { names: optionNames.join(',') }) : {};
  const homeState = plan.site && home.pageId && home.fields.length ? await pageState(client, home.pageId, home.fields) : null;
  const pageStates: PageState[] = [];
  for (const p of plan.site ? pages : []) {
    const state = p.pageId && p.fields.length ? await bridgePageState(client, p.pageId, p.fields) : null;
    if (state) pageStates.push(state);
  }
  const existingMenus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 });
  const menus: BeforeState['menus'] = [];
  for (const m of plan.site?.menus ?? []) {
    const menu = existingMenus.find((e) => e.name === m.name);
    menus.push({ name: m.name, existed: !!menu, items: menu ? await menuItems(client, menu.id) : [] });
  }
  const snapshot: BeforeState = {
    takenAt: new Date().toISOString(),
    settings: Object.fromEntries(settingKeys.filter((k) => k in settings).map((k) => [k, restorable(k, settings[k])])),
    options,
    home: homeState,
    pages: pageStates,
    menus,
    fonts: await fontsState(client, plan.design?.fonts.map((f) => f.slug) ?? []),
    ...(plan.design ? { brandCss: await currentBrandCss(client) } : {}),
  };
  await writeJson(beforeFile(jobId), snapshot);
}

async function addToSnapshot(client: WpClient, jobId: string, plan: Plan, home: PageFields, pages: PageFields[]): Promise<void> {
  const snapshot = await readJson<BeforeState>(beforeFile(jobId));
  let changed = false;
  const settingKeys = settingKeysOf(plan).filter((k) => !(k in snapshot.settings));
  if (settingKeys.length) {
    const settings = await client.get<Record<string, unknown>>('/wp/v2/settings');
    for (const k of settingKeys) {
      if (!(k in settings)) continue;
      snapshot.settings[k] = restorable(k, settings[k]);
      changed = true;
    }
  }
  const newFonts = (plan.design?.fonts ?? []).map((f) => f.slug).filter((slug) => !snapshot.fonts?.some((f) => f.slug === slug));
  if (newFonts.length) {
    (snapshot.fonts ??= []).push(...(await fontsState(client, newFonts)));
    changed = true;
  }
  if (plan.design && !('brandCss' in snapshot)) {
    snapshot.brandCss = await currentBrandCss(client);
    changed = true;
  }
  // Menus a later plan adds (e.g. the Footer Contact Menu), as they are now.
  const newMenus = (plan.site?.menus ?? []).filter((m) => !snapshot.menus.some((s) => s.name === m.name));
  if (newMenus.length) {
    const existingMenus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 });
    for (const m of newMenus) {
      const menu = existingMenus.find((e) => e.name === m.name);
      snapshot.menus.push({ name: m.name, existed: !!menu, items: menu ? await menuItems(client, menu.id) : [] });
    }
    changed = true;
  }
  const optionNames = optionNamesOf(plan).filter((n) => !(n in snapshot.options));
  if (optionNames.length) {
    Object.assign(snapshot.options, await client.get<Record<string, unknown>>('/website-mover/v1/acf/options', { names: optionNames.join(',') }));
    changed = true;
  }
  // Pages: fields the snapshot lacks, or pages it lacks (no earlier run changed them).
  if (plan.site && home.pageId && home.fields.length) {
    if (!snapshot.home) {
      snapshot.home = await pageState(client, home.pageId, home.fields);
      changed = true;
    } else if (snapshot.home.pageId === home.pageId && (await fillPageState(client, snapshot.home, home.fields, pageState))) changed = true;
  }
  for (const p of plan.site ? pages : []) {
    if (!p.pageId || !p.fields.length) continue;
    const recorded = snapshot.pages?.find((s) => s.pageId === p.pageId);
    if (recorded) {
      if (await fillPageState(client, recorded, p.fields, bridgePageState)) changed = true;
    } else {
      const state = await bridgePageState(client, p.pageId, p.fields);
      if (!state) continue;
      (snapshot.pages ??= []).push(state);
      changed = true;
    }
  }
  if (changed) await writeJson(beforeFile(jobId), snapshot);
}

/** A page's template fields as they are now. */
async function pageState(client: WpClient, pageId: number, fields: PageFields['fields']): Promise<PageState> {
  const page = await client.get<{ acf?: Record<string, unknown> }>(`/wp/v2/pages/${pageId}`, { context: 'edit', _fields: 'acf' });
  return { pageId, acf: page.acf ?? {}, types: Object.fromEntries(fields.filter((f) => f.name).map((f) => [f.name, f.type ?? ''])) };
}

/**
 * A page's fields as they are now, read through the bridge (whatever their group's REST or active
 * setting). Null when the target's bridge predates the endpoint (0.1.0): the executor then doesn't
 * change those fields either.
 */
async function bridgePageState(client: WpClient, pageId: number, fields: PageFields['fields']): Promise<PageState | null> {
  const names = fields.map((f) => f.name).filter(Boolean);
  const acf = await client.get<Record<string, unknown>>(`/website-mover/v1/acf/posts/${pageId}/fields`, { names: names.join(',') }).catch((err: unknown) => {
    if (err instanceof WpError && err.status === 404) return null;
    throw err;
  });
  return acf && { pageId, acf, types: Object.fromEntries(fields.filter((f) => f.name).map((f) => [f.name, f.type ?? ''])) };
}

/** Adds the fields a recorded page lacks, as they are now. */
async function fillPageState(
  client: WpClient,
  recorded: PageState,
  fields: PageFields['fields'],
  read: (client: WpClient, pageId: number, fields: PageFields['fields']) => Promise<PageState | null>,
): Promise<boolean> {
  const missing = fields.filter((f) => f.name && !(f.name in recorded.acf));
  if (!missing.length) return false;
  const now = await read(client, recorded.pageId, missing);
  if (!now) return false;
  let changed = false;
  for (const f of missing) {
    if (!(f.name in now.acf)) continue;
    recorded.acf[f.name] = now.acf[f.name];
    recorded.types = { ...recorded.types, [f.name]: f.type ?? '' };
    changed = true;
  }
  return changed;
}

async function menuItems(client: WpClient, menuId: number): Promise<MenuItemSnapshot[]> {
  const items: MenuItemSnapshot[] = [];
  for (let page = 1; ; page++) {
    const batch = await client.get<(Omit<MenuItemSnapshot, 'title'> & { title: { raw: string } })[]>('/wp/v2/menu-items', { menus: menuId, per_page: 100, page, context: 'edit' }).catch(() => []);
    items.push(
      ...batch.map((i) => ({
        id: i.id,
        title: i.title.raw,
        attr_title: i.attr_title,
        description: i.description,
        xfn: i.xfn,
        url: i.url,
        type: i.type,
        object: i.object,
        object_id: i.object_id,
        parent: i.parent,
        menu_order: i.menu_order,
        target: i.target,
        classes: i.classes,
      })),
    );
    if (batch.length < 100) break;
  }
  return items;
}

/**
 * Restores the homepage's template fields.
 * ACF's REST check wants an empty repeater as [] (it rejects null, its own message notwithstanding),
 * while relationship fields want null. Snapshots record field types; older ones are fixed up from the
 * field ACF names in its error.
 */
export async function restoreHome(client: WpClient, home: NonNullable<BeforeState['home']>): Promise<void> {
  const acf = { ...home.acf };
  for (const [name, type] of Object.entries(home.types ?? {})) if (acf[name] === null && ['repeater', 'flexible_content'].includes(type)) acf[name] = [];
  for (let i = 0; ; i++) {
    try {
      await client.post(`/wp/v2/pages/${home.pageId}`, { acf });
      return;
    } catch (err) {
      const field = /acf\[(\w+)\] must be of type array or null/.exec(JSON.stringify((err as { body?: unknown }).body ?? ''))?.[1];
      if (!field || acf[field] !== null || i > 20) throw err;
      acf[field] = [];
    }
  }
}

/** The job ran on its target before (a run state, current or rolled back). */
async function hasRunBefore(jobId: string): Promise<boolean> {
  const names = await readdir(jobPath(jobId, 'run')).catch(() => [] as string[]);
  return names.some((n) => n === 'state.json' || /^state\.rolled-back-\d+\.json$/.test(n));
}

/** Jobs (other than this one) whose last run was on the same target, with what they use there. */
export async function otherJobsOnTarget(jobId: string, targetUrl: string): Promise<{ jobId: string; startedAt: string; redirects: string[]; contentTypes: string[] }[]> {
  const ids = await readdir(`${dataDir()}/jobs`).catch(() => [] as string[]);
  const found = [];
  for (const id of ids) {
    if (id === jobId || !existsSync(jobPath(id, 'run', 'state.json'))) continue;
    const state = await loadRunState(id).catch(() => null);
    // Only the target and content types are needed: read the plan without validating all of it.
    const plan = state && (await readJson<Pick<Plan, 'target' | 'contentTypes'>>(jobPath(id, 'plan', `plan.v${state.planVersion}.json`)).catch(() => null));
    if (!state || !plan || plan.target.url !== targetUrl) continue;
    found.push({ jobId: id, startedAt: state.startedAt, redirects: state.redirects.map((r) => r.from), contentTypes: (plan.contentTypes ?? []).map((c) => c.postType) });
  }
  return found;
}

export interface RollbackResult {
  redirectsDeleted: number;
  trashed: number;
  filesDeleted: number;
  formsTrashed: number;
  contentTypesTrashed: number;
  restored: string[];
  untrashed: number;
  problems: string[];
}

/**
 * Undoes a job on its target: the redirects it imported, the content it created (trashed; files
 * deleted, since WordPress can't trash them), its forms and content types (trashed), the site
 * structure it changed (restored from before.json) and the seed content it trashed (restored).
 */
export async function rollbackJob({ jobId, client, log = console.log }: { jobId: string; client: WpClient; log?: (msg: string) => void }): Promise<RollbackResult> {
  const state = await loadRunState(jobId).catch(() => {
    throw new Error('This job has no migration run to roll back');
  });
  const { plan } = await loadPlan(jobId, state.planVersion);
  // Other jobs that ran on the same target: what they also use stays, and the site structure is only
  // restored if this job was the last to change it.
  const others = await otherJobsOnTarget(jobId, plan.target.url);
  const sharedRedirects = new Set(others.flatMap((o) => o.redirects));
  const sharedTypes = new Set(others.flatMap((o) => o.contentTypes));
  const later = others.filter((o) => o.startedAt > state.startedAt).map((o) => o.jobId);
  const result: RollbackResult = { redirectsDeleted: 0, trashed: 0, filesDeleted: 0, formsTrashed: 0, contentTypesTrashed: 0, restored: [], untrashed: 0, problems: [] };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      result.problems.push(`${what}: ${(err as Error).message}`);
      log(`  ! ${what}: ${(err as Error).message}`);
    }
  };

  // 1. Redirects this job imported (the "Website Mover" group is shared by jobs on the target).
  await attempt('redirects', async () => {
    if (!state.redirectImport) return;
    const groups = await client.get<{ items: { id: number; name: string }[] }>('/redirection/v1/group');
    const group = groups.items.find((g) => g.name === 'Website Mover');
    if (!group) return;
    const ours = new Set(state.redirects.map((r) => r.from).filter((from) => !sharedRedirects.has(from)));
    const kept = state.redirects.length - ours.size;
    if (kept) log(`Rollback: ${kept} redirects stay (other jobs on this target use them too)`);
    const ids: number[] = [];
    for (let page = 0; ; page++) {
      const res = await client.get<{ items: { id: number; url: string }[] }>('/redirection/v1/redirect', { 'filterBy[group]': group.id, per_page: 200, page });
      ids.push(...res.items.filter((r) => ours.has(r.url)).map((r) => r.id));
      if (res.items.length < 200) break;
    }
    for (let i = 0; i < ids.length; i += 100) await client.post('/redirection/v1/bulk/redirect/delete', { items: ids.slice(i, i + 100) });
    result.redirectsDeleted = ids.length;
    log(`Rollback: ${ids.length} redirects deleted`);
  });

  // 2. Content the job created, found by its job tag.
  await attempt('content', async () => {
    const created = (await client.get<TargetEntity[]>('/website-mover/v1/entities')).filter((e) => e.job_id === jobId);
    const files = created.filter((e) => e.type === 'attachment');
    const posts = created.filter((e) => e.type !== 'attachment');
    for (let i = 0; i < posts.length; i += 100) {
      const res = await client.post<Record<string, string>>('/website-mover/v1/trash', { ids: posts.slice(i, i + 100).map((p) => p.id) });
      result.trashed += Object.values(res).filter((s) => s === 'trashed').length;
    }
    for (const f of files) {
      await client.delete(`/wp/v2/media/${f.id}`, { force: 'true' });
      result.filesDeleted++;
    }
    log(`Rollback: ${result.trashed} pages, posts and entries trashed; ${result.filesDeleted} files deleted`);
  });

  // 3. Forms and content types the job created.
  await attempt('forms', async () => {
    const ids = Object.values(state.entities).filter((e) => e.kind === 'form').map((e) => e.id);
    if (!ids.length) return;
    const res = await client.post<Record<string, string>>('/website-mover/v1/forms/trash', { ids });
    result.formsTrashed = Object.values(res).filter((s) => s === 'trashed').length;
  });
  await attempt('content types', async () => {
    for (const ct of plan.contentTypes) {
      if (sharedTypes.has(ct.postType)) {
        log(`Rollback: the ${ct.label} content type stays (another job on this target uses it)`);
        continue;
      }
      const items: [string, string[]][] = [
        ['acf-field-group', [`group_wm_${ct.postType}_details`]],
        ['acf-post-type', [`post_type_wm_${ct.postType}`]],
        ['acf-taxonomy', ct.taxonomy ? [`taxonomy_wm_${ct.taxonomy.name}`] : []],
      ];
      for (const [type, keys] of items) {
        if (!keys.length) continue;
        const res = await client.post<Record<string, string>>('/website-mover/v1/acf/trash', { type, keys });
        result.contentTypesTrashed += Object.values(res).filter((s) => s === 'trashed').length;
      }
    }
  });

  // 4. The site structure as it was before the job's first run.
  const snapshot = existsSync(beforeFile(jobId)) ? await readJson<BeforeState>(beforeFile(jobId)) : null;
  const before = later.length ? null : snapshot;
  if (later.length) result.problems.push(`Not restored: settings, theme options, homepage, menus and design, since ${later.join(', ')} ran on this target later (roll that back first, or restore by hand)`);
  else if (!before) result.problems.push('No snapshot of the site structure from before the first run (jobs run before M5): settings, theme options, homepage, menus and design were not restored');
  if (before) {
    await attempt('settings', async () => {
      if (Object.keys(before.settings).length) await client.post('/wp/v2/settings', before.settings);
      result.restored.push('settings');
    });
    await attempt('theme options', async () => {
      if (Object.keys(before.options).length) await client.post('/website-mover/v1/acf/options', { values: before.options });
      result.restored.push('theme options');
    });
    await attempt('homepage', async () => {
      if (before.home) await restoreHome(client, before.home);
      result.restored.push('homepage');
    });
    await attempt('framework pages', async () => {
      for (const p of before.pages ?? []) await client.post(`/website-mover/v1/acf/posts/${p.pageId}/fields`, { values: p.acf });
      if (before.pages?.length) result.restored.push('framework pages');
    });
    await attempt('design', async () => {
      // The brand CSS block as it was (an earlier job's, or none), and the fonts and font files the job installed.
      const gs = before.brandCss !== undefined ? await userGlobalStyles(client).catch((err: unknown) => (before.brandCss === null ? null : Promise.reject(err))) : null;
      if (gs) {
        const css = [withoutBrandCss(String(gs.styles.css ?? '')), before.brandCss ?? ''].filter(Boolean).join('\n\n');
        if (css !== String(gs.styles.css ?? '')) await client.post(`/wp/v2/global-styles/${gs.id}`, { styles: { ...gs.styles, css } });
      }
      // Faces the plan installs that weren't there before; a face an editor added since stays.
      const planned = new Map((plan.design?.fonts ?? []).map((f) => [f.slug, new Set(f.faces.map((x) => `${x.weight} ${x.style}`))]));
      for (const f of before.fonts ?? []) {
        const family = await findFontFamily(client, f.slug);
        if (!family) continue;
        if (!f.existed) {
          await client.delete(`/wp/v2/font-families/${family.id}`, { force: 'true' });
          continue;
        }
        for (const face of await fontFaces(client, family.id)) {
          const key = faceKey(face);
          if (!f.faces.includes(key) && planned.get(f.slug)?.has(key)) await client.delete(`/wp/v2/font-families/${family.id}/font-faces/${face.id}`, { force: 'true' });
        }
      }
      if (before.brandCss !== undefined || before.fonts?.length) result.restored.push('design');
    });
    await attempt('menus', async () => {
      const menus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 });
      for (const m of before.menus) {
        const menu = menus.find((x) => x.name === m.name);
        if (!menu) continue;
        if (!m.existed) {
          await client.delete(`/wp/v2/menus/${menu.id}`, { force: 'true' });
          continue;
        }
        for (const item of await menuItems(client, menu.id)) await client.delete(`/wp/v2/menu-items/${item.id}`, { force: 'true' });
        // Parents before children: old item ids map to the recreated ones.
        const ids = new Map<number, number>();
        const pending = [...m.items].sort((a, b) => a.menu_order - b.menu_order);
        while (pending.length) {
          const i = pending.findIndex((it) => !it.parent || ids.has(it.parent));
          const it = pending.splice(i < 0 ? 0 : i, 1)[0]!;
          const created = await client.post<{ id: number }>('/wp/v2/menu-items', {
            title: it.title,
            menus: menu.id,
            menu_order: it.menu_order,
            parent: it.parent ? ids.get(it.parent) ?? 0 : 0,
            status: 'publish',
            target: it.target,
            classes: it.classes,
            ...(it.attr_title ? { attr_title: it.attr_title } : {}),
            ...(it.description ? { description: it.description } : {}),
            ...(it.xfn?.length ? { xfn: it.xfn } : {}),
            ...(it.type === 'custom' ? { type: 'custom', url: it.url } : { type: it.type, object: it.object, object_id: it.object_id }),
          });
          ids.set(it.id, created.id);
        }
      }
      result.restored.push('menus');
    });
  }

  // 5. Seed content the job had trashed.
  await attempt('seed content', async () => {
    const ids = Object.entries(state.cleanup).filter(([, s]) => s === 'trashed').map(([id]) => Number(id));
    if (!ids.length) return;
    const res = await client.post<Record<string, string>>('/website-mover/v1/untrash', { ids });
    result.untrashed = Object.values(res).filter((s) => s === 'restored').length;
  });

  // The job no longer has a migration on the target; its run state is kept for the record.
  await writeJson(jobPath(jobId, 'run', 'rollback.json'), { at: new Date().toISOString(), planVersion: state.planVersion, result });
  await rename(jobPath(jobId, 'run', 'state.json'), jobPath(jobId, 'run', `state.rolled-back-${Date.now()}.json`));
  log(`Rollback done: ${result.redirectsDeleted} redirects, ${result.trashed} trashed, ${result.filesDeleted} files deleted, ${result.formsTrashed} forms, ${result.contentTypesTrashed} content-type items; restored ${result.restored.join(', ') || 'nothing'}; ${result.untrashed} seed items back${result.problems.length ? `; ${result.problems.length} problem(s)` : ''}`);
  return result;
}
