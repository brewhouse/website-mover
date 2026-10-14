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
  out.push(`| Images | ${e.images} |`, `| Categories | ${e.categories} |`);
  if (plan.events.length) out.push(`| Events (meetings) | ${e.events} |`);
  if (plan.people.length) out.push(`| People | ${e.people} |`);
  if (plan.forms.length) out.push(`| Forms rebuilt | ${e.forms} (${plan.forms.length - e.forms} flagged) |`);
  if (plan.records.length) out.push(`| Custom-type entries | ${e.records} |`);
  if (plan.tables.length) out.push(`| Tables | ${e.tables} |`);
  out.push(`| Redirects | ${e.redirects} |`, `| Existing content to trash | ${e.cleanup} |`, `| Not migrated | ${plan.notMigrated.length} |`, '');

  if (plan.warnings.length) out.push('## Warnings', '', ...plan.warnings.map((w) => `- ${w}`), '');

  out.push('## Existing content on the target', '');
  out.push('**Kept:**', '', ...plan.keep.map((k) => `- ${k.type} #${k.id} "${k.title}": ${k.reason}`), '');
  out.push('**Moved to the trash on execute:**', '', ...plan.cleanup.map((c) => `- ${c.type} #${c.id} "${cell(c.title) || '(no title)'}"${c.reason ? `: ${c.reason}` : ''}`), '');

  if (plan.settings.length) {
    out.push('## Site settings changed', '', '| Setting | Now | Becomes | Why |', '|---|---|---|---|');
    out.push(...plan.settings.map((s) => `| ${s.key} | ${s.from} | ${s.to} | ${cell(s.reason)} |`), '');
  }
  if (plan.categories.length) out.push('## News categories', '', plan.categories.join(' · '), '');

  if (plan.events.length) {
    out.push(`## Events: meetings (${plan.events.length})`, '', `Categories: ${plan.eventCategories.join(' · ')}`, '');
    out.push('| Date | Time | Title | Category | Documents | Merged pages | Notes |', '|---|---|---|---|---|---|---|');
    for (const ev of [...plan.events].sort((a, b) => b.date.localeCompare(a.date))) {
      const time = ev.startTime ? `${ev.startTime}${ev.endTime ? `–${ev.endTime}` : ''}` : 'all day';
      const notes = [ev.cancelled ? 'cancelled' : '', ev.recordings.length ? `${ev.recordings.length} recording(s)` : '', ...ev.warnings].filter(Boolean).join('; ');
      out.push(`| ${ev.date} | ${time} | ${cell(ev.title)} | ${ev.category} | ${ev.documents.length} | ${ev.sourceKeys.length} | ${cell(notes)} |`);
    }
    out.push('');
  }
  if (plan.people.length) {
    out.push(`## People (${plan.people.length})`, '', '| Name | Role | Group | Email | Photo |', '|---|---|---|---|---|');
    out.push(...plan.people.map((p) => `| ${cell(p.name)} | ${cell(p.role ?? '')} | ${p.group} | ${p.email ? 'yes' : '—'} | ${p.photo ? 'yes' : '—'} |`), '');
  }
  if (plan.forms.length) {
    out.push(`## Forms (${plan.forms.length})`, '', '| Form | Page | Action | Fields | Notes |', '|---|---|---|---|---|');
    out.push(...plan.forms.map((f) => `| ${cell(f.title)} | \`${f.pageKey}\` | ${f.action} | ${f.fields.length} | ${cell(f.reason)}${f.uploads ? ' File uploads.' : ''} |`), '');
  }
  for (const ct of plan.contentTypes) {
    const entries = plan.records.filter((r) => r.postType === ct.postType);
    out.push(`## New content type: ${ct.label} (${entries.length})`, '');
    out.push(`Post type \`${ct.postType}\` at \`/${ct.rewriteSlug}/…\`${ct.taxonomy ? `, taxonomy \`${ct.taxonomy.name}\`` : ''}. Fields: ${Object.values(ct.fields).join(', ')}. Listing page \`${ct.listing.targetPath}\` "${cell(ct.listing.title)}".`, '');
    out.push('| Title | New URL | Type | Redirected from |', '|---|---|---|---|');
    out.push(...entries.map((r) => `| ${cell(r.title)} | \`${r.targetPath}\` | ${r.term ?? ''} | ${r.redirectFrom.map((x) => `\`${x}\``).join('<br>')} |`), '');
  }
  for (const tb of plan.tables) {
    out.push(`## Table page: ${cell(tb.title)}`, '', `\`${tb.targetPath}\`: ${tb.rows.length} rows × ${tb.columns.length} columns (${tb.columns.join(', ')}), assembled from ${tb.sourceKeys.length} source pages, which all redirect here.`, '');
  }
  if (plan.documentTypes.length) {
    const counts = plan.documentTypes.map((d) => `${d} (${plan.media.filter((m) => m.documentType === d).length})`);
    out.push('## Document types', '', counts.join(' · '), '');
  }

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
