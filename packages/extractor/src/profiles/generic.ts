import { createHash } from 'node:crypto';
import type { CheerioAPI } from 'cheerio';
import { resolveUrl } from '@wm/crawler';
import { cleanText, stripSiteName } from '../text.js';
import type { AnyNode, ExtractContext, ExtractProfile, KindMatch, Nodes, PageParts, PageRef } from './types.js';

/** Blocks considered for boilerplate detection. */
const BLOCKS = 'header, nav, footer, aside, div, section, ul, ol, table, form';
/** A block repeated on more than this share of pages is site chrome. */
const BOILERPLATE_SHARE = 0.6;
/** Chrome by markup, removed from the content wherever it appears. */
const CHROME = 'nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=search], form[role=search], .breadcrumb, .breadcrumbs, .sidebar, .skip-link';

const blockHash = (tag: string, text: string) => createHash('sha1').update(`${tag}\u0000${text}`).digest('hex').slice(0, 16);

/**
 * Any site: title from the first <h1> (else <title>), content from <main>,
 * <article> or [role=main], else the element holding the most paragraph text.
 * Blocks whose text repeats on more than 60% of pages are dropped as chrome.
 */
export function createGenericProfile(): ExtractProfile {
  const boilerplate = new Set<string>();

  const isBoilerplate = ($: CheerioAPI, el: AnyNode) => {
    const node = $(el);
    const text = cleanText(node.text());
    return text.length >= 30 && boilerplate.has(blockHash(node.prop('tagName') ?? '', text));
  };

  return {
    name: 'generic',

    async prepare(pages: PageRef[]) {
      if (pages.length < 5) return;
      const counts = new Map<string, number>();
      for (const page of pages) {
        const $ = await page.load();
        $('script, style, noscript').remove();
        const seen = new Set<string>();
        $(BLOCKS).each((_, el) => {
          const text = cleanText($(el).text());
          if (text.length >= 30) seen.add(blockHash($(el).prop('tagName') ?? '', text));
        });
        for (const hash of seen) counts.set(hash, (counts.get(hash) ?? 0) + 1);
      }
      for (const [hash, count] of counts) if (count / pages.length > BOILERPLATE_SHARE) boilerplate.add(hash);
    },

    read(page: PageRef, $: CheerioAPI, ctx: ExtractContext): PageParts {
      $('script, style, noscript').remove();
      const root = mainContent($);
      root.find(CHROME).remove();
      root.find(BLOCKS).filter((_, el) => isBoilerplate($, el)).remove();

      const h1 = root.find('h1').first().length ? root.find('h1').first() : $('h1').first();
      const title = cleanText(h1.text()) || stripSiteName($('title').first().text(), ctx.siteName);
      if (h1.length && root.find(h1).length) h1.remove();

      const published =
        $('meta[property="article:published_time"]').attr('content') ??
        root.find('time[datetime]').first().attr('datetime') ??
        $('article time[datetime]').first().attr('datetime');
      const date = published?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;

      const categories = $('a[rel~="category"], a[rel~="tag"]')
        .map((_, a) => cleanText($(a).text()))
        .get()
        .filter(Boolean);

      // Breadcrumbs: the last link before the current page is the parent.
      const crumbs = $('nav[aria-label*="readcrumb" i] a, .breadcrumb a, .breadcrumbs a').toArray();
      const parentLink = crumbs.length >= 2 ? $(crumbs[crumbs.length - 1]!) : undefined;
      const parentUrl = parentLink ? resolveUrl(parentLink.attr('href'), page.url) : undefined;

      return {
        title,
        date,
        categories: [...new Set(categories)],
        parentUrl: parentUrl?.href ?? null,
        sectionTitle: parentLink ? cleanText(parentLink.text()) || null : null,
        contentHtml: root.html() ?? '',
      };
    },

    kindByUrl(url: URL): KindMatch | undefined {
      const p = url.pathname.toLowerCase().replace(/\/+$/, '');
      if (/\/(search|sitemap|site-map|login|log-in|sign-in|register|cart|checkout|my-account)$/.test(p)) return { kind: 'utility', reason: 'utility-path' };
      if (/\/(page\/\d+|category\/[^/]+|tag\/[^/]+|author\/[^/]+)$/.test(p)) return { kind: 'listing', reason: 'archive-path' };
      return undefined;
    },
  };
}

/** <main>, <article>, [role=main] or a usual content id; else the block holding the most paragraph text outside chrome. */
function mainContent($: CheerioAPI): Nodes {
  for (const selector of ['main', '[role=main]', 'article', '#content', '#main', '.entry-content', '.post-content', '.content']) {
    const el: Nodes = $(selector).first();
    if (el.length && (cleanText(el.text()) || el.find('img').length)) return el;
  }
  const scores = new Map<AnyNode, { el: Nodes; score: number }>();
  $('p, li, h2, h3, td, blockquote').each((_, el) => {
    if ($(el).closest(CHROME).length) return;
    const parent: Nodes = $(el).parent();
    const node = parent.get(0);
    if (!node) return;
    const entry = scores.get(node) ?? { el: parent, score: 0 };
    entry.score += cleanText($(el).text()).length;
    scores.set(node, entry);
  });
  const best = [...scores.values()].sort((a, b) => b.score - a.score)[0];
  return best?.el ?? $('body').first();
}
