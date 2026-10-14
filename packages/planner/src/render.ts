import type { Plan } from './schema.js';

/** The plan as Markdown, for review before approval. */
export function renderPlan(plan: Plan): string {
  const e = plan.expected;
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out: string[] = [];

  out.push(`# Migration plan: ${plan.jobId} v${plan.version}`, '');
  out.push(`Created ${plan.createdAt}. Source ${plan.source.origin} (${plan.source.profile}). Target ${plan.target.name}: ${plan.target.url} (WordPress ${plan.target.wordpress}, theme ${plan.target.theme}).`, '');
  out.push('Approve with `wm approve --job ' + plan.jobId + ' --by "<your name>"`. Execution follows this exact plan.', '');

  out.push('## Summary', '', '| | Count |', '|---|---|');
  out.push(`| Pages | ${e.pages} |`, `| News posts | ${e.posts} |`, `| Documents | ${e.documents} (${mb(plan.media.filter((m) => m.type === 'document').reduce((n, m) => n + m.bytes, 0))}) |`);
  out.push(`| Images | ${e.images} |`, `| Categories | ${e.categories} |`, `| Redirects | ${e.redirects} |`, `| Existing content to trash | ${e.cleanup} |`, `| Not migrated (this milestone) | ${plan.notMigrated.length} |`, '');

  if (plan.warnings.length) out.push('## Warnings', '', ...plan.warnings.map((w) => `- ${w}`), '');

  out.push('## Existing content on the target', '');
  out.push('**Kept:**', '', ...plan.keep.map((k) => `- ${k.type} #${k.id} "${k.title}": ${k.reason}`), '');
  out.push('**Moved to the trash on execute:**', '', ...plan.cleanup.map((c) => `- ${c.type} #${c.id} "${cell(c.title) || '(no title)'}"`), '');

  if (plan.categories.length) out.push('## News categories', '', plan.categories.join(' · '), '');

  for (const type of ['page', 'post'] as const) {
    const rows = plan.items.filter((i) => i.type === type);
    out.push(`## ${type === 'page' ? 'Pages' : 'News posts'} (${rows.length})`, '');
    out.push(`| Title | New URL | ${type === 'post' ? 'Date | Category | ' : ''}Redirected from | Notes |`);
    out.push(`|---|---|${type === 'post' ? '---|---|' : ''}---|---|`);
    for (const i of rows) {
      const post = type === 'post' ? `${i.date ?? ''} | ${i.categories.join(', ')} | ` : '';
      out.push(`| ${cell(i.title)} | \`${i.targetPath}\` | ${post}${i.redirectFrom.map((r) => `\`${r}\``).join('<br>')} | ${cell(i.warnings.join('; '))} |`);
    }
    out.push('');
  }

  out.push(`## Media (${plan.media.length})`, '', '| File | Type | Size | Used on | Redirected from |', '|---|---|---|---|---|');
  for (const m of plan.media) {
    out.push(`| ${cell(m.filename)} | ${m.type} | ${m.bytes ? mb(m.bytes) : '—'} | ${m.usedBy.length} page(s) | ${m.redirectFrom.map((r) => `\`${r}\``).join('<br>')} |`);
  }
  out.push('');

  out.push(`## Not migrated in this plan (${plan.notMigrated.length})`, '');
  const byReason = new Map<string, Plan['notMigrated']>();
  for (const s of plan.notMigrated) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s]);
  for (const [reason, rows] of byReason) {
    out.push(`### ${reason} (${rows.length})`, '', ...rows.map((s) => `- ${cell(s.title) || s.sourceKey} (\`${s.sourceKey}\`)`), '');
  }
  return out.join('\n');
}
