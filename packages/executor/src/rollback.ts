/**
 * Rollback (docs/m5/design.md §5): undoes what a job did to the target. Before a job first touches
 * the site structure, it saves what it will change (run/before.json); rollback removes what it
 * created and puts that back.
 */
import { existsSync } from 'node:fs';
import { readdir, rename } from 'node:fs/promises';
import { dataDir, jobPath, readJson, writeJson } from '@wm/core';
import { loadPlan, type Plan, type TargetEntity } from '@wm/planner';
import type { WpClient } from '@wm/wp-client';
import { loadRunState } from './execute.js';

interface MenuItemSnapshot {
  id: number;
  title: string;
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
  home: { pageId: number; acf: Record<string, unknown>; types?: Record<string, string> } | null;
  menus: { name: string; existed: boolean; items: MenuItemSnapshot[] }[];
}

const beforeFile = (jobId: string) => jobPath(jobId, 'run', 'before.json');

/** Saves the site structure the job is about to change, once: re-runs keep the first snapshot. */
export async function snapshotBefore(client: WpClient, jobId: string, plan: Plan, home: { pageId: number | null; groupKey: string | null; fields?: { name: string; type?: string }[] }): Promise<void> {
  if (existsSync(beforeFile(jobId))) return;
  const settingKeys = ['title', ...plan.settings.map((s) => s.key)];
  const settings = await client.get<Record<string, unknown>>('/wp/v2/settings');
  const optionNames = Object.keys(plan.site?.options ?? {});
  const options = optionNames.length ? await client.get<Record<string, unknown>>('/website-mover/v1/acf/options', { names: optionNames.join(',') }) : {};
  let homeState: BeforeState['home'] = null;
  if (plan.site && home.pageId && home.groupKey) {
    await client.post(`/website-mover/v1/acf/field-groups/${home.groupKey}/show-in-rest`, {});
    const page = await client.get<{ acf?: Record<string, unknown> }>(`/wp/v2/pages/${home.pageId}`, { context: 'edit', _fields: 'acf' });
    homeState = { pageId: home.pageId, acf: page.acf ?? {}, types: Object.fromEntries((home.fields ?? []).filter((f) => f.name).map((f) => [f.name, f.type ?? ''])) };
  }
  const existingMenus = await client.get<{ id: number; name: string }[]>('/wp/v2/menus', { per_page: 100 });
  const menus: BeforeState['menus'] = [];
  for (const m of plan.site?.menus ?? []) {
    const menu = existingMenus.find((e) => e.name === m.name);
    menus.push({ name: m.name, existed: !!menu, items: menu ? await menuItems(client, menu.id) : [] });
  }
  const snapshot: BeforeState = {
    takenAt: new Date().toISOString(),
    settings: Object.fromEntries(settingKeys.filter((k) => k in settings).map((k) => [k, settings[k]])),
    options,
    home: homeState,
    menus,
  };
  await writeJson(beforeFile(jobId), snapshot);
}

async function menuItems(client: WpClient, menuId: number): Promise<MenuItemSnapshot[]> {
  const items: MenuItemSnapshot[] = [];
  for (let page = 1; ; page++) {
    const batch = await client.get<(Omit<MenuItemSnapshot, 'title'> & { title: { raw: string } })[]>('/wp/v2/menu-items', { menus: menuId, per_page: 100, page, context: 'edit' }).catch(() => []);
    items.push(...batch.map((i) => ({ id: i.id, title: i.title.raw, url: i.url, type: i.type, object: i.object, object_id: i.object_id, parent: i.parent, menu_order: i.menu_order, target: i.target, classes: i.classes })));
    if (batch.length < 100) break;
  }
  return items;
}

/**
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

/** Jobs (other than this one) whose last run was on the same target, with what they use there. */
async function otherJobsOnTarget(jobId: string, targetUrl: string): Promise<{ jobId: string; startedAt: string; redirects: string[]; contentTypes: string[] }[]> {
  const ids = await readdir(`${dataDir()}/jobs`).catch(() => [] as string[]);
  const found = [];
  for (const id of ids) {
    if (id === jobId || !existsSync(jobPath(id, 'run', 'state.json'))) continue;
    const state = await loadRunState(id).catch(() => null);
    const plan = state && (await loadPlan(id, state.planVersion).catch(() => null))?.plan;
    if (!state || !plan || plan.target.url !== targetUrl) continue;
    found.push({ jobId: id, startedAt: state.startedAt, redirects: state.redirects.map((r) => r.from), contentTypes: plan.contentTypes.map((c) => c.postType) });
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
  if (later.length) result.problems.push(`Not restored: settings, theme options, homepage and menus, since ${later.join(', ')} ran on this target later (roll that back first, or restore by hand)`);
  else if (!before) result.problems.push('No snapshot of the site structure from before the first run (jobs run before M5): settings, theme options, homepage and menus were not restored');
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
