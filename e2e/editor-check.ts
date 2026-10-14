/**
 * Opens content in the real block editor on the local seed and reports every block the editor
 * considers invalid or unsupported. This is the check behind "opens in the editor without
 * invalid-block warnings".
 *
 *   pnpm --filter @wm/e2e exec tsx --env-file=../.env editor-check.ts [markup.html]
 *     saves the markup as a post first (default: snapshots/blocks/sample-post.html)
 *   pnpm --filter @wm/e2e exec tsx --env-file=../.env editor-check.ts --post 123,456
 *     checks existing posts or pages (e.g. migrated content)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { localSeedClient } from '@wm/wp-client';

const base = `http://localhost:${process.env.SEED_LOCAL_PORT ?? '8088'}`;
const password = process.env.SEED_LOCAL_ADMIN_PASSWORD;
if (!password) throw new Error('SEED_LOCAL_ADMIN_PASSWORD is not set in .env');

type Post = { id: number; link: string; content: { raw: string } };
type EditorState = { blocks: number; names: string[]; invalid: string[]; warnings: number; missing: number; dirtyOnOpen: boolean };

const wp = localSeedClient();
const postArg = process.argv.indexOf('--post');
let ids: number[];
let storedExactly: boolean | null = null;
if (postArg >= 0) {
  ids = process.argv[postArg + 1]!.split(',').map(Number);
} else {
  const markup = readFileSync(process.argv[2] ?? new URL('../snapshots/blocks/sample-post.html', import.meta.url).pathname, 'utf8');
  const slug = 'wm-editor-check';
  const [existing] = await wp.get<Post[]>('/wp/v2/posts', { slug, status: 'any' });
  const body = { title: 'Editor check (M0)', slug, status: 'publish', content: markup };
  const post = existing ? await wp.post<Post>(`/wp/v2/posts/${existing.id}`, body) : await wp.post<Post>('/wp/v2/posts', body);
  // Saved as-is? (kses would rewrite markup for users without unfiltered_html.)
  storedExactly = (await wp.get<Post>(`/wp/v2/posts/${post.id}`, { context: 'edit' })).content.raw === markup;
  ids = [post.id];
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors: string[] = [];
page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));

await page.goto(`${base}/wp-login.php`);
await page.fill('#user_login', 'wm-local');
await page.fill('#user_pass', password);
// Don't wait for the dashboard's load event: it pulls in external assets.
await Promise.all([page.waitForURL(/wp-admin/, { waitUntil: 'commit' }), page.click('#wp-submit')]);

const shots = new URL('../snapshots/editor-check/', import.meta.url);
mkdirSync(shots, { recursive: true });
let pass = storedExactly !== false;
for (const id of ids) {
  const state = await inspect(page, id);
  await page.screenshot({ path: new URL(ids.length > 1 ? `editor-${id}.png` : 'editor.png', shots).pathname });
  const ok = state.invalid.length === 0 && state.warnings === 0 && state.missing === 0;
  pass &&= ok;
  console.log(JSON.stringify({ post: id, ...(storedExactly === null ? {} : { storedExactly }), ...state, ok }, null, 2));
}
await browser.close();
if (consoleErrors.length) console.log('console errors:', consoleErrors.slice(0, 10));
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);

async function inspect(page: Page, id: number): Promise<EditorState> {
  await page.goto(`${base}/wp-admin/post.php?post=${id}&action=edit`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const w = window as unknown as { wp?: any };
      return w.wp?.data?.select('core/block-editor')?.getBlocks().length > 0;
    },
    undefined,
    { timeout: 60_000 },
  );
  await page.evaluate(`wp.data.dispatch('core/preferences').set('core/edit-post', 'welcomeGuide', false)`);
  // Let embeds resolve and the canvas settle before reading the state and taking a screenshot.
  await page.waitForTimeout(3000);
  // Passed as a string: tsx compiles named functions with a `__name` helper the page doesn't have.
  return page.evaluate(`(() => {
    const all = [];
    const walk = (blocks) => blocks.forEach((b) => { all.push(b); walk(b.innerBlocks); });
    walk(wp.data.select('core/block-editor').getBlocks());
    const canvas = document.querySelector('iframe[name="editor-canvas"]')?.contentDocument ?? document;
    return {
      blocks: all.length,
      names: [...new Set(all.map((b) => b.name))].sort(),
      invalid: all.filter((b) => !b.isValid).map((b) => b.name),
      warnings: canvas.querySelectorAll('.block-editor-warning').length,
      missing: all.filter((b) => b.name === 'core/missing').length,
      dirtyOnOpen: wp.data.select('core/editor').isEditedPostDirty(),
    };
  })()`);
}
