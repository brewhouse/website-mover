/**
 * HTML → Gutenberg blocks, using WordPress's own block library.
 *
 *   html ─ normalize (ours) ─ rawHandler (WP) ─ tidy (ours) ─ Block[] ─ serialize (WP)
 *
 * `rawHandler` is WordPress's "Convert to blocks" for classic content. It is
 * faithful but not a sanitizer and does not know about lazy images, iframes or
 * layout wrappers, so we normalize the DOM first and tidy a few attributes
 * after. We never write block markup ourselves.
 */
import type { Block } from './wp-types.js';
import { loadWordPress } from './env.js';

export type { Block };

export interface ConvertOptions {
  /** Turn content H1s into H2s (the page template supplies the H1). Default false. */
  demoteH1?: boolean;
  /** Called for content we drop or can't convert cleanly. */
  onWarning?: (message: string) => void;
  /** Maps an image URL to its uploaded attachment, so image blocks get the attachment id. */
  resolveImage?: (url: string) => { id: number; url: string } | undefined;
}

// ---------------------------------------------------------------------------
// Public API

export function htmlToBlocks(html: string, options: ConvertOptions = {}): Block[] {
  const wp = loadWordPress();
  const warn = options.onWarning ?? (() => {});
  const { html: clean, tableCaptions } = normalizeHtml(html, warn);
  const blocks = wp.rawHandler({ HTML: clean });
  // Captions are re-attached to core/table blocks by document order, which is
  // only safe if every <table> became a core/table.
  let captions = tableCaptions;
  const tableCount = flat(blocks).filter((b) => b.name === 'core/table').length;
  if (captions.some(Boolean) && tableCount !== captions.length) {
    warn(`dropped table captions: ${captions.length} tables but ${tableCount} core/table blocks`);
    captions = [];
  }
  return tidy(blocks, options, [...captions]);
}

/** core/columns with one core/column per entry. */
export function columns(cols: Block[][], attributes: Record<string, unknown> = {}): Block {
  const { createBlock } = loadWordPress();
  return createBlock(
    'core/columns',
    attributes,
    cols.map((inner) => createBlock('core/column', {}, inner)),
  );
}

export interface CoverInput {
  url: string;
  alt?: string;
  /** Attachment ID once the image is uploaded to the target site. */
  id?: number;
  /** Overlay opacity 0–100. The editor uses 50 when an image is picked. */
  dimRatio?: number;
  innerBlocks?: Block[];
}

/** core/cover with a background image and content on top. */
export function cover({ url, alt = '', id, dimRatio = 50, innerBlocks = [] }: CoverInput): Block {
  const { createBlock } = loadWordPress();
  return createBlock(
    'core/cover',
    { url, alt, id, dimRatio, layout: { type: 'constrained' } },
    innerBlocks,
  );
}

/** core/group (a section) with the editor's default constrained layout. */
export function group(innerBlocks: Block[], attributes: Record<string, unknown> = {}): Block {
  const { createBlock } = loadWordPress();
  return createBlock('core/group', { layout: { type: 'constrained' }, ...attributes }, innerBlocks);
}

/** core/buttons with one core/button per link. */
export function buttons(items: { text: string; url: string }[]): Block {
  const { createBlock } = loadWordPress();
  return createBlock(
    'core/buttons',
    {},
    items.map(({ text, url }) => createBlock('core/button', { text, url })),
  );
}

export function serializeBlocks(blocks: Block[]): string {
  return loadWordPress().serialize(blocks);
}

// ---------------------------------------------------------------------------
// Before rawHandler: normalize the source DOM

/** Elements that start a block (anything else is phrasing content). */
const BLOCK_TAGS = new Set(
  'P H1 H2 H3 H4 H5 H6 UL OL DL TABLE FIGURE BLOCKQUOTE PRE HR IFRAME FORM DETAILS ADDRESS FIELDSET VIDEO AUDIO NAV DIV SECTION ARTICLE MAIN HEADER FOOTER ASIDE CENTER'.split(
    ' ',
  ),
);
/** Layout wrappers: rawHandler turns these into one opaque core/html block. */
const CONTAINERS = 'div, section, article, main, header, footer, aside, center';
const DROP = 'script, style, noscript, template, link, meta, source, object, embed';
const ALIGN_CLASS = /^align(left|right|center|wide|full|none)$/;
const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original'];

