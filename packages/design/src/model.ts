/**
 * B2 Model (docs/build/PLAN.md "Flow" 3), the deterministic part: from the mockup pages to
 * design/model.json.
 *   - shell: the landmarks most pages share (header, sidebar, footer) and their menus
 *   - sections: each page's main content split into sections; sections with the same signature on
 *     several pages are one component
 *   - collections: sibling elements with identical markup (staff cards, news cards), with the
 *     fields of one item
 *   - leaves: the values a section shows (headings, text, images, links, dates, emails, phones)
 *   - framework: the planeteriaweb file each component restyles (share of its classes found there)
 *   - schema: post types on the target that the pages and collections may reuse
 * The AI proposal (B2 plan) works from this model and never from raw HTML alone.
 */
import * as cheerio from 'cheerio';
import { normText, parsePage } from './pages.js';
import type { FrameworkIndex } from './framework.js';
import type { TargetSchema } from './schema.js';

export type LeafKind = 'heading' | 'text' | 'richtext' | 'image' | 'icon' | 'link' | 'button' | 'date' | 'email' | 'phone' | 'initials';

export interface Leaf {
  /** Path from the section (or collection item) root, e.g. "div.staff_card__name > div[0]". */
  path: string;
  kind: LeafKind;
  /** A name for the value: the element's own class, else its tag in the parent's class. */
  label: string;
  /** The mockup's text (for links, the link text; for images, the alt text). */
  sample: string;
  href?: string;
  src?: string;
}

export interface Collection {
  /** items: content entries; filters: category or tag choices (taxonomy terms, not entries). */
  role: 'items' | 'filters';
  /** Path of the element holding the items, from the section root. */
  path: string;
  count: number;
  /** Item element, e.g. "article.staff_card". */
  item: string;
  /** The first item's values, which name the list's fields. */
  leaves: Leaf[];
  /** Every item's values by leaf path (text; for images the src, for links the href too as "path@href"). */
  samples: Record<string, string>[];
  collections: Collection[];
}

export interface Section {
  /** The component this section is an instance of. */
  component: string;
  /** Path from the content root. */
  path: string;
  heading: string | null;
  leaves: Leaf[];
  collections: Collection[];
  /** Visible strings in the section. */
  texts: number;
}

export interface Component {
  id: string;
  /** "tag.class" of the section root. */
  signature: string;
  pages: string[];
  headings: string[];
  /** Distinctive classes (layout utilities left out) found in the section's markup. */
  classes: string[];
  framework: { file: string; block: string | null; share: number } | null;
}

export interface MenuItem {
  label: string;
  href: string;
  children: MenuItem[];
}

export interface DesignModel {
  shell: {
    landmarks: { signature: string; pages: number; texts: string[] }[];
    menus: { location: string; signature: string; items: MenuItem[] }[];
    /** Content root on the pages, e.g. "div.page_main". */
    contentRoot: string;
  };
  pages: { file: string; frames: string[]; sections: Section[]; framework: { file: string; share: number } | null }[];
  components: Component[];
  schema: {
    /** Pages whose name fits an existing post type (single or archive). */
    pages: { file: string; postType: string; label: string; as: 'single' | 'archive' | 'page' }[];
    /** Collections whose item fits an existing post type. */
    collections: { component: string; path: string; postType: string; label: string }[];
  };
}

const LAYOUT = /^(row|container(-fluid|-\w+)?|col(-\w+)*|g[xy]?-\d|d-\w+(-\w+)?|flex-\w+(-\w+)?|justify-content-\w+|align-(items|self|content)-\w+|m[trblxy]?-(\w+-)?\d|p[trblxy]?-(\w+-)?\d|text-(left|right|center|start|end)|w-\d+|h-\d+|no-margin|no-padding|alignwide|alignfull|clearfix|position-\w+|order-\w+|offset-\w+|gap-\d|visually-hidden|sr-only|active|show|fade|collapse|collapsed|three|two|four|one)$/;
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'br', 'hr', 'link', 'meta']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE = /^\+?[\d\s().-]{7,}(ext\.?\s*\d+)?$/i;
const DATE = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|date\/timestamp|date)$/i;

