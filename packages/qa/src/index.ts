/**
 * QA stage (docs/m5/design.md §1): accessibility (axe-core, WCAG 2.1 A/AA) and responsive checks on
 * one page per template plus a sample, against the target site. Writes qa/qa.json and screenshots.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { jobPath, readJson, writeJson } from '@wm/core';
import { isAllowedHost } from '@wm/net';
import { loadPlan } from '@wm/planner';
import { selectPages, summarize, type PageResult, type QaPage, type RuleSummary, type RunEntities } from './select.js';

export { selectPages, summarize, type PageResult, type QaPage, type RuleSummary };

export const VIEWPORTS = { mobile: 375, tablet: 768, desktop: 1280 } as const;
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export interface QaReport {
  jobId: string;
  planVersion: number;
  baseUrl: string;
  ranAt: string;
  pages: PageResult[];
  rules: RuleSummary[];
  /** Pages wider than the viewport, by viewport name. */
  overflow: Record<string, string[]>;
}

export async function runQa({ jobId, baseUrl, log = console.log, sampleSize = 20 }: { jobId: string; baseUrl: string; log?: (msg: string) => void; sampleSize?: number }): Promise<QaReport> {
  const run = await readJson<RunEntities & { planVersion: number }>(jobPath(jobId, 'run', 'state.json')).catch(() => {
    throw new Error('Run the migration first: QA checks the migrated site');
  });
  const { plan, sha256 } = await loadPlan(jobId, run.planVersion);
  const pages = selectPages(plan, sha256, run, sampleSize);
  log(`QA: ${pages.length} pages (${pages.filter((p) => p.template).length} templates, ${pages.filter((p) => !p.template).length} sampled) on ${baseUrl}`);

  const shots = jobPath(jobId, 'qa', 'screenshots');
  await mkdir(shots, { recursive: true });
  // In Docker, Chromium's own sandbox needs privileges the container doesn't have; the container is
  // the boundary there (WM_CHROMIUM_NO_SANDBOX=1 in the image).
  const browser = await chromium.launch({ chromiumSandbox: process.env.WM_CHROMIUM_NO_SANDBOX !== '1' });
  try {
    const results: PageResult[] = [];
    // A few pages at a time: each opens three viewports.
    for (let i = 0; i < pages.length; i += 3) {
      results.push(...(await Promise.all(pages.slice(i, i + 3).map((p, j) => checkPage(browser, baseUrl, { ...p, index: i + j + 1 }, shots)))));
      log(`  ${results.length}/${pages.length} checked`);
    }
    const rules = summarize(results);
    const overflow = Object.fromEntries(Object.keys(VIEWPORTS).map((v) => [v, results.filter((r) => r.overflow[v]).map((r) => r.path)]));
    const report: QaReport = { jobId, planVersion: plan.version, baseUrl, ranAt: new Date().toISOString(), pages: results, rules, overflow };
    await writeJson(jobPath(jobId, 'qa', 'qa.json'), report);
    for (const r of results.filter((x) => x.status !== 200)) log(`  ! ${r.path} answered ${r.status}`);
    for (const rule of rules.slice(0, 10)) log(`  ${rule.impact ?? '-'} ${rule.id}: ${rule.pages.length} page(s)${rule.siteWide ? ' (site-wide)' : ''}`);
    log(`QA: ${rules.length} accessibility rules violated; sideways scrolling at 375 px on ${overflow.mobile!.length} page(s)`);
    return report;
  } finally {
    await browser.close();
  }
}

/**
 * Chromium does its own networking, outside safeFetch: every request (pages, frames, subresources,
 * redirects) is checked against the same address rules, so a page can't make the worker fetch an
 * internal address (and show it in a screenshot).
 */
export async function guardRequests(context: BrowserContext): Promise<void> {
  const verdicts = new Map<string, Promise<boolean>>();
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.abort('blockedbyclient');
    if (!verdicts.has(url.hostname)) verdicts.set(url.hostname, isAllowedHost(url.hostname));
    return (await verdicts.get(url.hostname)) ? route.continue() : route.abort('blockedbyclient');
  });
}

async function checkPage(browser: Browser, baseUrl: string, page: QaPage & { index: number }, shots: string): Promise<PageResult> {
  const url = new URL(page.path, baseUrl).href;
  const result: PageResult = { ...page, status: 0, violations: [], overflow: {}, screenshots: {} };
  // Unique per page (its position) and short, whatever the path.
  const name = `${page.index}-${page.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'home'}`.toLowerCase();
  for (const [viewport, width] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await guardRequests(context);
    const tab = await context.newPage();
    try {
      const response = await tab.goto(url, { waitUntil: 'load', timeout: 60_000 });
      result.status = response?.status() ?? 0;
      if (result.status !== 200) return result;
      await tab.waitForTimeout(500); // sliders and fonts settle
      result.overflow[viewport] = await tab.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth + 1');
      if (page.template) {
        const file = `${name}-${viewport}.png`;
        await writeFile(`${shots}/${file}`, await tab.screenshot({ type: 'png' }));
        result.screenshots[viewport] = file;
      }
      if (viewport === 'desktop') {
        const axe = await new AxeBuilder({ page: tab }).withTags(WCAG_TAGS).analyze();
        result.violations = axe.violations.map((v) => ({
          id: v.id,
          impact: v.impact ?? null,
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: v.nodes.length,
          sample: v.nodes[0]?.html.slice(0, 300) ?? '',
        }));
      }
    } catch (err) {
      result.status = result.status || -1;
      result.violations.push({ id: 'qa-error', impact: null, help: (err as Error).message.slice(0, 300), helpUrl: '', nodes: 0, sample: '' });
    } finally {
      await context.close();
    }
  }
  return result;
}
