import { writeFile } from 'node:fs/promises';
import { validateSerialized } from '@wm/blocks';
import { jobPath, writeJson } from '@wm/core';
import { loadPlan } from '@wm/planner';
import type { WpClient } from '@wm/wp-client';
import { loadRunState, mapLimit, type EntityKind } from './execute.js';

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
  redirects: { total: number; imported: number | null };
  failures: { sourceKey: string; kind: string; step: string; error: string }[];
  notLive: { sourceKey: string; path: string; status: number }[];
  invalid: { sourceKey: string; errors: string[] }[];
  warnings: Record<string, number>;
}

/** Checks the run against the target and writes report.json/.md, url-map.csv and redirects.csv. */
export async function buildReport({ jobId, client, log = console.log }: { jobId: string; client: WpClient; log?: (msg: string) => void }): Promise<Report> {
  const state = await loadRunState(jobId);
  const { plan } = await loadPlan(jobId, state.planVersion);
  const blank = (): KindCounts => ({ planned: 0, created: 0, updated: 0, failed: 0, live: 0, invalidBlocks: 0 });
  const counts: Record<EntityKind, KindCounts> = { page: blank(), post: blank(), document: blank(), image: blank() };
  counts.page.planned = plan.expected.pages;
  counts.post.planned = plan.expected.posts;
  counts.document.planned = plan.expected.documents;
  counts.image.planned = plan.expected.images;
  for (const f of state.failures) counts[f.kind].failed++;

  const notLive: Report['notLive'] = [];
  const invalid: Report['invalid'] = [];
  const warnings: Record<string, number> = {};
  const entities = Object.entries(state.entities);
  log(`Verifying ${entities.length} objects on ${client.baseUrl}`);
  await mapLimit(entities, 6, async ([key, e]) => {
    counts[e.kind][e.action]++;
    for (const w of e.warnings) {
      const kind = w.replace(/\d+/g, 'N').replace(/:.*$/, '');
      warnings[kind] = (warnings[kind] ?? 0) + 1;
    }
    const res = await fetch(client.baseUrl + e.path, { method: e.kind === 'page' || e.kind === 'post' ? 'GET' : 'HEAD', redirect: 'manual' });
    if (res.status === 200) counts[e.kind].live++;
    else notLive.push({ sourceKey: key, path: e.path, status: res.status });
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

  const report: Report = {
    jobId,
    planVersion: state.planVersion,
    approvedBy: state.approvedBy,
    ranAt: state.startedAt,
    target: client.baseUrl,
    counts,
    cleanup: { planned: plan.cleanup.length, trashed: Object.values(state.cleanup).filter((s) => s === 'trashed' || s === 'already-trashed').length },
    redirects: { total: state.redirects.length, imported: state.redirectImport?.imported ?? null },
    failures: state.failures,
    notLive,
    invalid,
    warnings,
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
  const rows = (Object.entries(r.counts) as [EntityKind, KindCounts][]).map(
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
      (r.redirects.imported === null ? ' (written to redirects.csv; Redirection is not active).' : `, ${r.redirects.imported} imported into Redirection.`),
    '',
  ];
  if (r.failures.length) out.push('## Failures', '', ...r.failures.map((f) => `- ${f.kind} \`${f.sourceKey}\` at ${f.step}: ${f.error}`), '');
  if (r.notLive.length) out.push('## Not answering 200', '', ...r.notLive.map((n) => `- \`${n.path}\` → ${n.status} (${n.sourceKey})`), '');
  if (r.invalid.length) out.push('## Block problems', '', ...r.invalid.map((i) => `- \`${i.sourceKey}\`: ${i.errors.join('; ')}`), '');
  const w = Object.entries(r.warnings).sort((a, b) => b[1] - a[1]);
  if (w.length) out.push('## Warnings', '', '| Warning | Items |', '|---|---|', ...w.map(([k, n]) => `| ${k} | ${n} |`), '');
  return out.join('\n');
}