interface El {
  type: string;
  name: string;
  attribs: Record<string, string>;
  children: (El | { type: 'text'; data: string })[];
  parent: El | null;
}

const elementChildren = (el: El): El[] => el.children.filter((c): c is El => c.type === 'tag' && !SKIP.has((c as El).name));
const classesOf = (el: El): string[] => (el.attribs.class ?? '').split(/\s+/).filter(Boolean);
const distinctive = (el: El): string | undefined => classesOf(el).find((c) => !LAYOUT.test(c));
const selector = (el: El): string => `${el.name}${distinctive(el) ? `.${distinctive(el)}` : ''}`;
const ownText = (el: El): string => el.children.filter((c) => c.type === 'text').map((c) => (c as { data: string }).data).join(' ').replace(/\s+/g, ' ').trim();
const fullText = ($: cheerio.CheerioAPI, el: El): string => $(el as never).text().replace(/\s+/g, ' ').trim();
/** Text of an element without a cheerio handle (for structure checks). */
const textContent = (el: El): string =>
  el.children
    .map((c) => (c.type === 'text' ? (c as { data: string }).data : c.type === 'tag' && !SKIP.has((c as El).name) ? textContent(c as El) : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Structure without text: tag, classes, children. Identical items in a list share it. */
export function structure(el: El): string {
  const cls = classesOf(el).filter((c) => !/^(active|show|is-\w+|has-\w+)$/.test(c)).sort().join('.');
  // Runs of identical children count once, so items with two tags or three still match.
  const kids = elementChildren(el).map(structure).filter((k, i, all) => k !== all[i - 1]);
  return `${el.name}${cls ? `.${cls}` : ''}(${kids.join(',')})`;
}

/** Lists that are navigation or form options, not content: options, pagination, breadcrumbs, tabs. */
function isNavList(holder: El, items: El[]): boolean {
  if (items.every((i) => i.name === 'option')) return true;
  const cls = (e: El | null): string => (e ? `${e.attribs.class ?? ''} ${e.attribs['aria-label'] ?? ''} ${e.name}` : '');
  for (let e: El | null = holder, d = 0; e && d < 3; e = e.parent, d++) if (/pagination|breadcrumb|nav-tabs|tablist|carousel-indicators|\bnav\b/i.test(cls(e))) return true;
  return false;
}

/** Siblings sharing one structure, when they make up most of the children. */
function repeated(el: El): El[] | null {
  const kids = elementChildren(el);
  const groups = new Map<string, El[]>();
  for (const k of kids) groups.set(structure(k), [...(groups.get(structure(k)) ?? []), k]);
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  let items = best && best.length >= 2 && best.length >= kids.length * 0.5 ? best : null;
  if (!items && kids.length >= 3) {
    // Items whose insides vary a little (a result with an image, one without): same tag and classes.
    const shallow = new Map<string, El[]>();
    for (const k of kids) shallow.set(`${k.name}.${classesOf(k).sort().join('.')}`, [...(shallow.get(`${k.name}.${classesOf(k).sort().join('.')}`) ?? []), k]);
    const top = [...shallow.values()].sort((a, b) => b.length - a.length)[0]!;
    if (top.length >= 3 && top.length >= kids.length * 0.6 && top.every((k) => elementChildren(k).length > 0)) items = top;
  }
  if (!items || items.every((k) => !elementChildren(k).length && !ownText(k) && k.name !== 'img')) return null;
  // Two bare headings or paragraphs side by side are a title and a subtitle, not a list.
  if (items.length < 3 && items.every((k) => !elementChildren(k).length)) return null;
  // A few lines that hold different kinds of value (an email, then phones) are fields, not a list.
  if (items.length <= 4) {
    const kind = (k: El) => {
      const t = textContent(k);
      return EMAIL.test(t.replace(/^\S+:\s*/, '')) ? 'email' : PHONE.test(t.replace(/\s*(cell|mobile|fax|office|ext\.?\s*\d+)\s*$/i, '')) && /\d{3}/.test(t) ? 'phone' : DATE.test(t) ? 'date' : 'text';
    };
    if (new Set(items.map(kind)).size > 1) return null;
  }
  return isNavList(el, items) ? null : items;
}

function headingIn(el: El, $: cheerio.CheerioAPI): string | null {
  const h = $(el as never).find('h1, h2, h3').first();
  return h.length ? h.text().replace(/\s+/g, ' ').trim() || null : null;
}

/** Small or vector images: arrows, logos, social icons. They belong to the theme, not the content. */
function isIcon(img: El): boolean {
  const w = Number(img.attribs.width ?? 0);
  return (w > 0 && w <= 40) || /icon|logo|arrow|chevron|\.svg(\?|$)/i.test(img.attribs.src ?? '');
}

/** A heading, or a title bar holding a heading and little else ("Department News  View All"). */
function isTitle(el: El, $: cheerio.CheerioAPI): boolean {
  if (/^h[1-6]$/.test(el.name)) return true;
  const h = $(el as never).find('h1, h2, h3, h4').first();
  if (!h.length || $(el as never).find('ul, ol, table, form').length) return false;
  if ($(el as never).find('img').toArray().some((i) => !isIcon(i as unknown as El))) return false;
  return fullText($, el).length <= h.text().trim().length + 30;
}

/** The page title block: a child with the h1, before sections with h2s ("page_intro"). */
function pageTitleChildren(el: El, $: cheerio.CheerioAPI): El[] | null {
  // Only a plain block wraps the page like this; a <section> with an h1 (a hero) is one section.
  if (el.name !== 'div') return null;
  const kids = elementChildren(el);
  const titleAt = kids.findIndex((k) => $(k as never).is('h1') || ($(k as never).find('h1').length > 0 && !$(k as never).find('h2').length));
  if (titleAt < 0) return null;
  const rest = kids.filter((k, i) => i > titleAt && $(k as never).find('h2').length > 0);
  if (!rest.length) return null;
  return kids.filter((k) => !rest.includes(k));
}

/** A container of sections: two or more children with a heading each, and no title of its own. */
function isContainer(el: El, $: cheerio.CheerioAPI): boolean {
  const kids = elementChildren(el);
  if (kids.some((k) => isTitle(k, $) && !$(k as never).is('h1') && !$(k as never).find('h1').length)) return false;
  return kids.filter((k) => $(k as never).find('h2, h3').length > 0).length >= 2;
}

/** A wrapper is split into its children; anything else is a section. */
function isWrapper(el: El, $: cheerio.CheerioAPI): boolean {
  const kids = elementChildren(el);
  if (!kids.length || ownText(el) || el.name === 'form' || el.name === 'nav') return false;
  // A list of identical items is one section with a collection, not one section per item.
  if (repeated(el)) return false;
  if (isContainer(el, $)) return true;
  // section and article stand on their own unless they only wrap a container of sections.
  if (el.name === 'section' || el.name === 'article') {
    let inner: El = el;
    while (elementChildren(inner).length === 1) inner = elementChildren(inner)[0]!;
    return inner !== el && isContainer(inner, $);
  }
  if (kids.length === 1) return true;
  return classesOf(el).length > 0 && classesOf(el).every((c) => LAYOUT.test(c));
}

/** Groups of two or more siblings with the same structure, outermost first. */
function findCollections(root: El, base: string): { holder: El; items: El[]; path: string }[] {
  const found: { holder: El; items: El[]; path: string }[] = [];
  const walk = (el: El, path: string) => {
    const kids = elementChildren(el);
    const items = repeated(el);
    if (items) {
      found.push({ holder: el, items, path });
      return;
    }
    if (['select', 'nav'].includes(el.name)) return;
    for (const k of kids) walk(k, join(path, step(k, kids)));
  };
  walk(root, base);
  return found;
}

function step(el: El, siblings: El[]): string {
  const sel = selector(el);
  const same = siblings.filter((s) => selector(s) === sel);
  return same.length > 1 ? `${sel}[${same.indexOf(el)}]` : sel;
}
const join = (a: string, b: string) => (a ? `${a} > ${b}` : b);

function leafKind(el: El, text: string): LeafKind {
  if (/^h[1-6]$/.test(el.name)) return 'heading';
  if (el.name === 'time' || DATE.test(text)) return 'date';
  if (EMAIL.test(text)) return 'email';
  if (PHONE.test(text) && /\d{3}/.test(text)) return 'phone';
  if (/^[A-Z]{1,3}$/.test(text) && /initial|avatar/i.test(el.attribs.class ?? '')) return 'initials';
  if (el.name === 'button') return 'button';
  if ((el.name === 'p' || el.name === 'div') && (text.length > 140 || el.children.some((c) => c.type === 'tag' && ['a', 'strong', 'em', 'b', 'i', 'br'].includes((c as El).name)))) return 'richtext';
  return 'text';
}

/** The values inside root, leaving out the given elements (collection items, split-off children) and what is inside them. */
function leavesOf(root: El, $: cheerio.CheerioAPI, exclude: Set<El>): Leaf[] {
  const out: Leaf[] = [];
  const label = (el: El) => distinctive(el) ?? `${el.parent ? (distinctive(el.parent) ?? el.parent.name) : ''}_${el.name}`.replace(/^_/, '');
  const walk = (el: El, path: string) => {
    if (exclude.has(el) || el.attribs.hidden !== undefined || el.attribs['aria-hidden'] === 'true') return;
    if (el.name === 'img') {
      const src = el.attribs.src ?? '';
      out.push({ path, kind: isIcon(el) ? 'icon' : 'image', label: label(el), sample: el.attribs.alt ?? '', src });
      return;
    }
    if (el.name === 'a' && el.attribs.href !== undefined) {
      const blocky = elementChildren(el).some((k) => ['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'img', 'article', 'figure'].includes(k.name) || (k.name === 'span' && elementChildren(k).length > 0));
      if (!blocky) {
        const text = fullText($, el);
        const href = el.attribs.href;
        const kind: LeafKind = href.startsWith('mailto:') ? 'email' : href.startsWith('tel:') ? 'phone' : el.attribs.class?.includes('btn') ? 'button' : 'link';
        if (text) out.push({ path, kind, label: label(el), sample: text, href });
        for (const img of elementChildren(el).filter((k) => k.name === 'img')) walk(img, join(path, 'img'));
        return;
      }
      // A link around a card: its own words (a tile's caption beside its icon) are the link text.
      out.push({ path, kind: 'link', label: label(el), sample: ownText(el), href: el.attribs.href });
    } else {
      const own = ownText(el);
      // Inline markup in running text (a link in a paragraph) stays part of the paragraph.
      const inline = el.children.some((c) => c.type === 'tag' && ['a', 'strong', 'em', 'b', 'i', 'span', 'br'].includes((c as El).name)) && own.length > 0;
      if (own || inline) {
        const text = fullText($, el);
        if (text && /\p{L}|\d/u.test(text)) {
          const kind = leafKind(el, text);
          out.push({ path, kind, label: label(el), sample: text });
          if (kind === 'richtext' || inline) return;
        }
      }
      if (['input', 'select', 'textarea'].includes(el.name)) return;
    }
    const kids = elementChildren(el);
    for (const k of kids) walk(k, join(path, step(k, kids)));
  };
  for (const k of elementChildren(root)) walk(k, step(k, elementChildren(root)));
  return out;
}

/** One item's values by leaf path: text, plus src for images and href for links ("path@src"). */
export function valuesOf(leaves: Leaf[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of leaves) {
    if (l.sample) out[l.path] = l.sample;
    if (l.src) out[`${l.path}@src`] = l.src;
    if (l.href) out[`${l.path}@href`] = l.href;
  }
  return out;
}

function collectionsOf(root: El, $: cheerio.CheerioAPI): { collections: Collection[]; /** Every item element, left out of the section's own values. */ holders: Set<El> } {
  const found = findCollections(root, '');
  const collections = found.map(({ holder, items, path }): Collection => {
    const inner = collectionsOf(items[0]!, $);
    const filters = /filter|tags?\b|categor|chip/i.test(`${holder.attribs.class ?? ''} ${path}`);
    const samples = items.map((it) => valuesOf(leavesOf(it, $, collectionsOf(it, $).holders)));
    return { role: filters ? 'filters' : 'items', path, count: items.length, item: selector(items[0]!), leaves: leavesOf(items[0]!, $, inner.holders), samples, collections: inner.collections };
  });
  return { collections, holders: new Set(found.flatMap((f) => f.items)) };
}

function menuFrom(list: El, $: cheerio.CheerioAPI): MenuItem[] {
  return elementChildren(list)
    .filter((li) => li.name === 'li')
    .map((li) => {
      const a = $(li as never).children('a, button').first();
      const sub = $(li as never).find('ul').first().get(0) as unknown as El | undefined;
      const label = (a.length ? a.text() : ownText(li)).replace(/\s+/g, ' ').trim();
      return { label, href: a.attr('href') ?? '', children: sub ? menuFrom(sub, $) : [] };
    })
    .filter((m) => m.label);
}

export interface ModelInput {
  pages: { file: string; html: string; frames: string[] }[];
  framework: FrameworkIndex | null;
  schema: TargetSchema | null;
}

export function buildModel({ pages, framework, schema }: ModelInput): DesignModel {
  const parsed = pages.map((p) => ({ ...p, $: cheerio.load(p.html) }));
  const body = (x: (typeof parsed)[number]) => x.$('body').get(0) as unknown as El;

  // Shell: header/aside/footer/nav landmarks on most pages, with the same signature.
  const landmarkPages = new Map<string, number>();
  for (const p of parsed) {
    const seen = new Set<string>();
    p.$('body header, body aside, body footer').each((_, el) => {
      const sig = selector(el as unknown as El);
      if (!seen.has(sig)) landmarkPages.set(sig, (landmarkPages.get(sig) ?? 0) + 1);
      seen.add(sig);
    });
  }
  const shellSigs = new Set([...landmarkPages].filter(([, n]) => n >= Math.max(2, pages.length * 0.6)).map(([s]) => s));
  const isShell = (el: El) => ['header', 'aside', 'footer'].includes(el.name) && shellSigs.has(selector(el)) && !el.parent?.attribs?.class?.split(/\s+/).some((c) => /page_main|content/.test(c));

  // Text on most pages ("Skip to content", the menus) doesn't count as content.
  const df = new Map<string, number>();
  for (const p of pages) for (const t of new Set(parsePage(p.html, p.file).texts)) df.set(t, (df.get(t) ?? 0) + 1);
  const shared = new Set([...df].filter(([, n]) => n >= Math.max(2, pages.length * 0.6)).map(([t]) => t));
  const textOf = (el: El): number => {
    if (isShell(el)) return 0;
    const own = normText(ownText(el));
    return (own && !shared.has(own) ? own.length : 0) + elementChildren(el).reduce((n, c) => n + textOf(c), 0);
  };
  // Content root: from <body>, keep going into the one child that holds nearly all content text.
  const chain = (x: (typeof parsed)[number]): El[] => {
    const out = [body(x)];
    for (;;) {
      const el = out[out.length - 1]!;
      const total = textOf(el);
      const next = elementChildren(el).find((k) => !isShell(k) && textOf(k) >= total * 0.9);
      if (!next || total === 0) return out;
      out.push(next);
    }
  };
  // The deepest root most pages share (div.page_main), so every page is split the same way.
  const chains = parsed.map((x) => chain(x).map((el) => ({ el, sel: selector(el) })));
  const counts = new Map<string, number>();
  for (const c of chains) for (const sel of new Set(c.map((e) => e.sel))) counts.set(sel, (counts.get(sel) ?? 0) + 1);
  const common = chains
    .flat()
    .filter((e) => (counts.get(e.sel) ?? 0) >= pages.length * 0.6 && e.sel.includes('.'))
    .map((e) => e.sel)
    .pop();
  const contentRoot = (x: (typeof parsed)[number], i: number): El => {
    const own = chains[i]!;
    if (!common) return own[own.length - 1]!.el;
    return (own.find((e) => e.sel === common)?.el ?? (x.$(common.replace(/^(\w+)\./, '$1.')).first().get(0) as unknown as El | undefined) ?? own[own.length - 1]!.el);
  };

  const shellLandmarks = [...shellSigs].map((signature) => {
    const texts = new Set<string>();
    for (const p of parsed) {
      p.$('body header, body aside, body footer').each((_, el) => {
        if (selector(el as unknown as El) === signature) {
          p.$(el).find('*').each((__, d) => {
            const t = normText(ownText(d as unknown as El));
            if (t.length > 1) texts.add(t);
          });
        }
      });
    }
    return { signature, pages: landmarkPages.get(signature)!, texts: [...texts].slice(0, 60) };
  });

  // Menus: the longest list of links in each shell landmark (the most items across pages).
  const menus: DesignModel['shell']['menus'] = [];
  for (const signature of shellSigs) {
    let best: { items: MenuItem[]; size: number; navSig: string } | null = null;
    for (const p of parsed) {
      p.$('body header, body aside, body footer').each((_, el) => {
        if (selector(el as unknown as El) !== signature) return;
        p.$(el)
          .find('nav ul, ul.menu, ul.nav')
          .each((__, ul) => {
            if (p.$(ul).parents('ul').length) return;
            const items = menuFrom(ul as unknown as El, p.$);
            const size = items.reduce((n, i) => n + 1 + i.children.length, 0);
            const nav = (p.$(ul).closest('nav').get(0) ?? ul) as unknown as El;
            if (size >= 2 && (!best || size > best.size)) best = { items, size, navSig: selector(nav) };
          });
      });
    }
    const chosen = best as { items: MenuItem[]; size: number; navSig: string } | null;
    if (chosen) menus.push({ location: signature.split('.')[0]!, signature: chosen.navSig, items: chosen.items });
  }

  // Sections and components.
  const components = new Map<string, Component>();
  const usedIds = new Map<string, string>();
  const idFor = (signature: string) => {
    if (usedIds.has(signature)) return usedIds.get(signature)!;
    let id = (signature.split('.')[1] ?? signature).replace(/[^a-z0-9_]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'section';
    while ([...usedIds.values()].includes(id)) id += '_2';
    usedIds.set(signature, id);
    return id;
  };
  const rootSel = common ?? '';
  const pageModels = parsed.map((x, i) => {
    const root = contentRoot(x, i);
    const sections: Section[] = [];
    const split = (el: El, path: string) => {
      const kids = elementChildren(el).filter((k) => !isShell(k));
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i]!;
        const p = join(path, step(k, kids));
        // Loose siblings with the same markup and no list around them (search results): one
        // section with a collection.
        let run = 1;
        while (i + run < kids.length && selector(kids[i + run]!) === selector(k) && elementChildren(k).length > 0) run++;
        if (run >= 3) {
          addRun(kids.slice(i, i + run), p);
          i += run - 1;
          continue;
        }
        // A title block that wraps the sections below it (department detail): the title part is
        // the section, the rest is split.
        const titled = pageTitleChildren(k, x.$);
        if (titled && !isWrapper(k, x.$)) {
          const sectionKids = elementChildren(k).filter((c) => !titled.includes(c));
          addSection(k, p, new Set(sectionKids));
          for (const c of sectionKids) {
            const cp = join(p, step(c, elementChildren(k)));
            if (isWrapper(c, x.$)) split(c, cp);
            else addSection(c, cp, new Set());
          }
          continue;
        }
        if (isWrapper(k, x.$)) {
          split(k, p);
          continue;
        }
        addSection(k, p, new Set());
      }
    };
    const addRun = (items: El[], p: string) => {
      const first = items[0]!;
      const id = idFor(`${first.name}.${distinctive(first) ?? first.name}_list`);
      const inner = collectionsOf(first, x.$);
      const samples = items.map((it) => valuesOf(leavesOf(it, x.$, collectionsOf(it, x.$).holders)));
      sections.push({ component: id, path: p, heading: null, leaves: [], collections: [{ role: 'items', path: '', count: items.length, item: selector(first), leaves: leavesOf(first, x.$, inner.holders), samples, collections: inner.collections }], texts: items.reduce((n, it) => n + x.$(it as never).find('*').toArray().filter((d) => ownText(d as unknown as El)).length, 0) });
      const classes = new Set<string>();
      x.$(first as never).find('[class]').addBack().each((_, d) => classesOf(d as unknown as El).forEach((c) => !LAYOUT.test(c) && classes.add(c)));
      const c = components.get(id) ?? { id, signature: `${first.name}.${distinctive(first) ?? first.name}_list`, pages: [], headings: [], classes: [], framework: null };
      if (!c.pages.includes(x.file)) c.pages.push(x.file);
      c.classes = [...new Set([...c.classes, ...classes])].sort();
      components.set(id, c);
    };
    const addSection = (k: El, p: string, without: Set<El>) => {
      if (!fullText(x.$, k) && !x.$(k as never).find('img').length) return;
      const items = repeated(k);
      // Named by its own class; a plain list by its items ("directory_card_list"); a bare <section>
      // by the first class inside it.
      const inner = x.$(k as never).find('[class]').toArray().map((d) => distinctive(d as unknown as El)).find(Boolean);
      const signature = distinctive(k) ? selector(k) : items ? `${k.name}.${distinctive(items[0]!) ?? items[0]!.name}_list` : inner ? `${k.name}.${inner}` : selector(k);
      const id = idFor(signature);
      const { collections, holders } = collectionsOf(k, x.$);
      for (const w of without) holders.add(w);
      const kept = collections.filter((c) => ![...without].some((w) => c.path.startsWith(step(w, elementChildren(k)))));
      const heading = headingIn(k, x.$);
      sections.push({ component: id, path: p, heading, leaves: leavesOf(k, x.$, holders), collections: kept, texts: x.$(k as never).find('*').toArray().filter((d) => ownText(d as unknown as El) && ![...without].some((w) => x.$(w as never).find(d as never).length)).length });
      const classes = new Set<string>();
      x.$(k as never)
        .find('[class]')
        .addBack()
        .each((_, d) => {
          if ([...without].some((w) => w === (d as unknown as El) || x.$(w as never).find(d as never).length)) return;
          classesOf(d as unknown as El).forEach((c) => !LAYOUT.test(c) && classes.add(c));
        });
      const c = components.get(id) ?? { id, signature, pages: [], headings: [], classes: [], framework: null };
      if (!c.pages.includes(x.file)) c.pages.push(x.file);
      if (heading && !c.headings.includes(heading)) c.headings.push(heading);
      c.classes = [...new Set([...c.classes, ...classes])].sort();
      components.set(id, c);
    };
    split(root, '');
    // The page as a whole against the theme's top-level templates (template-*.php, single-*.php…).
    const pageClasses = new Set<string>();
    x.$(root as never)
      .find('[class]')
      .each((_, d) => classesOf(d as unknown as El).forEach((c) => !LAYOUT.test(c) && pageClasses.add(c)));
    const fw = framework?.best([...pageClasses], 0.3, (f) => !f.includes('/')) ?? null;
    return { file: x.file, frames: x.frames, sections, framework: fw && { file: fw.file, share: fw.share } };
  });

  // A section that matches a block's render template nearly as well as anything else restyles that
  // block (page.php can hold the same classes inline).
  const blockFiles = new Set(framework?.files.filter((f) => f.block).map((f) => f.file) ?? []);
  for (const c of components.values()) {
    if (!framework) continue;
    const any = framework.best(c.classes, 0.4);
    const block = framework.best(c.classes, 0.35, (f) => blockFiles.has(f));
    c.framework = block && (!any || block.share >= any.share - 0.2) ? block : any;
  }

  return {
    shell: { landmarks: shellLandmarks, menus, contentRoot: rootSel },
    pages: pageModels,
    components: [...components.values()],
    schema: schema ? schemaCandidates(pageModels, schema) : { pages: [], collections: [] },
  };
}

/** Words that name the same kind of content as a WordPress post type. */
const SYNONYMS: Record<string, string[]> = {
  post: ['news', 'blog', 'article', 'read', 'story'],
  tribe_events: ['calendar', 'event'],
  attachment: ['document', 'file', 'download'],
  people: ['staff', 'people', 'person', 'employee', 'team', 'member'],
};
/** Words that say how something looks, not what it is. */
const GENERIC = new Set(['list', 'card', 'item', 'items', 'widget', 'content', 'main', 'wrap', 'wrapper', 'row', 'col', 'body', 'info', 'detail', 'box', 'block', 'section', 'title', 'text', 'img', 'image', 'link', 'links', 'view', 'all', 'more', 'the', 'and', 'for', 'name', 'meta', 'top', 'inner', 'grid', 'panel', 'stack', 'split', 'directory', 'page']);

/** Short forms used in class and file names. */
const ABBREVIATIONS: Record<string, string> = { dept: 'department', dep: 'department', doc: 'document', emp: 'employee', evt: 'event', pic: 'photo', img: 'image' };
/** Words ending in s that aren't plurals. */
const NOT_PLURAL = /(?:ss|us|is|news|series|status|ews)$/;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.html?$/, '')
    .split(/[^a-z]+/)
    .map((w) => ABBREVIATIONS[w] ?? w)
    .filter((w) => w.length > 2 && !GENERIC.has(w))
    .map((w) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !NOT_PLURAL.test(w) ? w.slice(0, -1) : w));
}