/** Video iframes → the canonical URL that core/embed (and WP oEmbed) understands. */
const VIDEO_IFRAMES: [RegExp, (id: string) => string][] = [
  [/^(?:https?:)?\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/i, (id) => `https://www.youtube.com/watch?v=${id}`],
  [/^(?:https?:)?\/\/player\.vimeo\.com\/video\/(\d+)/i, (id) => `https://vimeo.com/${id}`],
];
/** Other iframes we keep as raw HTML (core/html). Everything else is dropped. */
const IFRAME_ALLOWLIST = [/^https:\/\/www\.google\.com\/maps\/embed\?/i];

function normalizeHtml(html: string, warn: (m: string) => void): { html: string; tableCaptions: string[] } {
  const doc = document.implementation.createHTMLDocument('');
  const body = doc.body;
  body.innerHTML = html;

  body.querySelectorAll(DROP).forEach((el) => el.remove());
  const walker = doc.createTreeWalker(body, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: ChildNode[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode as ChildNode);
  comments.forEach((c) => c.remove());

  for (const el of Array.from(body.querySelectorAll('*'))) {
    for (const { name, value } of Array.from(el.attributes)) {
      if (name.startsWith('on')) el.removeAttribute(name);
      else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) el.removeAttribute(name);
    }
    // Source classes would leak into the target as custom classNames, and
    // `wp-image-123` would become a (wrong) attachment ID. Keep alignment only.
    const align = Array.from(el.classList).filter((c) => ALIGN_CLASS.test(c));
    if (align.length) el.setAttribute('class', align.join(' '));
    else el.removeAttribute('class');
    // rawHandler maps text-align to the block's alignment; other styles go.
    const textAlign = (el as HTMLElement).style?.textAlign;
    el.removeAttribute('style');
    if (textAlign) (el as HTMLElement).style.textAlign = textAlign;
  }

  // Lazy-loaded images: the real URL is in a data- attribute.
  for (const img of Array.from(body.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    const lazy = LAZY_SRC.map((a) => img.getAttribute(a)).find(Boolean);
    if (lazy && (!src || src.startsWith('data:'))) img.setAttribute('src', lazy);
    if (!img.getAttribute('src') || img.getAttribute('src')!.startsWith('data:')) {
      warn(`dropped image without a usable src (alt="${img.alt}")`);
      img.remove();
    }
  }

  // Iframes: video → URL paragraph (rawHandler makes core/embed), allowlisted
  // → top-level iframe (core/html), anything else is dropped.
  for (const iframe of Array.from(body.querySelectorAll('iframe'))) {
    const src = iframe.getAttribute('src') ?? '';
    let video: string | undefined;
    for (const [re, toUrl] of VIDEO_IFRAMES) {
      const m = re.exec(src);
      if (m) video ??= toUrl(m[1]);
    }
    if (video) {
      const p = doc.createElement('p');
      p.textContent = video;
      outermostWrapper(iframe).replaceWith(p);
    } else if (IFRAME_ALLOWLIST.some((re) => re.test(src))) {
      outermostWrapper(iframe).replaceWith(iframe);
    } else {
      warn(`dropped iframe ${src}`);
      iframe.remove();
    }
  }

  // rawHandler drops <caption>, and turns Gutenberg-rendered tables
  // (<figure class="wp-block-table"><table/><figcaption/>) into core/html.
  // Unwrap to a bare <table> and keep the caption to set as an attribute later.
  const tableCaptions: string[] = [];
  for (const table of Array.from(body.querySelectorAll('table'))) {
    const figure = table.parentElement?.tagName === 'FIGURE' ? table.parentElement : null;
    const caption = table.querySelector(':scope > caption') ?? figure?.querySelector(':scope > figcaption');
    tableCaptions.push(caption?.innerHTML.trim() ?? '');
    caption?.remove();
    figure?.replaceWith(...Array.from(figure.childNodes));
  }

  // Alignment lives on the figure in WP markup; rawHandler also reads it from
  // the img, and on the figure it would duplicate into className.
  for (const el of Array.from(body.querySelectorAll('figure[class], a[class], p[class]'))) {
    const img = el.querySelector('img');
    if (img && !img.className) img.className = el.className;
    el.removeAttribute('class');
  }

  // b/i → strong/em (what the editor's formats use); unwrap presentational
  // wrappers and links left without an href; drop empty icon elements.
  for (const el of Array.from(body.querySelectorAll('b, i'))) rename(el, el.tagName === 'B' ? 'strong' : 'em');
  for (const el of Array.from(body.querySelectorAll('em, strong'))) {
    if (!el.textContent?.trim() && !el.querySelector('img')) el.remove();
  }
  for (const el of Array.from(body.querySelectorAll('span, font, picture, a:not([href])'))) {
    el.replaceWith(...Array.from(el.childNodes));
  }

  // <blockquote><p>…</p><footer><cite>…</cite></footer></blockquote>
  body.querySelectorAll('blockquote > footer').forEach((f) => f.replaceWith(...Array.from(f.childNodes)));

  // Unwrap layout containers, deepest first, so their content gets converted.
  for (const el of Array.from(body.querySelectorAll(CONTAINERS)).reverse()) unwrapContainer(el);

  return { html: body.innerHTML, tableCaptions };
}

const IFRAME_WRAPPERS = new Set(['P', 'DIV', 'SPAN', 'FIGURE', 'CENTER', 'SECTION', 'ARTICLE', 'ASIDE']);

/** The iframe, or the wrapper(s) around it that contain nothing else. */
function outermostWrapper(el: Element): Element {
  let node = el;
  while (
    node.parentElement &&
    IFRAME_WRAPPERS.has(node.parentElement.tagName) &&
    node.parentElement.children.length === 1 &&
    !directText(node.parentElement)
  ) {
    node = node.parentElement;
  }
  return node;
}

function directText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent)
    .join('')
    .trim();
}

