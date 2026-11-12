/** design/plan/plan.vN.md: the design plan for reviewers. */
import type { DesignPlan, PlanField, PlanMenuItemT } from './plan-schema.js';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (s: string | null, n = 50) => (s ? esc(s.length > n ? `${s.slice(0, n - 1)}…` : s) : '');

export function renderDesignPlan(plan: DesignPlan): string {
  const e = plan.expected;
  const out: string[] = [
    `# Design plan v${plan.version}: ${plan.jobId}`,
    '',
    `Made ${plan.createdAt.slice(0, 16).replace('T', ' ')} UTC for ${plan.inputs.targetUrl} (schema read ${plan.inputs.schemaReadAt.slice(0, 16).replace('T', ' ')}), theme \`${plan.inputs.theme}\`. Proposed by the rules${plan.proposedBy.ai ? ` and refined by ${plan.proposedBy.ai}` : ''}.`,
    '',
    '## Summary',
    '',
    `- **Templates:** ${plan.templates.length} (${e.templates.update} framework files restyled, ${e.templates.create} new${plan.templates.some((t) => t.action === 'plugin') ? `, ${plan.templates.filter((t) => t.action === 'plugin').length} plugin views` : ''}).`,
    `- **Post types:** ${plan.postTypes.length} used, ${e.postTypes} new. **Taxonomies:** ${plan.taxonomies.length} used, ${e.taxonomies} new.`,
    `- **Fields:** ${e.fields} new, in ${e.fieldGroups.extend} existing groups and ${e.fieldGroups.create} new ones.`,
    `- **Blocks:** ${e.blocks.update} restyled, ${e.blocks.create} new.`,
    `- **Sample content:** ${e.entries} pages and entries, ${e.media} images.`,
    `- **Warnings:** ${plan.warnings.length}.`,
    '',
    '## Templates',
    '',
    '| Mockup | Kind | Theme file | Parts |',
    '|---|---|---|---|',
  ];
  for (const t of plan.templates) {
    const parts = t.parts.map((p) => `${p.component}${p.collection !== null ? ' (list)' : ''}: ${p.binding}${p.postType ? ` ${p.postType}` : ''}${p.taxonomy ? ` ${p.taxonomy}` : ''}${p.block ? ` ${p.block}` : ''}`).join('<br>');
    out.push(`| ${t.page} | ${t.kind}${t.postType ? ` (${t.postType})` : ''} | ${t.file ? `\`${t.file}\` ${t.action === 'update' ? 'restyled' : 'new'}` : 'plugin views'} | ${parts} |`);
  }

  out.push('', '## Post types', '', '| Name | Label | | Taxonomies | Shown on |', '|---|---|---|---|---|');
  for (const pt of plan.postTypes) out.push(`| \`${pt.name}\` | ${pt.label} | ${pt.action === 'create' ? '**new**' : 'existing'} | ${pt.taxonomies.join(', ') || '—'} | ${short(pt.from.join(', '), 80)} |`);
  if (plan.taxonomies.length) {
    out.push('', '## Taxonomies', '', '| Name | Label | | Post types | Terms (from the mockups) |', '|---|---|---|---|---|');
    for (const t of plan.taxonomies) out.push(`| \`${t.name}\` | ${t.label} | ${t.action === 'create' ? '**new**' : 'existing'} | ${t.postTypes.join(', ')} | ${short(t.terms.join(', '), 80)} |`);
  }
  if (plan.relations.length) {
    out.push('', '## Linked entries', '', 'A post-object field on each post type points at an entry of another type. Listing pages filter by it (`?param=slug`), and lists on that entry\'s own page show only its entries.', '', '| Field | Points at | On | Filter drop-downs |', '|---|---|---|---|');
    for (const r of plan.relations) out.push(`| \`${r.name}\` (${r.label}) | \`${r.relatesTo}\` | ${r.on.map((o) => `\`${o.postType}\``).join(', ')} | ${r.filters.map((f) => `${f.page} "${esc(f.label)}"${f.themed ? '' : ' (plugin view)'}`).join(', ')} |`);
  }

  out.push('', '## Field groups', '');
  const fieldRow = (f: Omit<PlanField, 'subFields'>, indent = '') => `| ${indent}${f.action === 'add' ? '**new**' : 'existing'} | \`${f.name}\` | ${esc(f.label)} | ${f.type}${f.relatesTo ? ` → \`${f.relatesTo}\`` : ''} | ${short(f.sample)} | ${f.source ? `${f.source.page} ${f.source.component}` : ''} |`;
  for (const g of plan.fieldGroups) {
    out.push(`### ${g.title} (\`${g.key}\`, ${g.action === 'create' ? 'new group' : g.action === 'extend' ? 'existing group, fields added' : 'existing, unchanged'})`, '', `Shown where ${g.location.param} = \`${g.location.value}\`.`, '', '| | Name | Label | Type | Mockup sample | From |', '|---|---|---|---|---|---|');
    for (const f of g.fields) {
      out.push(fieldRow(f));
      for (const sf of f.subFields) out.push(fieldRow(sf, '↳ '));
    }
    out.push('');
  }

  if (plan.blocks.length) {
    out.push('## Blocks', '', '| Block | Title | | Template | From |', '|---|---|---|---|---|');
    for (const b of plan.blocks) out.push(`| \`acf/${b.name}\` | ${b.title} | ${b.action === 'update' ? 'restyled' : b.action === 'create' ? '**new**' : 'existing'} | \`${b.template}\` | ${b.from.page} ${b.from.component} |`);
    out.push('');
  }

  out.push('## Menus', '');
  const walk = (items: PlanMenuItemT[], depth: number) => {
    for (const i of items) {
      out.push(`${'  '.repeat(depth)}- ${i.label}${i.target ? ` → ${i.target}` : i.href && i.href !== '#' ? ` → ${i.href} (custom link)` : ''}`);
      walk(i.children, depth + 1);
    }
  };
  for (const m of plan.menus) {
    out.push(`**${m.name}** (from \`${m.source}\`):`, '');
    walk(m.items, 0);
    out.push('');
  }

  out.push('## Sample content', '');
  const byType = new Map<string, DesignPlan['entries']>();
  for (const en of plan.entries) byType.set(en.postType, [...(byType.get(en.postType) ?? []), en]);
  for (const [type, list] of byType) {
    out.push(`- **${type}** (${list.length}): ${list.map((x) => `${short(x.title, 40)}${x.frontPage ? ' (front page)' : ''}${x.template ? ` [${x.template}]` : ''}`).join('; ')}`);
  }
  const bytes = plan.media.reduce((n, m) => n + (m.bytes ?? 0), 0);
  out.push('', `**Images:** ${plan.media.length} (${(bytes / 1024 / 1024).toFixed(1)} MB in the mockups; large ones are resized before upload).`, '');

  out.push('## Warnings', '');
  out.push(...(plan.warnings.length ? plan.warnings.map((w) => `- ${w}`) : ['None.']));
  out.push('');
  return out.join('\n');
}
