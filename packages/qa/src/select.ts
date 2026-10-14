import { createHash } from 'node:crypto';
import type { Plan } from '@wm/planner';

export interface QaPage {
  /** Root-relative path on the target. */
  path: string;
  /** The template it stands for, or null for a sampled page. */
  template: string | null;
  sourceKey: string | null;
}

/** What QA needs from the run: where each migrated object ended up. */
export interface RunEntities {
  entities: Record<string, { kind: string; path: string }>;
}

/**
 * One page per template the site uses, plus a sample of other migrated pages. The sample is fixed for
 * a plan (seeded by its hash), so re-runs compare like with like.
 */
export function selectPages(plan: Plan, planSha256: string, run: RunEntities, sampleSize = 20): QaPage[] {
  const path = (key: string | undefined) => (key ? run.entities[key]?.path : undefined) || null;
  const pages: QaPage[] = [];
  const add = (template: string, p: string | null, sourceKey: string | null = null) => {
    if (p && !pages.some((x) => x.path === p)) pages.push({ path: p, template, sourceKey });
  };

  add('Homepage', '/');
  const page = plan.items.find((i) => i.type === 'page' && !i.forms.length);
  add('Page', path(page?.sourceKey), page?.sourceKey ?? null);
  const post = plan.items.find((i) => i.type === 'post');
  add('News post', path(post?.sourceKey), post?.sourceKey ?? null);
  const news = plan.keep.find((k) => /News listing/.test(k.reason));
  add('News listing', news ? new URL(news.link).pathname : null);
  const formPage = plan.items.find((i) => i.forms.length);
  add('Form page', path(formPage?.sourceKey), formPage?.sourceKey ?? null);
  const event = plan.events[0];
  add('Event', path(event?.key), event?.key ?? null);
  if (plan.events.length) add('Events listing', '/events/');
  for (const ct of plan.contentTypes) {
    const entry = plan.records.find((r) => r.postType === ct.postType);
    add(`${ct.singular} entry`, path(entry?.sourceKey), entry?.sourceKey ?? null);
    add(`${ct.label} listing`, path(`listing:${ct.postType}`));
  }
  const table = plan.tables[0];
  add('Table page', path(table ? `table:${table.key}` : undefined));

  // The sample: ordered by a hash of the plan and each key, so it's stable for a plan but not biased
  // toward any part of the site.
  const rank = (key: string) => createHash('sha256').update(planSha256 + key).digest('hex');
  const candidates = plan.items
    .map((i) => ({ key: i.sourceKey, p: path(i.sourceKey) }))
    .filter((c): c is { key: string; p: string } => !!c.p && !pages.some((x) => x.path === c.p))
    .sort((a, b) => rank(a.key).localeCompare(rank(b.key)))
    .slice(0, sampleSize);
  for (const c of candidates) pages.push({ path: c.p, template: null, sourceKey: c.key });
  return pages;
}

export interface PageResult extends QaPage {
  status: number;
  violations: { id: string; impact: string | null; help: string; helpUrl: string; nodes: number; sample: string }[];
  /** Viewport width → the page is wider than the viewport (sideways scrolling). */
  overflow: Record<string, boolean>;
  screenshots: Record<string, string>;
}

export interface RuleSummary {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  /** On every page checked: comes from the theme (header, footer, templates), not the content. */
  siteWide: boolean;
  pages: string[];
  nodes: number;
  sample: string;
}

const IMPACT = ['critical', 'serious', 'moderate', 'minor'];

/** Violations grouped by rule, worst first; rules on every checked page are site-wide. */
export function summarize(results: PageResult[]): RuleSummary[] {
  const checked = results.filter((r) => r.status === 200);
  const rules = new Map<string, RuleSummary>();
  for (const page of checked) {
    for (const v of page.violations) {
      const rule = rules.get(v.id) ?? { id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, siteWide: false, pages: [], nodes: 0, sample: v.sample };
      rule.pages.push(page.path);
      rule.nodes += v.nodes;
      rules.set(v.id, rule);
    }
  }
  for (const rule of rules.values()) rule.siteWide = checked.length > 1 && rule.pages.length === checked.length;
  const rankOf = (impact: string | null) => (impact ? IMPACT.indexOf(impact) : IMPACT.length);
  return [...rules.values()].sort((a, b) => rankOf(a.impact) - rankOf(b.impact) || b.pages.length - a.pages.length);
}
