/**
 * QA stage (docs/m5/design.md §1): accessibility (axe-core, WCAG 2.1 A/AA) and responsive checks on
 * one page per template plus a sample, against the target site. Writes qa/qa.json and screenshots.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, type Browser } from 'playwright';
import { jobPath, readJson, writeJson } from '@wm/core';
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
  const browser = await chromium.launch();
  try {
    const results: PageResult[] = [];
    // A few pages at a time: each opens three viewports.
    for (let i = 0; i < pages.length; i += 3) {
      results.push(...(await Promise.all(pages.slice(i, i + 3).map((p) => checkPage(browser, baseUrl, p, shots)))));
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

async function checkPage(browser: Browser, baseUrl: string, page: QaPage, shots: string): Promise<PageResult> {
  const url = new URL(page.path, baseUrl).href;
  const result: PageResult = { ...page, status: 0, violations: [], overflow: {}, screenshots: {} };
  const name = page.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home';
  for (const [viewport, width] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
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