function rename(el: Element, tag: string): void {
  const next = el.ownerDocument.createElement(tag);
  for (const { name, value } of Array.from(el.attributes)) next.setAttribute(name, value);
  next.append(...Array.from(el.childNodes));
  el.replaceWith(next);
}

/**
 * Replace a layout wrapper with its children. Where the wrapper sits in block
 * context, loose inline content becomes paragraphs (so two `<div>`s of text
 * don't merge into one paragraph); inside li/td/etc. it is simply unwrapped.
 */
function unwrapContainer(el: Element): void {
  const doc = el.ownerDocument;
  const parent = el.parentElement;
  const blockContext =
    !parent || parent.tagName === 'BODY' || parent.tagName === 'BLOCKQUOTE' || parent.matches(CONTAINERS);
  if (!blockContext) {
    el.replaceWith(...Array.from(el.childNodes));
    return;
  }
  const out: Node[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (run.some((n) => n.textContent?.trim() || (n as Element).querySelector?.('img') || n.nodeName === 'IMG')) {
      const p = doc.createElement('p');
      p.append(...run);
      out.push(p);
    }
    run = [];
  };
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1 && BLOCK_TAGS.has((child as Element).tagName)) {
      flush();
      out.push(child);
    } else {
      run.push(child);
    }
  }
  flush();
  el.replaceWith(...out);
}

// ---------------------------------------------------------------------------
// After rawHandler: tidy attributes

const EMPTY_CONTENT = /(&nbsp;| |<br\s*\/?>|\s)/g;
const CITE_ONLY = /^\s*<cite>([\s\S]*)<\/cite>\s*$/;
const VIDEO_PROVIDERS = new Set(['youtube', 'vimeo']);

