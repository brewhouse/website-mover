import { expect, it } from 'vitest';
import type { Plan } from '@wm/planner';
import { selectPages, summarize, type PageResult } from '../src/select.js';

// The parts of a plan QA looks at.
const item = (key: string, type: 'page' | 'post', forms: string[] = []) => ({ sourceKey: key, type, forms });
const plan = {
  items: [item('a.org/about', 'page'), item('a.org/news-1', 'post'), item('a.org/apply', 'page', ['form-1']), ...Array.from({ length: 40 }, (_, i) => item(`a.org/p${i}`, 'page'))],
  keep: [{ id: 1, type: 'page', title: 'News', link: 'http://site.test/news/', reason: 'News listing page (framework News template)' }],
  events: [{ key: 'meeting:1' }],
  contentTypes: [{ postType: 'community', label: 'Communities', singular: 'Community' }],
  records: [{ sourceKey: 'a.org/locations/detail/1', postType: 'community' }],
  tables: [{ key: 'payment-standards' }],
} as unknown as Plan;
const entities: Record<string, { kind: string; path: string }> = {
  'a.org/about': { kind: 'page', path: '/about/' },
  'a.org/news-1': { kind: 'post', path: '/news-1/' },
  'a.org/apply': { kind: 'page', path: '/apply/' },
  'meeting:1': { kind: 'event', path: '/event/board/' },
  'a.org/locations/detail/1': { kind: 'record', path: '/communities/one/' },
  'listing:community': { kind: 'page', path: '/communities/' },
  'table:payment-standards': { kind: 'page', path: '/payment-standards/' },
  ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a.org/p${i}`, { kind: 'page', path: `/p${i}/` }])),
};

it('checks one page per template the site uses, then a sample that is stable for a plan', () => {
  const pages = selectPages(plan, 'sha-1', { entities }, 5);
  expect(pages.filter((p) => p.template).map((p) => [p.template, p.path])).toEqual([
    ['Homepage', '/'],
    ['Page', '/about/'],
    ['News post', '/news-1/'],
    ['News listing', '/news/'],
    ['Form page', '/apply/'],
    ['Event', '/event/board/'],
    ['Events listing', '/events/'],
    ['Community entry', '/communities/one/'],
    ['Communities listing', '/communities/'],
    ['Table page', '/payment-standards/'],
  ]);
  const sample = pages.filter((p) => !p.template);
  expect(sample).toHaveLength(5);
  expect(sample.every((p) => /^\/p\d+\/$/.test(p.path))).toBe(true);
  // Same plan, same sample; another plan, another sample.
  expect(selectPages(plan, 'sha-1', { entities }, 5)).toEqual(pages);
  expect(selectPages(plan, 'sha-2', { entities }, 5).filter((p) => !p.template)).not.toEqual(sample);
});

it('groups violations by rule, worst first, and marks rules on every page as site-wide', () => {
  const page = (path: string, ids: [string, string][], status = 200): PageResult => ({
    path,
    template: null,
    sourceKey: null,
    status,
    overflow: {},
    screenshots: {},
    violations: ids.map(([id, impact]) => ({ id, impact, help: id, helpUrl: '', nodes: 2, sample: `<${id}>` })),
  });
  const rules = summarize([
    page('/a/', [['landmark-one-main', 'moderate'], ['image-alt', 'critical']]),
    page('/b/', [['landmark-one-main', 'moderate']]),
    page('/c/', [['landmark-one-main', 'moderate']]),
    // A page that didn't load doesn't count against "every page".
    page('/gone/', [], 404),
  ]);
  expect(rules.map((r) => [r.id, r.impact, r.pages, r.siteWide, r.nodes])).toEqual([
    ['image-alt', 'critical', ['/a/'], false, 2],
    ['landmark-one-main', 'moderate', ['/a/', '/b/', '/c/'], true, 6],
  ]);
});
