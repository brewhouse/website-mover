import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { isSameSite, onOrigin, unwrapSafeLink, type SiteProfile } from '@wm/crawler';
import { cleanText } from './text.js';

export interface CleanOptions {
  /** The page's final URL; relative URLs resolve against it. */
  base: string;
  origin: string;
  site: SiteProfile;
}

export interface CleanResult {
  /** The cleaned fragment ($.html() serializes it). */
  $: CheerioAPI;
  safeLinksUnwrapped: number;
  scriptsRemoved: number;
  /** hrefs that are bare phone numbers (no tel:), left as they are. */
  phoneHrefs: string[];
}

/** Attributes holding one URL. */
const URL_ATTRS: [selector: string, attr: string][] = [
  ['a[href]', 'href'],
  ['area[href]', 'href'],
  ['img[src]', 'src'],
  ['iframe[src]', 'src'],
  ['embed[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['video[poster]', 'poster'],
  ['audio[src]', 'src'],
  ['track[src]', 'src'],
  ['object[data]', 'data'],
  ['form[action]', 'action'],
  ['blockquote[cite]', 'cite'],
  ['q[cite]', 'cite'],
];

/** A phone number pasted as a link without tel: ("+1%20904-990-8560,,838959516#"); it resolves to a broken page. */
const PHONE_HREF = /^\+?\d[\d\s().,-]{6,}#?\s*$/;

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Cleans a page's main content without restyling it:
 *
 * - scripts, styles, comments and similar non-content nodes are removed;
 * - every URL is made absolute against the page; same-site URLs move onto the
 *   origin's scheme and host, and file URLs onto the profile's canonical form
 *   (BJM: `show_image.php?id=N`, dropping `&size=…`/`&type=…`);
 * - Outlook Safe Links are unwrapped to the real URL. Their `data=`/`sdata=`
 *   parameters carry a staff mailbox, so nothing of the wrapper is kept;
 * - data-* and on* attributes go, as do Outlook's "Original URL: …" titles.
 */
export function cleanContent(html: string, opts: CleanOptions): CleanResult {
  const $ = cheerio.load(html, null, false);
  let safeLinksUnwrapped = 0;
  const phoneHrefs: string[] = [];

  $('*')
    .contents()
    .add($.root().contents())
    .filter((_, node) => node.type === 'comment')
    .remove();
  const scripts = $('script, noscript');
  const scriptsRemoved = scripts.length;
  scripts.remove();
  $('style, link, meta, template, base').remove();

  // Lazy-loaded images keep the real URL in data-src.
  $('img[data-src]:not([src]), img[data-src][src^="data:"]').each((_, el) => {
    $(el).attr('src', $(el).attr('data-src')!);
  });

  const rewrite = (raw: string): string => {
    const value = raw.trim();
    if (!value || value.startsWith('#') || /^(mailto|tel|sms|callto|javascript|data):/i.test(value)) return raw;
    if (PHONE_HREF.test(safeDecode(value))) {
      phoneHrefs.push(value);
      return raw;
    }
    let url: URL;
    try {
      url = new URL(value, opts.base);
    } catch {
      return raw;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
    const unwrapped = unwrapSafeLink(url);
    if (unwrapped) {
      safeLinksUnwrapped++;
      url = unwrapped;
    } else if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(url.hostname)) {
      // A Safe Link we can't unwrap: drop everything but the host rather than keep the mailbox.
      safeLinksUnwrapped++;
      url = new URL(`${url.protocol}//${url.host}/`);
    }
    const fileUrl = opts.site.fileUrl(url, opts.origin);
    if (fileUrl) return fileUrl;
    if (isSameSite(url, opts.origin)) return onOrigin(url, opts.origin).href;
    return url.href;
  };

  for (const [selector, attr] of URL_ATTRS) {
    $(selector).each((_, el) => {
      const value = $(el).attr(attr);
      if (value !== undefined) $(el).attr(attr, rewrite(value));
    });
  }
  $('img[srcset], source[srcset]').each((_, el) => {
    const srcset = ($(el).attr('srcset') ?? '')
      .split(',')
      .map((candidate) => {
        const [src, ...descriptor] = candidate.trim().split(/\s+/);
        return src ? [rewrite(src), ...descriptor].join(' ') : '';
      })
      .filter(Boolean)
      .join(', ');
    $(el).attr('srcset', srcset);
  });

  $('*').each((_, el) => {
    for (const name of Object.keys($(el).attr() ?? {})) {
      if (name.startsWith('data-') || /^on/i.test(name)) $(el).removeAttr(name);
    }
    if (/^Original URL:/i.test($(el).attr('title') ?? '')) $(el).removeAttr('title');
  });

  return { $, safeLinksUnwrapped, scriptsRemoved, phoneHrefs };
}

/**
 * Drops a leading heading or paragraph that only repeats the page title (the
 * theme prints the title), when nothing comes before it. Links are kept: a
 * leading link named like the page is content (often the page's document).
 */
export function removeLeadingTitle($: CheerioAPI, title: string): void {
  const wanted = cleanText(title).toLowerCase();
  if (!wanted || !cleanText($.root().text()).toLowerCase().startsWith(wanted)) return;
  const first = $('h1, h2, h3, h4, h5, h6, p, li, td, th, img, iframe, table')
    .filter((_, el) => cleanText($(el).text()) !== '' || $(el).is('img, iframe, table') || $(el).find('img, iframe').length > 0)
    .first();
  if (!first.is('h1, h2, h3, h4, h5, h6, p') || first.find('a, img, iframe').length) return;
  if (cleanText(first.text()).toLowerCase() === wanted) first.remove();
}