/** `captions`: table captions in document order, consumed as core/table blocks are met. */
function tidy(blocks: Block[], options: ConvertOptions, captions: string[]): Block[] {
  const wp = loadWordPress();
  const out: Block[] = [];
  for (const block of blocks) {
    let { name, attributes, innerBlocks } = block;
    innerBlocks = tidy(innerBlocks, options, captions);
    attributes = { ...attributes };

    // rawHandler leaves an empty paragraph where an image was lifted out of a <p>.
    if (name === 'core/paragraph' && !String(attributes.content ?? '').replace(EMPTY_CONTENT, '')) continue;

    if (name === 'core/heading' && attributes.level === 1 && options.demoteH1) attributes.level = 2;

    if (name === 'core/table') {
      const caption = captions.shift();
      if (caption) attributes.caption = caption;
    }

    // <cite> inside a blockquote comes out as a core/html child; it belongs in `citation`.
    if (name === 'core/quote') {
      const last = innerBlocks.at(-1);
      const cite = last?.name === 'core/html' && CITE_ONLY.exec(String(last.attributes.content ?? ''));
      if (cite) {
        attributes.citation = cite[1].trim();
        innerBlocks = innerBlocks.slice(0, -1);
      }
    }

    // rawHandler sets linkDestination "custom" when any <a> is in the figure,
    // including one in the caption; without an href it's meaningless.
    if (name === 'core/image' && attributes.linkDestination === 'custom' && !attributes.href) {
      delete attributes.linkDestination;
    }

    if (name === 'core/image' && options.resolveImage) {
      const uploaded = options.resolveImage(String(attributes.url ?? ''));
      if (uploaded) Object.assign(attributes, uploaded);
    }

    // rawHandler gives core/embed only a URL. Add what the editor would set
    // after resolving the provider, so the block shows as the YouTube/Vimeo
    // variation and the post isn't dirty on first open.
    if (name === 'core/embed' && !attributes.providerNameSlug) {
      Object.assign(attributes, embedAttributes(String(attributes.url ?? '')));
    }

    out.push(wp.createBlock(name, attributes, innerBlocks));
  }
  return out;
}

function flat(blocks: Block[]): Block[] {
  return blocks.flatMap((b) => [b, ...flat(b.innerBlocks)]);
}

function embedAttributes(url: string): Record<string, unknown> {
  const variations = loadWordPress().getBlockVariations('core/embed') ?? [];
  const match = variations.find((v) =>
    ((v as { patterns?: RegExp[] }).patterns ?? []).some((re) => re.test(url)),
  );
  if (!match) return {};
  const attrs: Record<string, unknown> = { ...match.attributes };
  if (VIDEO_PROVIDERS.has(String(attrs.providerNameSlug))) {
    // The editor derives the aspect class from the oEmbed iframe size; 16:9 is
    // right for nearly all YouTube/Vimeo videos and the editor corrects it otherwise.
    attrs.type = 'video';
    attrs.className = 'wp-embed-aspect-16-9 wp-has-aspect-ratio';
  }
  return attrs;
}

/**
 * HTML for targets that store classic content (no block editor), e.g. The Events Calendar's
 * classic editor: the blocks' own saved HTML, without the block comment delimiters.
 */
export function blocksToHtml(blocks: Block[]): string {
  return serializeBlocks(blocks)
    .replace(/<!-- \/?wp:[^>]*?-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A block from a plugin the converter doesn't load (e.g. gravityforms/form). Dynamic blocks save
 * no HTML, so a minimal registration (attributes only) is enough to create and serialize them
 * with the block library.
 */
export function externalBlock(name: string, attributes: Record<string, string | number | boolean>): Block {
  const wp = loadWordPress();
  if (!wp.getBlockType(name)) {
    const types = { string: 'string', number: 'number', boolean: 'boolean' } as const;
    wp.registerBlockType(name, {
      title: name,
      category: 'widgets',
      attributes: Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, { type: types[typeof v as keyof typeof types] }])),
      save: () => null,
    } as never);
  }
  return wp.createBlock(name, attributes);
}
