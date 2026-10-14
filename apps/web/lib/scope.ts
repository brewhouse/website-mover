/**
 * The scope checklist (PLAN §6.13, §13): each line of the public-sector statement of work, marked
 * done / partial / n/a from this job's own results, with the reason.
 */
import type { Report, PostLaunchReport } from '@wm/executor';
import type { Plan } from '@wm/planner';
import type { QaReport } from '@wm/qa';

export type ScopeStatus = 'done' | 'partial' | 'n/a' | 'not yet';
export interface ScopeLine {
  line: string;
  owner: 'Tool' | 'Team' | 'Tool + Team';
  status: ScopeStatus;
  why: string;
}

export function scopeChecklist(plan: Plan, report: Report | null, qa: QaReport | null, postlaunch: PostLaunchReport | null): ScopeLine[] {
  const c = report?.counts;
  const total = (kinds: readonly (keyof NonNullable<typeof c>)[]) => kinds.reduce((n, k) => n + (c?.[k].planned ?? 0), 0);
  const live = (kinds: readonly (keyof NonNullable<typeof c>)[]) => kinds.reduce((n, k) => n + (c?.[k].live ?? 0), 0);
  const failed = report ? Object.values(report.counts).reduce((n, k) => n + k.failed, 0) : 0;
  const flagged = plan.forms.filter((f) => f.action === 'flag').length;
  const broken = report?.links?.broken.length ?? 0;
  const lines: ScopeLine[] = [];

  lines.push({
    line: 'WordPress CMS setup and managed hosting',
    owner: 'Team',
    status: 'n/a',
    why: `The team's part. The tool checked the target: WordPress ${plan.target.wordpress}, theme ${plan.target.theme}, Redirection ${plan.target.redirection ? 'active' : 'not active'}.`,
  });
  lines.push({
    line: 'Responsive Planeteria framework styled to the brand',
    owner: 'Tool',
    status: 'partial',
    why: `Branding waits on the style guide (M3 part 2) and theme changes T1–T14.${qa ? ` Phone width: ${qa.overflow.mobile?.length ?? 0} of ${qa.pages.length} checked pages scroll sideways.` : ''}`,
  });
  const content = ['page', 'post', 'document', 'image'] as const;
  lines.push(
    !report
      ? { line: 'Lift-and-shift of public pages and documents', owner: 'Tool', status: 'not yet', why: 'The migration hasn’t run.' }
      : {
          line: 'Lift-and-shift of public pages and documents',
          owner: 'Tool',
          status: failed || live(content) < total(content) ? 'partial' : 'done',
          why: `${live(content)} of ${total(content)} pages, posts, documents and images live; ${failed} failed; ${plan.notMigrated.length} source items left out on purpose (listed in the plan).${broken ? ` ${broken} broken links or images.` : ''}`,
        },
  );
  lines.push({
    line: 'Implementation of the approved sitemap where practical',
    owner: 'Tool',
    status: plan.site ? 'done' : 'n/a',
    why: plan.site ? `No separate sitemap: the source's structure is kept (PLAN §6.6). ${plan.site.menus.filter((m) => m.items.length).length} menus rebuilt from the source.` : 'No site structure in this plan.',
  });
  lines.push({
    line: 'News, events/calendar, board/meeting content, forms/links, search, document access',
    owner: 'Tool',
    status: !report ? 'not yet' : flagged ? 'partial' : 'done',
    why: `${plan.expected.posts} news posts, ${plan.expected.events} meetings/events, ${plan.expected.forms} forms rebuilt${flagged ? `, ${flagged} flagged (subscription sign-ups need a tool behind them)` : ''}, ${plan.expected.documents} documents. Search is the framework's own.`,
  });
  lines.push({
    line: 'Navigation, header/footer, reusable page templates',
    owner: 'Tool + Team',
    status: report?.site ? 'partial' : 'not yet',
    why: report?.site
      ? `Menus (${Object.entries(report.site.menus).map(([n, k]) => `${n} ${k}`).join(', ')}), footer and homepage set; header placeholders wait on theme change T1.`
      : 'The site structure hasn’t been applied.',
  });
  lines.push(
    !qa
      ? { line: 'Basic accessibility and responsive QA', owner: 'Tool', status: 'not yet', why: 'QA hasn’t run.' }
      : {
          line: 'Basic accessibility and responsive QA',
          owner: 'Tool',
          status: qa.rules.length || qa.overflow.mobile?.length ? 'partial' : 'done',
          why: `${qa.pages.length} pages checked against WCAG 2.1 AA: ${qa.rules.length} rules violated (${qa.rules.filter((r) => r.siteWide).length} site-wide); ${qa.overflow.mobile?.length ?? 0} pages scroll sideways at 375 px.`,
        },
  );
  const redirectsOk = report && report.redirects.working !== null && report.redirects.working === report.redirects.total;
  lines.push({
    line: '301 redirects for priority legacy URLs where available',
    owner: 'Tool',
    status: !report ? 'not yet' : redirectsOk && !postlaunch?.problems.length ? 'done' : 'partial',
    why: report
      ? `${report.redirects.working ?? 0} of ${report.redirects.total} redirects answer 301 to the right page.${postlaunch ? ` Post-launch check: ${postlaunch.ok} of ${postlaunch.checked} legacy URLs OK.` : ''}`
      : 'The migration hasn’t run.',
  });
  const ga4 = postlaunch?.ga4;
  lines.push({
    line: 'Analytics setup, launch coordination, post-launch stabilization',
    owner: 'Tool + Team',
    status: !postlaunch ? 'not yet' : ga4?.expected && ga4.found.includes(ga4.expected) && !postlaunch.problems.length ? 'done' : 'partial',
    why: !postlaunch
      ? 'Run the post-launch check (job page).'
      : `${ga4?.expected ? (ga4.found.includes(ga4.expected) ? `GA4 ${ga4.expected} is on the homepage.` : `GA4 ${ga4.expected} is not on the homepage yet (theme change T13).`) : 'No GA4 ID for this job.'} ${postlaunch.problems.length} legacy URL problems at ${postlaunch.base}.`,
  });
  return lines;
}