/** Class names along a path ("div.rabbit_reads > ul.news_list" → "rabbit_reads news_list"), tags left out. */
const pathClasses = (p: string) => p.split('>').map((s) => s.trim().split('.').slice(1).join(' ').replace(/\[\d+\]$/, '')).join(' ');

function schemaCandidates(pages: DesignModel['pages'], schema: TargetSchema): DesignModel['schema'] {
  const types = Object.entries(schema.post_types).filter(([name]) => name !== 'page');
  // A post type's words: its name, the last word of its label ("Employee Perks" → perk), synonyms.
  const words = new Map(types.map(([name, pt]) => [name, new Set([...tokens(name.replace(/_/g, ' ')).slice(-1), ...tokens(pt.label).slice(-1), ...(SYNONYMS[name] ?? [])])]));
  /** The first word (in order of preference) that names a post type. */
  const fit = (candidates: string[]) => {
    for (const w of candidates) for (const [name, pt] of types) if (words.get(name)!.has(w)) return [name, pt] as const;
    return undefined;
  };
  const out: DesignModel['schema'] = { pages: [], collections: [] };
  const pageHits: { p: DesignModel['pages'][number]; type: string; label: string }[] = [];
  for (const p of pages) {
    const hit = fit(tokens(p.file));
    if (hit) pageHits.push({ p, type: hit[0], label: hit[1].label });
    for (const s of p.sections) {
      for (const c of s.collections.filter((x) => x.role === 'items')) {
        // Most specific first: the item's class, the holder's classes (innermost first), then the
        // section heading read from its last word ("Department News" is news).
        const order = [...tokens(c.item.split('.').slice(1).join(' ')), ...tokens(pathClasses(c.path)).reverse(), ...tokens(s.component), ...tokens(s.heading ?? '').slice(-1)];
        const h = fit(order);
        if (h && !out.collections.some((x) => x.component === s.component && x.path === c.path)) out.collections.push({ component: s.component, path: c.path, postType: h[0], label: h[1].label });
      }
    }
  }
  // Single or archive: the file name when it says (detail / directory), else whether the page's
  // largest list holds entries of that post type.
  for (const { p, type, label } of pageHits) {
    let as: 'single' | 'archive';
    if (/detail|single|profile/i.test(p.file)) as = 'single';
    else if (/directory|list|archive|listing|results?\b/i.test(p.file)) as = 'archive';
    else {
      const lists = p.sections.flatMap((s) => s.collections.filter((c) => c.role === 'items').map((c) => ({ s, c })));
      const largest = lists.sort((a, b) => b.c.count - a.c.count)[0];
      as = largest && out.collections.some((x) => x.component === largest.s.component && x.path === largest.c.path && x.postType === type) ? 'archive' : 'single';
    }
    out.pages.push({ file: p.file, postType: type, label, as });
  }
  return out;
}
