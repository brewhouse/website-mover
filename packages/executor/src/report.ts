import { writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { externalBlock, validateSerialized } from '@wm/blocks';
import { safeFetch } from '@wm/net';
import { jobPath, writeJson } from '@wm/core';
import { loadPlan } from '@wm/planner';
import type { WpClient } from '@wm/wp-client';
import { loadRunState, mapLimit, type EntityKind, type RunState } from './execute.js';

interface KindCounts {
  planned: number;
  created: number;
  updated: number;
  failed: number;
  /** Published URL answered 200. */
  live: number;
  /** Stored content has a block the editor would reject or not support. */
  invalidBlocks: number;
}

export interface Report {
  jobId: string;
  planVersion: number;
  approvedBy: string;
  ranAt: string;
  target: string;
  counts: Record<EntityKind, KindCounts>;
  cleanup: { planned: number; trashed: number };
  /** `working`: answered 301 to the expected path (checked only when imported into Redirection). */
  redirects: { total: number; imported: number | null; working: number | null; broken: { from: string; to: string; got: string }[] };
  failures: { sourceKey: string; kind: string; step: string; error: string }[];
  notLive: { sourceKey: string; path: string; status: number }[];
  invalid: { sourceKey: string; errors: string[] }[];
  warnings: Record<string, number>;
  site: RunState['site'];
  /** Same-site links and images on the migrated pages that don't answer 200 (after redirects). */
  links?: { checked: number; broken: { url: string; status: number; pageCount: number; pages: string[] }[] };
}

/** Checks the run against the target and writes report.json/.md, url-map.csv and redirects.csv. */
/** The same-site http(s) links and image sources on a page (absolute, without the #fragment), minus WordPress's own admin and API URLs. */
export function linksIn(html: string, pageUrl: string): string[] {
  const host = new URL(pageUrl).host;
  const $ = cheerio.load(html);
  const found = new Set<string>();
  for (const [selector, attr] of [['a[href]', 'href'], ['img[src]', 'src']] as const) {
    $(selector).each((_, el) => {
      const raw = $(el).attr(attr)?.trim();
      if (!raw || raw.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(raw)) return;
      let url: URL;
      try {
        url = new URL(raw, pageUrl);
      } catch {
        return;
      }
      if (!/^https?:$/.test(url.protocol) || url.host !== host || /^\/wp-(admin|login|json)/.test(url.pathname)) return;
      url.hash = '';
      found.add(url.href);
    });
  }
  return [...found];
}

export async function buildReport({ jobId, client, log = console.log }: { jobId: string; client: WpClient; log?: (msg: string) => void }): Promise<Report> {
  const state = await loadRunState(jobId);
  const { plan } = await loadPlan(jobId, state.planVersion);
  const blank = (): KindCounts => ({ planned: 0, created: 0, updated: 0, failed: 0, live: 0, invalidBlocks: 0 });
  const counts: Record<EntityKind, KindCounts> = {
    page: blank(), post: blank(), document: blank(), image: blank(), event: blank(), person: blank(), form: blank(), record: blank(),
  };
  counts.page.planned = plan.expected.pages;
  counts.post.planned = plan.expected.posts;
  counts.document.planned = plan.expected.documents;
  counts.image.planned = plan.expected.images;
  counts.event.planned = plan.expected.events;
  counts.person.planned = plan.expected.people;
  counts.form.planned = plan.expected.forms;
  counts.record.planned = plan.expected.records;
  // Plugin blocks the content uses (forms) must be known to the validator.
  if (plan.forms.some((f) => f.action === 'rebuild')) externalBlock('gravityforms/form', { formId: '', title: false });
  // An item failed if the run left nothing for it; later-step failures (relink, publish, redirect
  // import) are listed in the report but don't make an existing object count as failed.
  for (const key of new Set(state.failures.filter((f) => f.kind in counts && !state.entities[f.sourceKey]).map((f) => f.sourceKey))) {
    counts[state.failures.find((f) => f.sourceKey === key)!.kind as EntityKind].failed++;
  }

  const notLive: Report['notLive'] = [];
  const invalid: Report['invalid'] = [];
  const warnings: Record<string, number> = {};
  const entities = Object.entries(state.entities);
  // Every same-site link and image on the migrated pages → the pages it's on.
  const linksOn = new Map<string, Set<string>>();
  const collectLinks = (html: string, page: string) => {
    for (const url of linksIn(html, client.baseUrl + page)) linksOn.set(url, (linksOn.get(url) ?? new Set()).add(page));
  };
  log(`Verifying ${entities.length} objects on ${client.baseUrl}`);
  await mapLimit(entities, 6, async ([key, e]) => {
    counts[e.kind][e.action]++;
    for (const w of e.warnings) {
      const kind = w.replace(/\d+/g, 'N').replace(/:.*$/, '');
      warnings[kind] = (warnings[kind] ?? 0) + 1;
    }
    if (e.path) {
      const file = e.kind === 'document' || e.kind === 'image';
      const res = await safeFetch(client.baseUrl + e.path, { method: file ? 'HEAD' : 'GET', redirect: 'manual' });
      if (res.status === 200) counts[e.kind].live++;
      else notLive.push({ sourceKey: key, path: e.path, status: res.status });
      if (!file && res.status === 200) collectLinks(await res.text(), e.path);
      else await res.body?.cancel();
    } else {
      counts[e.kind].live++; // no URL of its own (forms): existence is what was checked
    }
    if (e.kind === 'page' || e.kind === 'post') {
      const post = await client.get<{ content: { raw: string } }>(`/wp/v2/${e.kind}s/${e.id}`, { context: 'edit', _fields: 'content' });
      const v = validateSerialized(post.content.raw);
      const errors = v.errors.filter((x) => x.kind !== 'drift').map((x) => `${x.kind} ${x.name} @${x.path}`);
      if (errors.length || plan.target.disabledBlocks.some((b) => v.names.includes(b))) {
        counts[e.kind].invalidBlocks++;
        invalid.push({ sourceKey: key, errors: [...errors, ...plan.target.disabledBlocks.filter((b) => v.names.includes(b)).map((b) => `disabled ${b}`)] });
      }
    }
  });

  // Each linked URL once: HEAD, or GET where HEAD isn't allowed; redirects followed.
  log(`Checking ${linksOn.size} links and images`);
  const brokenLinks: NonNullable<Report['links']>['broken'] = [];
  await mapLimit([...linksOn], 6, async ([url, pages]) => {
    let status = 0;
    try {
      let res = await safeFetch(url, { method: 'HEAD', redirect: 'follow' });
      if (res.status === 405 || res.status === 501) res = await safeFetch(url, { method: 'GET', redirect: 'follow' });
      status = res.status;
      await res.body?.cancel();
    } catch {
      status = 0;
    }
    if (status !== 200) brokenLinks.push({ url, status, pageCount: pages.size, pages: [...pages].slice(0, 5) });
  });
  brokenLinks.sort((a, b) => b.pageCount - a.pageCount || a.url.localeCompare(b.url));

  let working: number | null = null;
  const broken: Report['redirects']['broken'] = [];
  if (state.redirectImport) {
    working = 0;
    await mapLimit(state.redirects, 6, async (r) => {
      const res = await safeFetch(client.baseUrl + r.from, { redirect: 'manual' });
      await res.body?.cancel();
      const location = res.headers.get('location') ?? '';
      if (res.status === 301 && new URL(location, client.baseUrl).pathname === r.to) working!++;
      else broken.push({ ...r, got: `${res.status} ${location}` });
    });
  }

  const report: Report = {
    jobId,
    planVersion: state.planVersion,
    approvedBy: state.approvedBy,
    ranAt: state.startedAt,
    target: client.baseUrl,
    counts,
    cleanup: { planned: plan.cleanup.length, trashed: Object.values(state.cleanup).filter((s) => s === 'trashed' || s === 'already-trashed').length },
    redirects: {
      total: state.redirects.length,
      imported: state.redirectImport ? state.redirectImport.imported + state.redirectImport.updated + state.redirectImport.skipped : null,
      working,
      broken,
    },
    failures: state.failures,
    notLive,
    invalid,
    warnings,
    site: state.site,
    links: { checked: linksOn.size, broken: brokenLinks },
  };

  await writeJson(jobPath(jobId, 'report', 'report.json'), report);
  await writeFile(jobPath(jobId, 'report', 'report.md'), renderReport(report));
  const csv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
  const sources = new Map([...plan.items, ...plan.media].map((i) => [i.sourceKey, i.sourceUrl]));
  await writeFile(
    jobPath(jobId, 'report', 'url-map.csv'),
    csv([['source_url', 'type', 'new_url'], ...entities.map(([k, e]) => [sources.get(k) ?? k, e.kind, client.baseUrl + e.path])]),
  );
  await writeFile(jobPath(jobId, 'report', 'redirects.csv'), csv([['source', 'target', 'code'], ...state.redirects.map((r) => [r.from, r.to, '301'])]));
  return report;
}

export function renderReport(r: Report): string {
  const rows = (Object.entries(r.counts) as [EntityKind, KindCounts][]).filter(([, c]) => c.planned || c.created || c.updated || c.failed).map(
    ([kind, c]) => `| ${kind} | ${c.planned} | ${c.created} | ${c.updated} | ${c.failed} | ${c.planned - c.created - c.updated - c.failed} | ${c.live} | ${c.invalidBlocks} |`,
  );
  const out = [
    `# Migration report: ${r.jobId}`,
    '',
    `Plan v${r.planVersion}, approved by ${r.approvedBy}. Run started ${r.ranAt} against ${r.target}.`,
    '',
    '| Type | Planned | Created | Updated | Failed | Not done | Live (200) | Block problems |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Existing content trashed: ${r.cleanup.trashed} of ${r.cleanup.planned}. Redirects: ${r.redirects.total}` +
      (r.redirects.imported === null
        ? ' (written to redirects.csv; Redirection is not active).'
        : `, ${r.redirects.imported} in Redirection, ${r.redirects.working} answering 301 to the right page.`),
    '',
  ];
  if (r.failures.length) out.push('## Failures', '', ...r.failures.map((f) => `- ${f.kind} \`${f.sourceKey}\` at ${f.step}: ${f.error}`), '');
  if (r.notLive.length) out.push('## Not answering 200', '', ...r.notLive.map((n) => `- \`${n.path}\` → ${n.status} (${n.sourceKey})`), '');
  if (r.site) {
    out.push('## Site structure', '', `Homepage slides: ${r.site.homeSlides}. Quick links: ${r.site.homeQuickLinks ?? 0}. Menus: ${Object.entries(r.site.menus).map(([n, c]) => `${n} (${c} items)`).join(', ') || 'none'}.`, '');
    if (r.site.warnings.length) out.push(...r.site.warnings.map((w) => `- ${w}`), '');
  }
  if (r.links?.broken.length) out.push(`## Broken links and images (${r.links.broken.length} of ${r.links.checked})`, '', ...r.links.broken.map((b) => `- \`${b.url}\` → ${b.status || 'no answer'} (on ${b.pageCount} page(s), e.g. ${b.pages[0]})`), '');
  if (r.redirects.broken.length) out.push('## Redirects not working', '', ...r.redirects.broken.map((b) => `- \`${b.from}\` → expected \`${b.to}\`, got ${b.got}`), '');
  if (r.invalid.length) out.push('## Block problems', '', ...r.invalid.map((i) => `- \`${i.sourceKey}\`: ${i.errors.join('; ')}`), '');
  const w = Object.entries(r.warnings).sort((a, b) => b[1] - a[1]);
  if (w.length) out.push('## Warnings', '', '| Warning | Items |', '|---|---|', ...w.map(([k, n]) => `| ${k} | ${n} |`), '');
  return out.join('\n');
}
