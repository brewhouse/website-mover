/**
 * M0 sample post: convert test/fixtures/sample-post.html to blocks, using the
 * structured builders where a real extractor would (hero → core/cover, .row →
 * core/columns, the contact row inside a core/group, button-styled links →
 * core/buttons), validate, and write snapshots/blocks/sample-post.html for a
 * manual check in the WordPress 7.0 editor.
 *
 *   pnpm --filter @wm/blocks exec tsx scripts/sample-post.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buttons,
  columns,
  cover,
  group,
  htmlToBlocks,
  loadWordPress,
  serializeBlocks,
  validateSerialized,
  type Block,
} from '../src/index.js';

const source = new URL('../test/fixtures/sample-post.html', import.meta.url);
const outDir = new URL('../../../snapshots/blocks/', import.meta.url);

let t = performance.now();
loadWordPress();
const loadMs = performance.now() - t;

t = performance.now();
const doc = document.implementation.createHTMLDocument('');
doc.body.innerHTML = readFileSync(source, 'utf8');

const blocks: Block[] = [];
let pending = ''; // plain content between structured sections
const flush = () => {
  if (pending.trim()) blocks.push(...htmlToBlocks(pending, { demoteH1: true }));
  pending = '';
};

for (const node of Array.from(doc.body.childNodes)) {
  if (node.nodeType !== 1) {
    if (node.nodeType === 3) pending += node.textContent;
    continue;
  }
  const el = node as Element;
  if (el.matches('.hero')) {
    flush();
    const url = /url\(\s*['"]?([^'")]+)/.exec(el.getAttribute('style') ?? '')?.[1] ?? '';
    blocks.push(cover({ url, innerBlocks: htmlToBlocks(el.innerHTML, { demoteH1: true }) }));
  } else if (el.matches('.row')) {
    flush();
    const cols = columns(Array.from(el.children, (col) => htmlToBlocks(col.innerHTML)));
    blocks.push(el.children.length > 2 ? group([cols]) : cols);
  } else if (el.matches('p') && el.querySelector('a.btn')) {
    flush();
    const links = Array.from(el.querySelectorAll('a.btn'), (a) => ({
      text: a.textContent?.trim() ?? '',
      url: a.getAttribute('href') ?? '',
    }));
    blocks.push(buttons(links));
  } else {
    pending += el.outerHTML;
  }
}
flush();

const markup = serializeBlocks(blocks);
const convertMs = performance.now() - t;

t = performance.now();
const report = validateSerialized(markup);
const validateMs = performance.now() - t;

mkdirSync(outDir, { recursive: true });
const outFile = new URL('sample-post.html', outDir);
writeFileSync(outFile, markup);

const counts: Record<string, number> = {};
for (const name of report.names) counts[name] = (counts[name] ?? 0) + 1;
console.log(`wrote ${outFile.pathname} (${markup.length} bytes)`);
console.log(`blocks: ${report.blockCount}`, counts);
console.log(`valid: ${report.ok}  roundTrip: ${report.roundTrip}  errors: ${report.errors.length}  html fallbacks: ${report.warnings.length}`);
for (const e of report.errors) console.log(`  ${e.kind} ${e.name} @${e.path}: ${e.messages.join(' | ')}`);
console.log(`timing: load+register ${loadMs.toFixed(0)}ms, convert ${convertMs.toFixed(1)}ms, validate ${validateMs.toFixed(1)}ms`);
process.exitCode = report.ok ? 0 : 1;
