/**
 * Reads each mockup HTML page into what ingest and the model need: its text (as the strings a
 * person sees), headings, landmarks, classes, assets and links to the other pages.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

/** The parts of a parsed node this file reads (domhandler's shape, which cheerio doesn't re-export). */
interface AnyNode {
  type: string;
  data?: string;
  children?: AnyNode[];
}
interface Element extends AnyNode {
  name: string;
  attribs: Record<string, string>;
  children: AnyNode[];
}

export interface MockupPage {
  /** Path relative to the mockup root, e.g. "department-detail.html". */
  file: string;
  title: string;
  h1: string | null;
  headings: { level: number; text: string }[];
  /** Visible strings, normalized (see normText), in document order without repeats. */
  texts: string[];
  /** Landmarks found, as tag plus first class (e.g. "header.main_header"). */
  landmarks: string[];
  classes: string[];
  images: string[];
  stylesheets: string[];
  scripts: string[];
  /** Other mockup pages this one links to. */
  links: string[];
}

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head']);

/**
 * Lower case, typographic quotes made plain, whitespace collapsed (and dropped around < >), edge
 * punctuation and a closing full stop trimmed, so "Page not found." in the HTML meets "Page not found" in Figma.
 */
export function normText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*([<>])\s*/g, '$1')
    .replace(/^[\s:|•·–—-]+|[\s:|•·.!]+$/g, '')
    .toLowerCase();
}

export function parsePage(html: string, file: string): MockupPage {
  const $ = cheerio.load(html);
  const texts = new Set<string>();
  const add = (s: string | undefined) => {
    const t = normText(s ?? '');
    if (t.length > 1 && /\p{L}|\d/u.test(t)) texts.add(t);
  };
  // A string is the whole text of the innermost element that holds text directly, so "Jane <b>S.</b>"
  // becomes "jane s." as Figma would show it.
  const walk = (node: AnyNode) => {
    if (node.type !== 'tag' && node.type !== 'root') return;
    const el = node as Element;
    if (el.type === 'tag' && (SKIP.has(el.name) || el.attribs.hidden !== undefined || el.attribs['aria-hidden'] === 'true')) return;
    if (el.type === 'tag' && el.children.some((c) => c.type === 'text' && c.data?.trim())) add($(el as never).text());
    if (el.type === 'tag') {
      add(el.attribs.placeholder);
      if (el.name === 'input' && ['submit', 'button'].includes(el.attribs.type ?? '')) add(el.attribs.value);
    }
    for (const c of el.children ?? []) walk(c);
  };
  walk((($('body').get(0) ?? $.root().get(0)) as unknown) as AnyNode);

  const local = (v: string | undefined) => (v && !/^(?:[a-z]+:|\/\/|#)/i.test(v) ? v.split(/[?#]/)[0]! : null);
  const classes = new Set<string>();
  $('[class]').each((_, el) => (el as Element).attribs.class!.split(/\s+/).forEach((c) => c && classes.add(c)));
  const landmarks = $('header, aside, main, footer, nav, [role=main], [role=navigation]')
    .toArray()
    .map((el) => {
      const e = el as Element;
      const cls = e.attribs.class?.split(/\s+/)[0];
      return `${e.name}${cls ? `.${cls}` : ''}`;
    });
  const pageDir = path.posix.dirname(file);
  const links = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = local((el as Element).attribs.href);
    if (href && /\.html?$/i.test(href)) links.add(path.posix.normalize(path.posix.join(pageDir, href)));
  });

  return {
    file,
    title: $('title').first().text().replace(/\s+/g, ' ').trim(),
    h1: $('h1').first().text().replace(/\s+/g, ' ').trim() || null,
    headings: $('h1, h2, h3, h4, h5, h6')
      .toArray()
      .map((el) => ({ level: Number((el as Element).name[1]), text: $(el as never).text().replace(/\s+/g, ' ').trim() }))
      .filter((h) => h.text),
    texts: [...texts],
    landmarks: [...new Set(landmarks)],
    classes: [...classes].sort(),
    images: [...new Set($('img[src]').toArray().map((el) => local((el as Element).attribs.src)).filter((s): s is string => !!s))],
    stylesheets: $('link[rel=stylesheet][href]').toArray().map((el) => (el as Element).attribs.href!),
    scripts: $('script[src]').toArray().map((el) => (el as Element).attribs.src!),
    links: [...links].filter((l) => l !== file).sort(),
  };
}

/** Every .html page in the mockup root (top level only: subfolders hold assets). */
export async function readPages(root: string): Promise<MockupPage[]> {
  const files = (await readdir(root)).filter((f) => /\.html?$/i.test(f)).sort();
  return Promise.all(files.map(async (f) => parsePage(await readFile(path.join(root, f), 'utf8'), f)));
}
