import type { CheerioAPI } from 'cheerio';
import { DOC_EXT, IMAGE_EXT, isSameSite, onOrigin } from './urls.js';

/**
 * What the scan needs to know about a source platform: where its HTML site map
 * is, which URLs aren't worth fetching, and how its files are addressed. The
 * scan itself is platform-neutral. Content selectors live in @wm/extractor.
 */
export interface SiteProfile {
  name: string;
  /** HTML site-map pages. Fetched before the crawl; links found on them are tagged via 'site-map'. */
  siteMapPaths: string[];
  /** Whether a same-site URL should be fetched as a page. Not called for file URLs. */
  shouldCrawl(url: URL): boolean;
  /**
   * Canonical absolute URL when `url` is a downloadable same-site file (document
   * or image), else undefined. Variants of one file must map to one URL.
   */
  fileUrl(url: URL, origin: string): string | undefined;
  /** Page URLs the crawl can't reach through links (e.g. listings behind a JS filter), found on a fetched page. */
  extraPages?(url: URL, $: CheerioAPI): string[];
}

/** Static assets and feeds that are never pages. */
const ASSET_EXT = /\.(css|js|mjs|map|ico|woff2?|ttf|eot|otf|zip|gz|mp4|m4v|mov|webm|mp3|wav|xml|json|rss|atom)$/i;
/** Theme/template images are site chrome, not content files. */
const THEME_PATH = /^\/(wp-content\/themes|wp-includes|templates|themes)\//i;

function fileByExtension(url: URL, origin: string): string | undefined {
  if (!isSameSite(url, origin) || THEME_PATH.test(url.pathname)) return undefined;
  if (!DOC_EXT.test(url.pathname) && !IMAGE_EXT.test(url.pathname)) return undefined;
  return onOrigin(url, origin).href;
}

const isAssetOrFile = (url: URL) => ASSET_EXT.test(url.pathname) || DOC_EXT.test(url.pathname) || IMAGE_EXT.test(url.pathname);

/** Any site: follow ordinary pages, skip feeds, admin, login, search and cart. */
export const genericProfile: SiteProfile = {
  name: 'generic',
  siteMapPaths: [],
  shouldCrawl(url) {
    if (isAssetOrFile(url)) return false;
    const p = url.pathname.toLowerCase();
    if (/\/(feed|wp-json|wp-admin|cart|checkout|my-account|login|logout|search)(\/|$)/.test(p)) return false;
    if (/\/(wp-login|xmlrpc)\.php$/.test(p)) return false;
    if (url.searchParams.has('s') || url.searchParams.has('q') || url.searchParams.has('replytocom')) return false;
    return true;
  },
  fileUrl: fileByExtension,
};

/**
 * Brooks Jeffrey Marketing's CMS (jaxha.org). See docs/m0/jha-inventory.md.
 *
 * - Every upload is `/plugins/show_image.php?id=N`; `&size=…` and `&type=…` are
 *   renditions of the same file, so the canonical URL is `?id=N`.
 * - Filtered views multiply the crawl and are skipped: `calendar?…`,
 *   `locations/map?type=…`, `sign-up?type=…`, `alerts-lookup?…` and
 *   `news?category=…&year=…`, except the all-years view of each news category
 *   (and its pages). That's the only place news categories show, so the
 *   extractor reads them from there. Those views sit behind a JS `<select>`,
 *   so `extraPages` lists them from `/news`.
 * - Search, staff login and the CMS's template/plugin/ajax paths are skipped.
 */
export const bjmProfile: SiteProfile = {
  name: 'bjm',
  siteMapPaths: ['/site-map'],
  shouldCrawl(url) {
    if (isAssetOrFile(url)) return false;
    const p = url.pathname.toLowerCase();
    if (/^\/(templates|ajax|plugins)\//.test(p)) return false;
    if (['/search.php', '/staff-pages', '/staff-login'].includes(p)) return false;
    if (url.search && ['/calendar', '/locations/map', '/locations/list', '/sign-up', '/alerts-lookup'].includes(p)) return false;
    if (p === '/news') {
      const keys = [...url.searchParams.keys()];
      if (keys.every((key) => key === 'grp')) return true;
      return isNewsCategoryListing(url);
    }
    return true;
  },
  fileUrl(url, origin) {
    if (isSameSite(url, origin) && /^\/plugins\/show_image\.php$/i.test(url.pathname)) {
      const id = url.searchParams.get('id');
      return id && /^[1-9]\d*$/.test(id) ? `${new URL(origin).origin}/plugins/show_image.php?id=${id}` : undefined;
    }
    return fileByExtension(url, origin);
  },
  extraPages(url, $) {
    if (url.pathname.toLowerCase() !== '/news' || url.search) return [];
    return $('select[name=category-selector] option')
      .map((_, option) => $(option).attr('value') ?? '')
      .get()
      .filter((value) => /^[1-9]\d*$/.test(value))
      .map((value) => new URL(`/news?category=${value}&year=-1`, url).href);
  },
};

/** `/news?category=C&year=-1[&grp=N]`: one news category, all years (paginated by grp). */
export function isNewsCategoryListing(url: URL): boolean {
  if (url.pathname.toLowerCase() !== '/news') return false;
  const keys = [...url.searchParams.keys()];
  return (
    /^[1-9]\d*$/.test(url.searchParams.get('category') ?? '') &&
    url.searchParams.get('year') === '-1' &&
    keys.every((key) => ['category', 'year', 'grp'].includes(key))
  );
}

const PROFILES: Record<string, SiteProfile> = { generic: genericProfile, bjm: bjmProfile };

export function getSiteProfile(name: string): SiteProfile {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`Unknown platform profile "${name}" (known: ${Object.keys(PROFILES).join(', ')})`);
  return profile;
}
