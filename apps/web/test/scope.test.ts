import { expect, it } from 'vitest';
import type { PostLaunchReport, Report } from '@wm/executor';
import type { Plan } from '@wm/planner';
import type { QaReport } from '@wm/qa';
import { scopeChecklist } from '../lib/scope';

const plan = {
  target: { wordpress: '7.0.4', theme: 'planeteriaweb', redirection: true },
  site: { menus: [{ name: 'Main Menu', items: [{}] }] },
  forms: [{ action: 'rebuild' }, { action: 'flag' }],
  notMigrated: [{}],
  expected: { posts: 2, events: 1, forms: 1, documents: 1 },
} as unknown as Plan;
const counts = (live: number) => Object.fromEntries(['page', 'post', 'document', 'image', 'event', 'person', 'form', 'record'].map((k) => [k, { planned: 1, created: 1, updated: 0, failed: 0, live, invalidBlocks: 0 }]));
const report = {
  planVersion: 3,
  ranAt: '2026-10-14T10:00:00Z',
  counts: counts(1),
  redirects: { total: 4, imported: 4, working: 4, broken: [] },
  links: { checked: 10, broken: [] },
  site: { menus: { 'Main Menu': 5 }, options: {}, homeSlides: 3, warnings: [] },
} as unknown as Report;
const qa = { planVersion: 3, pages: [{}, {}], rules: [], overflow: { mobile: [] } } as unknown as QaReport;
const postlaunch = { ranAt: '2026-10-14T11:00:00Z', checked: 4, ok: 4, problems: [], leftOut: [], base: 'https://x.test', ga4: { expected: 'G-ABC123', found: ['G-ABC123'] } } as unknown as PostLaunchReport;
const status = (lines: ReturnType<typeof scopeChecklist>) => Object.fromEntries(lines.map((l) => [l.line.split(' ')[0] + ' ' + l.line.split(' ')[1], l.status]));

it('marks each statement-of-work line from this migration’s results', () => {
  expect(status(scopeChecklist(plan, report, qa, postlaunch))).toEqual({
    'WordPress CMS': 'n/a',
    'Responsive Planeteria': 'partial', // branding waits on the style guide
    'Lift-and-shift of': 'done',
    'Implementation of': 'done',
    'News, events/calendar,': 'partial', // one form flagged
    'Navigation, header/footer,': 'partial', // header waits on theme change T1
    'Basic accessibility': 'done',
    '301 redirects': 'done',
    'Analytics setup,': 'done',
  });
});

it('ignores QA of another plan version and a post-launch check older than the migration', () => {
  const lines = status(scopeChecklist(plan, report, { ...qa, planVersion: 2 }, { ...postlaunch, ranAt: '2026-10-14T09:00:00Z' }));
  expect(lines['Basic accessibility']).toBe('not yet');
  expect(lines['Analytics setup,']).toBe('not yet');
});

it('reports what failed rather than done', () => {
  const broken = { ...report, counts: counts(0), redirects: { ...report.redirects, working: 3 }, site: { ...report.site!, menus: { 'Main Menu': 0 } } } as unknown as Report;
  const lines = status(scopeChecklist(plan, broken, qa, { ...postlaunch, ga4: { expected: 'G-ABC123', found: [] } }));
  expect([lines['Lift-and-shift of'], lines['Implementation of'], lines['301 redirects'], lines['Analytics setup,']]).toEqual(['partial', 'not yet', 'partial', 'partial']);
});
