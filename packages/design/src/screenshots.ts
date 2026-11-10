/**
 * Screenshots of each mockup page at desktop and phone widths, straight from the unpacked files.
 * The pages may load web fonts and libraries from CDNs; those requests go only to public hosts.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { isAllowedHost } from '@wm/net';

export const WIDTHS = [1440, 375] as const;

export interface PageShot {
  file: string;
  width: number;
  image: string;
  height: number;
  /** The page is wider than the viewport (sideways scrolling). */
  overflow: boolean;
  /** Console errors from the mockup's own scripts, for the record. */
  errors: string[];
}

export async function launchBrowser(): Promise<Browser> {
  // WM_BROWSER_CHANNEL=chrome uses the installed Chrome when Playwright's bundled build is missing.
  return chromium.launch({ channel: process.env.WM_BROWSER_CHANNEL || undefined, chromiumSandbox: process.env.WM_CHROMIUM_NO_SANDBOX !== '1' });
}

/**
 * Scrolls to the bottom in steps so lazy-loaded images load, then back to the top. Smooth scrolling
 * (Bootstrap turns it on) is switched off first, or the screenshot catches the page mid-scroll with a
 * sticky header halfway down.
 */
export async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = document.documentElement;
    root.style.scrollBehavior = 'auto';
    for (let y = 0; y < root.scrollHeight; y += window.innerHeight * 0.8) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    // Let scroll handlers (a header that changes once scrolled) see the return to the top.
    await new Promise((r) => setTimeout(r, 300));
  });
}

export async function screenshotPages(root: string, files: string[], outDir: string, log: (msg: string) => void = () => {}): Promise<PageShot[]> {
  await mkdir(outDir, { recursive: true });
  const browser = await launchBrowser();
  const shots: PageShot[] = [];
  try {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
        // A mockup's file:// request must stay inside the mockup folder; web requests go to public hosts only.
        if (url.protocol === 'file:') return fileURLToPath(url).startsWith(path.resolve(root) + path.sep) ? route.continue() : route.abort();
        if ((url.protocol === 'https:' || url.protocol === 'http:') && (await isAllowedHost(url.hostname))) return route.continue();
        return route.abort();
      });
      for (const file of files) {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(pathToFileURL(path.join(root, file)).href, { waitUntil: 'load', timeout: 60_000 });
        await scrollThrough(page);
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        const image = `${file.replace(/\.html?$/i, '').replace(/[^a-z0-9_-]+/gi, '-')}-${width}.png`;
        await page.screenshot({ path: path.join(outDir, image), fullPage: true });
        const size = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth }));
        shots.push({ file, width, image, height: size.h, overflow: size.w > width + 1, errors: [...new Set(errors)] });
        await page.close();
      }
      log(`  ${files.length} pages at ${width} px`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return shots;
}
