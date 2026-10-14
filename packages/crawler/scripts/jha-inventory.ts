/**
 * M0 spike: inventory https://www.jaxha.org/ ahead of the migration.
 *
 *   pnpm exec tsx packages/crawler/scripts/jha-inventory.ts [--sweep-file-ids]
 *
 * Every response is cached under snapshots/jha/http/, so a re-run only goes to
 * the network for things it hasn't fetched yet (delete that folder for a fresh
 * scan). Results land in snapshots/jha/inventory.json, plus pages.json and
 * files.json with per-URL detail. docs/m0/jha-inventory.md is written from them.
 *
 * The site turned out not to be WordPress, so the main path is a polite HTML
 * crawl (sitemap + links). The WordPress REST path only runs if an API is found.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { type FetchResult, PoliteFetcher } from '../src/polite-fetch.js';
import { readSitemaps } from '../src/sitemaps.js';

const ORIGIN = 'https://www.jaxha.org';
const SITE_HOSTS = new Set(['www.jaxha.org', 'jaxha.org']);
const OUT = path.resolve(import.meta.dirname, '../../../snapshots/jha');
const USER_AGENT = 'website-mover-inventory/0.1 (+internal migration tool)';
const MAX_PAGES = 2500;
const ORPHAN_SAMPLE_SIZE = 120;
const SWEEP_FILE_IDS = process.argv.includes('--sweep-file-ids');

const fetcher = new PoliteFetcher({
  userAgent: USER_AGENT,
  concurrency: 4,
  minIntervalMs: 250,
  cacheDir: path.join(OUT, 'http'),
});

// ---------------------------------------------------------------- URL helpers

const DOC_EXT = /\.(pdf|docx?|xlsx?|xlsm|csv|pptx?|rtf|odt|ods)$/i;
const ASSET_EXT = /\.(jpe?g|png|gif|svg|webp|ico|css|js|zip|mp4|mp3|mov|wav|xml|json|woff2?)$/i;
const DOC_HOSTS = /(^|\.)((drive|docs)\.google\.com|dropbox\.com|sharepoint\.com|1drv\.ms|box\.com|issuu\.com|scribd\.com)$/i;

function resolveUrl(href: string | undefined, base: string): URL | undefined {
  const trimmed = href?.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(mailto|tel|javascript|data|sms):/i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed, base);
    url.hash = '';
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

const isSite = (url: URL) => SITE_HOSTS.has(url.hostname.toLowerCase());

/** URLs on this CMS are case-insensitive, so pages are keyed on lowercased path + query. */
const pageKey = (url: URL) => (url.pathname + url.search).toLowerCase();

/** The file library: every upload is served as /plugins/show_image.php?id=N. */
function fileIdOf(url: URL): number | undefined {
  if (!isSite(url) || !/^\/plugins\/show_image\.php$/i.test(url.pathname)) return undefined;
  const id = Number(url.searchParams.get('id'));
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function urlGroup(url: URL): string {
  const p = url.pathname.toLowerCase();
  if (fileIdOf(url)) return 'file';
  if (p === '/') return 'home';
  if (p === '/news-view') return 'news-item';
  if (p === '/news' || p === '/press_full_list.php') return 'news-listing';
  if (p === '/upages.php') return 'page-by-id';
  if (p.startsWith('/locations/detail/')) return 'location';
  if (p.startsWith('/locations')) return 'location-listing';
  if (p === '/zip-codes-zones') return 'zip-code-zone';
  if (p === '/calendar') return 'calendar';
  if (p === '/sign-up' || p === '/alerts-lookup') return 'alerts-signup';
  if (/^\/[^/]+$/.test(p) && !p.endsWith('.php')) return 'page';
  return 'other';
}

function shouldCrawl(url: URL): boolean {
  if (!isSite(url) || fileIdOf(url) || DOC_EXT.test(url.pathname) || ASSET_EXT.test(url.pathname)) return false;
  const p = url.pathname.toLowerCase();
  if (/^\/(templates|ajax|plugins)\//.test(p) || p === '/search.php') return false;
  // Filtered views of listings would multiply the crawl; categories are counted separately.
  if (url.search && ['/calendar', '/locations/map', '/sign-up', '/alerts-lookup'].includes(p)) return false;
  if (p === '/news' && [...url.searchParams.keys()].some((key) => key !== 'grp')) return false;
  return true;
}

const cleanText = (text: string) => text.replace(/\s+/g, ' ').trim();
const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);

async function save(relPath: string, data: string | object): Promise<void> {
  const file = path.join(OUT, relPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

// ---------------------------------------------------------------- page parsing

interface Link {
  href: string;
  text: string;
}

interface PageRecord {
  url: string;
  finalUrl: string;
  status: number;
  group: string;
  bytes: number;
  title: string;
  h1: string;
  description: string;
  date?: string;
  /** Left-hand section nav parent, e.g. "About Us". */
  section?: string;
  contentSelector: string;
  words: number;
  contentHash: string;
  fileLinks: { id: number; text: string }[];
  /** Every file id referenced anywhere on the page (links, images, inline backgrounds). */
  fileIds: number[];
  docLinks: (Link & { onSite: boolean })[];
  internalLinks: string[];
  externalLinks: Link[];
  images: number;
  forms: { action: string; method: string; fields: number; id: string }[];
  builderForms: BuilderForm[];
  iframes: string[];
  scripts: string[];
  vendors: string[];
  inlineStyles: number;
  tables: number;
  emptyParagraphs: number;
  safelinks: number;
  youtubeLinks: number;
  mailtoLinks: number;
  shortcodes: string[];
}

const CONTENT_SELECTORS = ['#bodyContainer', '#cms_body_content', '#cms-content', '#interior section', 'main', 'body'];

/** Third-party form / embed vendors we look for in raw HTML. */
const VENDORS: Record<string, RegExp> = {
  jotform: /jotform\.(com|us)/i,
  'google-forms': /docs\.google\.com\/forms|forms\.gle\//i,
  'microsoft-forms': /forms\.(office|microsoft)\.com/i,
  hubspot: /hsforms\.(net|com)|js\.hs-scripts/i,
  formstack: /formstack\.com/i,
  cognito: /cognitoforms\.com/i,
  wufoo: /wufoo\.com/i,
  typeform: /typeform\.com/i,
  surveymonkey: /surveymonkey\.com/i,
  smartsheet: /smartsheet\.com/i,
  docusign: /docusign\.(net|com)/i,
  'adobe-sign': /echosign|adobesign|documents\.adobe\.com/i,
  'gravity-forms': /gform_wrapper/i,
  'contact-form-7': /wpcf7/i,
  wpforms: /wpforms/i,
  'ninja-forms': /nf-form-cont/i,
  recaptcha: /google\.com\/recaptcha|g-recaptcha/i,
  'google-maps': /maps\.google|google\.com\/maps/i,
  youtube: /youtube\.com\/embed|youtube-nocookie/i,
  vimeo: /player\.vimeo\.com/i,
  issuu: /issuu\.com/i,
  'google-translate': /translate\.google|translate\.goog/i,
  elementor: /elementor/i,
  divi: /et_pb_/i,
  wpbakery: /\[vc_row|vc_column/i,
};

interface BuilderForm {
  /** Input fields (headers, paragraphs and buttons excluded). */
  fields: number;
  types: Record<string, number>;
  error?: string;
}

/** formData is a single-quoted JS string holding JSON; turn it into a JSON string literal, then parse. */
function parseFormBuilder(jsString: string): BuilderForm {
  try {
    const literal = `"${jsString.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"`;
    const elements = JSON.parse(JSON.parse(literal) as string) as { type: string; subtype?: string }[];
    const inputs = elements.filter((el) => !['header', 'paragraph', 'button', 'hidden'].includes(el.type));
    return { fields: inputs.length, types: countBy(elements, (el) => el.type) };
  } catch (err) {
    return { fields: 0, types: {}, error: String(err) };
  }
}

function parsePage(url: string, res: FetchResult): PageRecord {
  const $ = cheerio.load(res.body);
  const base = res.finalUrl || url;
  const contentSelector = CONTENT_SELECTORS.find((sel) => $(sel).length > 0) ?? 'body';
  const $content = $(contentSelector).first();
  const text = cleanText($content.text());

  const fileLinks: PageRecord['fileLinks'] = [];
  const docLinks: PageRecord['docLinks'] = [];
  const internalLinks: string[] = [];
  const externalLinks: Link[] = [];
  let safelinks = 0;
  let youtubeLinks = 0;
  let mailtoLinks = 0;

  $content.find('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const linkText = cleanText($(el).text()) || $(el).attr('title') || '';
    if (/^mailto:/i.test(href.trim())) mailtoLinks++;
    let target = resolveUrl(href, base);
    if (!target) return;
    // Links pasted from Outlook are wrapped in Safe Links; classify the real target.
    if (/safelinks\.protection\.outlook\.com$/i.test(target.hostname)) {
      safelinks++;
      target = resolveUrl(target.searchParams.get('url') ?? undefined, base) ?? target;
    }
    if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(target.hostname)) youtubeLinks++;
    const fileId = fileIdOf(target);
    if (fileId) fileLinks.push({ id: fileId, text: linkText });
    else if (DOC_EXT.test(target.pathname) || (!isSite(target) && (DOC_HOSTS.test(target.hostname) || /\/show_image\.php$/i.test(target.pathname))))
      docLinks.push({ href: target.href, text: linkText, onSite: isSite(target) });
    else if (isSite(target)) internalLinks.push(target.href);
    else externalLinks.push({ href: target.href, text: linkText });
  });

  const fileIds = new Set<number>(fileLinks.map((link) => link.id));
  $('a[href], img[src]').each((_, el) => {
    const target = resolveUrl($(el).attr('href') ?? $(el).attr('src'), base);
    const id = target && fileIdOf(target);
    if (id) fileIds.add(id);
  });
  // News cards use inline background-image: url(/plugins/show_image.php?id=N).
  for (const match of res.body.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
    const target = resolveUrl(match[1], base);
    const id = target && fileIdOf(target);
    if (id) fileIds.add(id);
  }

  const forms = $('form')
    .not('.search-form')
    .map((_, el) => ({
      action: $(el).attr('action') ?? '',
      method: ($(el).attr('method') ?? 'get').toLowerCase(),
      fields: $(el).find('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea').length,
      id: $(el).attr('id') ?? $(el).attr('name') ?? $(el).attr('class') ?? '',
    }))
    .get();

  // Some forms are rendered client-side by jQuery formBuilder from inline JSON.
  const builderForms = [...res.body.matchAll(/formData:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => parseFormBuilder(m[1]!));

  const iframes = $('iframe')
    .map((_, el) => $(el).attr('src') ?? $(el).attr('data-src') ?? '')
    .get()
    .filter(Boolean);

  const scripts = $('script[src]')
    .map((_, el) => resolveUrl($(el).attr('src'), base))
    .get()
    .filter((src): src is URL => !!src && !isSite(src))
    .map((src) => src.hostname);

  const emptyParagraphs = $content
    .find('p')
    .filter((_, el) => cleanText($(el).text()) === '' && $(el).find('img, iframe').length === 0).length;

  const shortcodes = [...text.matchAll(/\[(\/?[a-z][\w-]*)[^\]\n]{0,80}\]/gi)].map((m) => m[1]!.toLowerCase());

  const h1 = cleanText($('h1').first().text()) || cleanText($('.ptitles').first().text());
  const sectionLink = $('#lm_main_page');

  return {
    url,
    finalUrl: res.finalUrl,
    status: res.status,
    group: urlGroup(new URL(url)),
    bytes: Buffer.byteLength(res.body),
    title: cleanText($('title').first().text()),
    h1,
    description: $('meta[name=description]').attr('content') ?? '',
    date: cleanText($('#cms_body_content strong.ptitles').first().text()) || undefined,
    section: sectionLink.length ? cleanText(sectionLink.text()) : undefined,
    contentSelector,
    words: text ? text.split(' ').length : 0,
    contentHash: hash(text),
    fileLinks,
    fileIds: [...fileIds],
    docLinks,
    internalLinks,
    externalLinks,
    images: $content.find('img').length,
    forms,
    builderForms,
    iframes,
    scripts: [...new Set(scripts)],
    vendors: Object.entries(VENDORS)
      .filter(([, re]) => re.test(res.body))
      .map(([name]) => name),
    inlineStyles: $content.find('[style]').length,
    tables: $content.find('table').length,
    emptyParagraphs,
    safelinks,
    youtubeLinks,
    mailtoLinks,
    shortcodes: [...new Set(shortcodes)],
  };
}

// ---------------------------------------------------------------- navigation

interface NavItem {
  label: string;
  href?: string;
  children?: NavItem[];
}

/** cheerio doesn't re-export domhandler's node type, so derive it from load(). */
type AnyNode = Exclude<Parameters<typeof cheerio.load>[0], string | Buffer | unknown[]>;

function navItem($el: cheerio.Cheerio<AnyNode>): NavItem {
  const label = cleanText($el.text()) || $el.attr('aria-label') || $el.find('img').attr('alt') || '';
  const href = $el.attr('href');
  return href ? { label, href } : { label };
}

function extractNav(html: string) {
  const $ = cheerio.load(html);

  const main = $('#bottomNav ul.mainMenu > li')
    .map((_, li) => {
      const item = navItem($(li).children('a').first());
      const children = $(li)
        .find('> ul > li > a')
        .map((_, a) => navItem($(a)))
        .get();
      return children.length ? { ...item, children } : item;
    })
    .get();

  // The mobile menu's first level is an HTML string inside buildMasterMenu();
  // deeper levels are loaded with a POST to /ajax/ajax.php.
  const mobileHtml = html.match(/buildMasterMenu\(\)\s*\{\s*\$\('#mobile-menu-body'\)\.html\("([\s\S]*?)"\);/)?.[1] ?? '';
  const $m = cheerio.load(`<ul>${mobileHtml}</ul>`);
  const mobile = $m('li')
    .map((_, li) => {
      const a = $m(li).find('a').first();
      if (a.length) return { label: cleanText(a.text()), href: a.attr('href') };
      const span = $m(li).find('span').first();
      const id = span.attr('onclick')?.match(/clickMenu\((\d+)\)/)?.[1];
      return { label: cleanText(span.text()), href: id ? `(submenu via /ajax/ajax.php id=${id})` : undefined };
    })
    .get();

  const links = (selector: string) =>
    $(selector)
      .map((_, a) => navItem($(a)))
      .get();

  return {
    utility: links('#topNav > ul > li > a'),
    headerIcons: links('#headerIconContent > a'),
    main,
    mobileTopLevel: mobile,
    sidebarSocial: links('#sideBar a'),
    industryLinks: links('#industryLinks > ul:first-of-type a'),
    footer: links('footer a').filter((item, i, all) => all.findIndex((other) => other.href === item.href && other.label === item.label) === i),
    sectionNav: (() => {
      const parent = $('#lm_main_page');
      if (!parent.length) return undefined;
      return { ...navItem(parent), children: links('#lm_container a.lm_sub_page') };
    })(),
  };
}

/** The CMS's HTML site map (/site-map) is a nested tree of .tree_item divs. */
function extractSiteMapTree(html: string): NavItem[] {
  const $ = cheerio.load(html);
  const toItem = ($el: cheerio.Cheerio<AnyNode>): NavItem => {
    const a = $el.children('a').first();
    const children = $el
      .children('.tree_item')
      .map((_, child) => toItem($(child)))
      .get();
    return { label: cleanText(a.text()), href: a.attr('href'), ...(children.length ? { children } : {}) };
  };
  return $('.tree_item')
    .filter((_, el) => $(el).parents('.tree_item').length === 0)
    .map((_, el) => toItem($(el)))
    .get();
}

function flattenTree(items: NavItem[], depth = 1): { item: NavItem; depth: number }[] {
  return items.flatMap((item) => [{ item, depth }, ...flattenTree(item.children ?? [], depth + 1)]);
}

// ---------------------------------------------------------------- files

interface FileRecord {
  id: number;
  status: number;
  contentType: string;
  bytes: number | null;
  filename: string;
  kind: string;
}

function fileKind(contentType: string, filename: string, status: number): string {
  if (status !== 200) return `missing (${status})`;
  // Some ids answer 200 with an empty text/html body: the record exists but has no file.
  if (contentType.startsWith('text/html')) return 'empty (text/html)';
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (contentType.includes('pdf') || ext === 'pdf') return 'pdf';
  if (/^docx?$/.test(ext) || contentType.includes('msword') || contentType.includes('wordprocessing')) return 'word';
  if (/^(xlsx?|xlsm|csv)$/.test(ext) || contentType.includes('excel') || contentType.includes('spreadsheet')) return 'excel';
  if (/^pptx?$/.test(ext) || contentType.includes('powerpoint') || contentType.includes('presentation')) return 'powerpoint';
  if (contentType.startsWith('image/')) return contentType.split(';')[0]!;
  return `other (${contentType.split(';')[0] || ext || 'unknown'})`;
}

const isLive = (file: FileRecord) => file.status === 200 && !file.kind.startsWith('empty');

async function headFile(id: number): Promise<FileRecord> {
  const res = await fetcher.head(`${ORIGIN}/plugins/show_image.php?id=${id}`);
  const disposition = res.headers['content-disposition'] ?? '';
  const filename = decodeURIComponent(
    disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ?? disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? '',
  );
  const contentType = res.headers['content-type'] ?? '';
  const length = res.headers['content-length'];
  return { id, status: res.status, contentType, bytes: length ? Number(length) : null, filename, kind: fileKind(contentType, filename, res.status) };
}

// ---------------------------------------------------------------- crawl

async function crawl(seeds: URL[], pages: Map<string, PageRecord>, discoveredFrom: Map<string, string>): Promise<void> {
  const queue: URL[] = [];
  const queued = new Set<string>();
  const enqueue = (url: URL, from?: string) => {
    const key = pageKey(url);
    if (queued.has(key) || !shouldCrawl(url)) return;
    queued.add(key);
    if (from) discoveredFrom.set(key, from);
    queue.push(url);
  };
  seeds.forEach((url) => enqueue(url));

  const visit = async (url: URL) => {
    // Always fetch the canonical host/scheme; links sometimes use http:// or no www.
    const fetchUrl = `${ORIGIN}${url.pathname}${url.search}`;
    const res = await fetcher.get(fetchUrl);
    const record = parsePage(fetchUrl, res);
    pages.set(pageKey(url), record);
    if (pages.size % 100 === 0) console.log(`  …${pages.size} pages (${fetcher.networkRequests} network requests)`);
    if (res.status !== 200 || !(res.headers['content-type'] ?? '').includes('html')) return;
    const $ = cheerio.load(res.body);
    $('a[href]').each((_, el) => {
      const target = resolveUrl($(el).attr('href'), res.finalUrl || fetchUrl);
      if (target) enqueue(target, fetchUrl);
    });
  };

  await new Promise<void>((done) => {
    let inFlight = 0;
    const pump = () => {
      while (inFlight < 4 && queue.length && pages.size + inFlight < MAX_PAGES) {
        const url = queue.shift()!;
        inFlight++;
        visit(url)
          .catch((err) => console.warn(`  ! ${url.href}: ${err}`))
          .finally(() => {
            inFlight--;
            pump();
          });
      }
      if (inFlight === 0) done();
    };
    pump();
  });
}

// ---------------------------------------------------------------- domain-specific counts

const MEETING_RE = /\b(meetings?|minutes|agenda|public notice|retreat|workshop|hearing|town hall)\b/i;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Meeting titles carry their date: "June 22rd, 2026 - Board…" → 2026-06-22. */
function titleDate(title: string): string | undefined {
  const m = title.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)\b/i);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

function meetingKind(title: string): string {
  const t = title.toLowerCase();
  if (/union/.test(t)) return 'union negotiations';
  if (/executive search/.test(t)) return 'executive search';
  if (/cost (and|&) admin/.test(t)) return 'cost & admin';
  if (/asset management/.test(t)) return 'asset management committee';
  if (/\brab\b|resident advisory/.test(t)) return 'resident advisory board';
  if (/committee|finance|governance|human resources|acquisition|resident relations|tenant relations/.test(t)) return 'board committee';
  if (/bpaal|brentwood/.test(t)) return 'BPAAL board';
  if (/shade/.test(t)) return 'board shade (closed session)';
  if (/retreat/.test(t)) return 'board retreat';
  if (/special/.test(t)) return 'board special';
  if (/board|boc|commissioner/.test(t)) return 'board regular';
  return 'other';
}

function attachmentKind(text: string): string {
  const t = text.toLowerCase();
  if (/minutes/.test(t)) return 'minutes';
  if (/agenda/.test(t)) return 'agenda';
  if (/packet|board book/.test(t)) return 'packet';
  if (/notice/.test(t)) return 'notice';
  if (/resolution/.test(t)) return 'resolution';
  if (/presentation|slides/.test(t)) return 'presentation';
  return 'other';
}

/** News listing pages: <a href="/news-view?id=N"><strong>MM/DD/YYYY</strong> - Title</a>. */
function parseNewsItems(html: string): { id: number; date: string; title: string }[] {
  const $ = cheerio.load(html);
  return $('a[href*="news-view?id="]')
    .map((_, a) => {
      const id = Number($(a).attr('href')!.match(/id=(\d+)/)![1]);
      const date = cleanText($(a).find('strong').first().text());
      const title = cleanText($(a).text()).replace(date, '').replace(/^\s*-\s*/, '');
      return { id, date, title };
    })
    .get()
    .filter((item) => /^\d{2}\/\d{2}\/\d{4}$/.test(item.date));
}

async function newsInventory() {
  const full = await fetcher.get(`${ORIGIN}/press_full_list.php`);
  const items = parseNewsItems(full.body);
  const listing = await fetcher.get(`${ORIGIN}/news`);
  const $ = cheerio.load(listing.body);
  const categories = $('select[name=category-selector] option')
    .map((_, o) => ({ id: Number($(o).attr('value')), name: cleanText($(o).text()) }))
    .get()
    .filter((c) => c.id > 0);

  // Category membership is only visible in filtered listings, which paginate.
  const membership = new Map<number, string[]>();
  const categoryCounts: Record<string, number> = {};
  for (const category of categories) {
    const ids = new Set<number>();
    const seen = new Set<string>();
    const pending = [`${ORIGIN}/news?category=${category.id}&year=-1`];
    while (pending.length) {
      const url = pending.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await fetcher.get(url);
      parseNewsItems(res.body).forEach((item) => ids.add(item.id));
      const $page = cheerio.load(res.body);
      $page('.paging_div a.page_num').each((_, a) => {
        const next = resolveUrl($page(a).attr('href'), url);
        if (next) pending.push(next.href);
      });
    }
    categoryCounts[category.name] = ids.size;
    for (const id of ids) membership.set(id, [...(membership.get(id) ?? []), category.name]);
  }

  const years = countBy(items, (item) => item.date.slice(6));
  const sorted = [...items].sort((a, b) => a.date.slice(6).localeCompare(b.date.slice(6)) || a.date.localeCompare(b.date));
  return {
    total: items.length,
    idRange: [Math.min(...items.map((i) => i.id)), Math.max(...items.map((i) => i.id))],
    dateRange: [sorted[0]?.date, sorted.at(-1)?.date],
    byYear: Object.fromEntries(Object.entries(years).sort()),
    categories: categoryCounts,
    uncategorized: items.filter((item) => !membership.has(item.id)).length,
    items: items.map((item) => ({ ...item, categories: membership.get(item.id) ?? [] })),
  };
}

async function calendarInventory() {
  const res = await fetcher.get(`${ORIGIN}/calendar`);
  const $ = cheerio.load(res.body);
  const categories = $('#category option')
    .map((_, o) => cleanText($(o).text()))
    .get()
    .filter((name) => !name.includes('All'));
  const years = $('#year option')
    .map((_, o) => $(o).attr('value'))
    .get()
    .filter((v) => /^\d{4}$/.test(v));
  const views: Record<string, string> = {};
  for (const query of ['', ...years.map((y) => `?year=${y}`)]) {
    const view = query ? await fetcher.get(`${ORIGIN}/calendar${query}`) : res;
    const notice = cheerio.load(view.body)('.notice').text();
    views[`/calendar${query}`] = notice ? cleanText(notice) : 'entries present (not parsed)';
  }
  return { categories, years, views };
}

/** Board page lists members as "Name - Role" lines under their photos. */
function boardMembers(html: string): { name: string; role: string }[] {
  const $ = cheerio.load(html);
  $('#bodyContainer br').replaceWith('\n');
  const lines = $('#bodyContainer p')
    .map((_, p) => $(p).text().split('\n').map(cleanText))
    .get();
  return lines.flatMap((line) => {
    const match = line.match(/^(.+?)\s*-\s*(Chair|Vice Chair|Secretary|Commissioner|.*President\/CEO)$/);
    return match ? [{ name: match[1]!, role: match[2]! }] : [];
  });
}

// ---------------------------------------------------------------- main

async function main() {
  const startedAt = Date.now();
  await mkdir(OUT, { recursive: true });
  console.log(`Inventory of ${ORIGIN} → ${path.relative(process.cwd(), OUT)}`);

  // 1. robots.txt and platform fingerprint (which CMS, for choosing content selectors)
  const robotsRes = await fetcher.get(`${ORIGIN}/robots.txt`);
  await save('robots.txt', robotsRes.body);
  const robots = await fetcher.robotsFor(ORIGIN);

  const home = await fetcher.get(`${ORIGIN}/`);
  await save('pages/home.html', home.body);

  const platform = {
    generatorMeta: home.body.match(/<meta[^>]+name=["']generator["'][^>]*>/i)?.[0] ?? null,
    templatePath: home.body.match(/\/templates\/([^/"']+)\//)?.[0] ?? null,
    designCredit: home.body.match(/aria-label="(Site Design[^"]+)"/)?.[1] ?? null,
    proprietaryComment: home.body.match(/<!--\s*(PROPRIETARY[^>]*?)\s*-->/)?.[1] ?? null,
    responseHeaders: Object.fromEntries(
      Object.entries(home.headers).filter(([k]) => ['server', 'unit', 'x-powered-by', 'access-control-allow-origin', 'cache-control', 'set-cookie', 'strict-transport-security', 'x-frame-options'].includes(k)),
    ),
    analyticsIds: [...new Set(home.body.match(/\b(G-[A-Z0-9]{8,}|UA-\d+-\d+|GTM-[A-Z0-9]+)\b/g) ?? [])],
  };

  // 2. Sitemaps
  const sitemapRoots = [...new Set([...robots.getSitemaps(), `${ORIGIN}/sitemap.xml`])];
  const sitemaps = await readSitemaps(fetcher, sitemapRoots);
  for (const sitemap of sitemaps.filter((s) => s.raw)) {
    await save(`sitemaps/${new URL(sitemap.url).pathname.replace(/^\/+/, '').replace(/[^\w.-]+/g, '_')}`, sitemap.raw);
  }
  const sitemapUrls = [...new Set(sitemaps.flatMap((s) => s.urls))].map((u) => new URL(u));
  const sitemapKeys = new Set(sitemapUrls.map(pageKey));

  // 3. HTML site map page (the CMS's own page tree)
  const siteMapPage = await fetcher.get(`${ORIGIN}/site-map`);
  await save('pages/site-map.html', siteMapPage.body);
  const tree = extractSiteMapTree(siteMapPage.body);
  const treeFlat = flattenTree(tree);
  const treeUrls = treeFlat.map(({ item }) => resolveUrl(item.href, `${ORIGIN}/site-map`)).filter((u): u is URL => !!u);
  await save('site-map-tree.json', tree);

  // 4. Crawl: homepage + sitemap + site-map tree, following same-site links
  console.log('Crawling…');
  const pages = new Map<string, PageRecord>();
  const discoveredFrom = new Map<string, string>();
  await crawl([new URL(`${ORIGIN}/`), ...sitemapUrls, ...treeUrls], pages, discoveredFrom);
  const pageList = [...pages.values()];
  const okPages = pageList.filter((p) => p.status === 200);
  const broken = pageList.filter((p) => p.status !== 200);
  console.log(`Crawled ${pageList.length} URLs (${okPages.length} OK).`);

  // 5. Navigation (homepage + one inner page)
  const innerUrl = `${ORIGIN}/hcv-program`;
  const inner = await fetcher.get(innerUrl);
  await save('pages/hcv-program.html', inner.body);
  const nav = { home: extractNav(home.body), inner: extractNav(inner.body) };
  const sameHeaderOnInner = JSON.stringify(nav.home.main) === JSON.stringify(nav.inner.main);

  // 6. File library (show_image.php ids): HEAD every referenced id, then sample the rest
  // asLink: linked (<a href>) from page content, as opposed to only shown as an image.
  const references = new Map<number, { pages: Set<string>; asLink: boolean }>();
  for (const page of okPages) {
    const linked = new Set(page.fileLinks.map((l) => l.id));
    for (const id of page.fileIds) {
      const ref = references.get(id) ?? { pages: new Set<string>(), asLink: false };
      ref.pages.add(page.url);
      ref.asLink ||= linked.has(id);
      references.set(id, ref);
    }
  }
  const sitemapFileIds = new Set(sitemapUrls.map(fileIdOf).filter((id): id is number => !!id));
  for (const id of sitemapFileIds) if (!references.has(id)) references.set(id, { pages: new Set(), asLink: false });

  console.log(`HEAD ${references.size} referenced files…`);
  const files = await Promise.all([...references.keys()].sort((a, b) => a - b).map(headFile));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const maxReferencedId = Math.max(...references.keys());

  // Ids above the highest reference may exist too (recent uploads); probe a little past it.
  const beyond = await Promise.all(Array.from({ length: 40 }, (_, i) => headFile(maxReferencedId + 1 + i)));
  const unreferenced = Array.from({ length: maxReferencedId }, (_, i) => i + 1).filter((id) => !references.has(id));
  const step = Math.max(1, Math.floor(unreferenced.length / ORPHAN_SAMPLE_SIZE));
  const sampleIds = SWEEP_FILE_IDS ? unreferenced : unreferenced.filter((_, i) => i % step === 0).slice(0, ORPHAN_SAMPLE_SIZE);
  console.log(`HEAD ${sampleIds.length} unreferenced ids (${SWEEP_FILE_IDS ? 'full sweep' : 'sample'})…`);
  const unreferencedProbe = await Promise.all(sampleIds.map(headFile));
  const unreferencedFound = unreferencedProbe.filter(isLive);

  const liveFiles = files.filter(isLive);
  const linkedDocs = liveFiles.filter((f) => references.get(f.id)!.asLink);
  const largest = [...liveFiles].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 10);

  // 7. Document links in content: file library vs elsewhere
  const docLinkInstances = okPages.flatMap((p) => [
    ...p.fileLinks.map((l) => ({ page: p.url, where: 'file library (show_image.php)', kind: fileById.get(l.id)?.kind ?? 'unknown', text: l.text })),
    ...p.docLinks.map((l) => ({ page: p.url, where: l.onSite ? 'same host, direct path' : `external: ${new URL(l.href).hostname}`, kind: l.href.match(DOC_EXT)?.[1]?.toLowerCase() ?? 'doc host', text: l.text, href: l.href })),
  ]);
  const docLinkSummary = {
    linkInstances: docLinkInstances.length,
    byWhere: countBy(docLinkInstances, (d) => d.where),
    byKind: countBy(docLinkInstances, (d) => d.kind),
    distinctExternal: [...new Set(okPages.flatMap((p) => p.docLinks.filter((l) => !l.onSite).map((l) => l.href)))],
    distinctSameHostDirect: [...new Set(okPages.flatMap((p) => p.docLinks.filter((l) => l.onSite).map((l) => l.href)))],
  };

  // 8. Domain content
  const news = await newsInventory();
  const calendar = await calendarInventory();

  const contentPages = okPages.filter((p) => ['page', 'page-by-id', 'news-item'].includes(p.group));
  const meetingPages = contentPages.filter((p) => MEETING_RE.test(p.h1 || p.title));
  const meetingAttachments = meetingPages.flatMap((p) => p.fileLinks.map((l) => ({ ...l, kind: attachmentKind(l.text), file: fileById.get(l.id)?.kind })));
  const meetings = {
    pages: meetingPages.length,
    byGroup: countBy(meetingPages, (p) => p.group),
    byKind: countBy(meetingPages, (p) => meetingKind(p.h1 || p.title)),
    byYear: countBy(meetingPages, (p) => (p.h1 || p.title).match(/\b(20\d\d)\b/)?.[1] ?? p.date?.slice(6) ?? 'no year in title'),
    // The same meeting often has several pages (notice, agenda, minutes) and a news item.
    distinctByDateAndKind: new Set(meetingPages.map((p) => titleDate(p.h1 || p.title) && `${titleDate(p.h1 || p.title)} ${meetingKind(p.h1 || p.title)}`).filter(Boolean)).size,
    withoutDateInTitle: meetingPages.filter((p) => !titleDate(p.h1 || p.title)).length,
    withYoutubeLink: meetingPages.filter((p) => p.youtubeLinks > 0).length,
    attachments: { total: meetingAttachments.length, byKind: countBy(meetingAttachments, (a) => a.kind), byFileType: countBy(meetingAttachments, (a) => a.file ?? 'unknown') },
    examples: meetingPages.slice(0, 15).map((p) => ({ url: p.url, title: p.h1, group: p.group })),
  };

  const members = boardMembers((await fetcher.get(`${ORIGIN}/board-of-commissioners`)).body);

  const formPages = okPages
    .filter((p) => p.forms.length || p.iframes.length || p.vendors.some((v) => !['google-translate', 'youtube', 'google-maps'].includes(v)))
    .map((p) => ({ url: p.url, title: p.h1, forms: p.forms, builderForms: p.builderForms, iframes: p.iframes, vendors: p.vendors.filter((v) => v !== 'google-translate') }));

  const externalHosts = new Map<string, { links: number; pages: Set<string>; sample: Link }>();
  for (const page of okPages) {
    for (const link of page.externalLinks) {
      const host = new URL(link.href).hostname.replace(/^www\./, '');
      const entry = externalHosts.get(host) ?? { links: 0, pages: new Set<string>(), sample: link };
      entry.links++;
      entry.pages.add(page.url);
      externalHosts.set(host, entry);
    }
  }

  // 9. Migration risk signals
  const slugPages = okPages.filter((p) => p.group === 'page');
  const slugOf = (p: PageRecord) => decodeURIComponent(new URL(p.url).pathname.slice(1));
  const wpSafe = (slug: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
  const duplicates = Object.values(
    okPages.reduce<Record<string, string[]>>((acc, p) => {
      if (p.words > 20) (acc[p.contentHash] ??= []).push(p.url);
      return acc;
    }, {}),
  ).filter((urls) => urls.length > 1);

  const risks = {
    slugs: {
      slugPages: slugPages.length,
      notWpSafe: slugPages.filter((p) => !wpSafe(slugOf(p).toLowerCase())).map(slugOf),
      mixedCase: slugPages.filter((p) => slugOf(p) !== slugOf(p).toLowerCase()).map(slugOf),
    },
    queryStringUrls: countBy(
      okPages.filter((p) => new URL(p.url).search),
      (p) => new URL(p.url).pathname,
    ),
    thinPages: okPages
      .filter((p) => ['page', 'page-by-id'].includes(p.group) && p.words < 40)
      .map((p) => ({ url: p.url, title: p.h1, words: p.words })),
    largestByWords: [...okPages].sort((a, b) => b.words - a.words).slice(0, 8).map((p) => ({ url: p.url, words: p.words, bytes: p.bytes })),
    largestByBytes: [...okPages].sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((p) => ({ url: p.url, bytes: p.bytes })),
    pagesWithTables: okPages.filter((p) => p.tables > 0).length,
    pagesWithInlineStyles: okPages.filter((p) => p.inlineStyles > 0).length,
    inlineStyleAttributes: okPages.reduce((n, p) => n + p.inlineStyles, 0),
    emptyParagraphs: okPages.reduce((n, p) => n + p.emptyParagraphs, 0),
    safelinks: { links: okPages.reduce((n, p) => n + p.safelinks, 0), pages: okPages.filter((p) => p.safelinks > 0).map((p) => p.url) },
    youtube: { links: okPages.reduce((n, p) => n + p.youtubeLinks, 0), pages: okPages.filter((p) => p.youtubeLinks > 0).length },
    iframes: countBy(okPages.flatMap((p) => p.iframes), (src) => resolveUrl(src, ORIGIN)?.hostname ?? src),
    shortcodeLike: okPages.filter((p) => p.shortcodes.length).map((p) => ({ url: p.url, shortcodes: p.shortcodes })),
    vendors: countBy(okPages.flatMap((p) => p.vendors), (v) => v),
    thirdPartyScripts: countBy(okPages.flatMap((p) => p.scripts), (s) => s),
    duplicateContent: duplicates,
    nonHtml: pageList.filter((p) => p.status === 200 && !p.title && !p.h1).map((p) => p.url),
  };

  // Write everything out
  const summary = {
    scan: {
      date: new Date().toISOString(),
      origin: ORIGIN,
      userAgent: USER_AGENT,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      networkRequests: fetcher.networkRequests,
      sweepFileIds: SWEEP_FILE_IDS,
    },
    robots: { text: robotsRes.body, crawlDelay: robots.getCrawlDelay(USER_AGENT) ?? null, sitemaps: robots.getSitemaps() },
    platform,
    sitemaps: sitemaps.map((s) => ({ url: s.url, status: s.status, kind: s.kind, urls: s.urls.length, children: s.children })),
    sitemapByGroup: countBy(sitemapUrls, (u) => urlGroup(u)),
    siteMapTree: {
      nodes: treeFlat.length,
      maxDepth: Math.max(...treeFlat.map((t) => t.depth)),
      topLevel: tree.map((t) => ({ label: t.label, href: t.href, descendants: flattenTree(t.children ?? []).length })),
      notInSitemapXml: treeUrls.filter((u) => !sitemapKeys.has(pageKey(u))).length,
    },
    crawl: {
      urlsFetched: pageList.length,
      ok: okPages.length,
      byStatus: countBy(pageList, (p) => String(p.status)),
      okByGroup: countBy(okPages, (p) => p.group),
      notInSitemap: okPages.filter((p) => !sitemapKeys.has(pageKey(new URL(p.url)))).length,
      notInSitemapExamples: okPages.filter((p) => !sitemapKeys.has(pageKey(new URL(p.url)))).slice(0, 25).map((p) => p.url),
      sitemapUrlsSkipped: sitemapUrls.filter((u) => !fileIdOf(u) && !shouldCrawl(u)).map((u) => u.href),
      broken: broken.map((p) => ({ url: p.url, status: p.status, linkedFrom: discoveredFrom.get(pageKey(new URL(p.url))) ?? '(seed)' })),
      redirects: pageList.filter((p) => p.finalUrl.toLowerCase() !== p.url.toLowerCase()).map((p) => ({ from: p.url, to: p.finalUrl })),
      contentSelectors: countBy(okPages, (p) => p.contentSelector),
      totalWords: okPages.reduce((n, p) => n + p.words, 0),
    },
    files: {
      referencedIds: references.size,
      inSitemap: sitemapFileIds.size,
      live: liveFiles.length,
      missing: files.filter((f) => f.status !== 200).map((f) => ({ id: f.id, status: f.status, pages: [...references.get(f.id)!.pages].slice(0, 3) })),
      byKind: countBy(liveFiles, (f) => f.kind),
      linkedDocumentsByKind: countBy(linkedDocs, (f) => f.kind),
      imagesOnlyEmbedded: liveFiles.filter((f) => !references.get(f.id)!.asLink).length,
      // Images are served without Content-Length, so sizes cover documents only.
      knownBytes: liveFiles.reduce((n, f) => n + (f.bytes ?? 0), 0),
      unknownSize: countBy(liveFiles.filter((f) => f.bytes === null), (f) => f.kind),
      bytesByKind: Object.fromEntries(
        Object.keys(countBy(liveFiles, (f) => f.kind))
          .filter((kind) => liveFiles.some((f) => f.kind === kind && f.bytes !== null))
          .map((kind) => [kind, liveFiles.filter((f) => f.kind === kind).reduce((n, f) => n + (f.bytes ?? 0), 0)]),
      ),
      largest: largest.map((f) => ({ id: f.id, filename: f.filename, bytes: f.bytes, kind: f.kind })),
      filenameExtensions: countBy(liveFiles, (f) => f.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '(none)'),
      idRange: [Math.min(...references.keys()), maxReferencedId],
      beyondMaxReferenced: { probed: beyond.length, found: beyond.filter((f) => f.status === 200).map((f) => ({ id: f.id, kind: f.kind, filename: f.filename })) },
      unreferencedProbe: {
        candidates: unreferenced.length,
        probed: unreferencedProbe.length,
        found: unreferencedFound.length,
        byKind: countBy(unreferencedFound, (f) => f.kind),
        byStatus: countBy(unreferencedProbe, (f) => String(f.status)),
        estimatedLiveUnreferenced: SWEEP_FILE_IDS
          ? unreferencedFound.length
          : Math.round((unreferencedFound.length / Math.max(1, unreferencedProbe.length)) * unreferenced.length),
        examples: unreferencedFound.slice(0, 10).map((f) => ({ id: f.id, kind: f.kind, filename: f.filename })),
      },
    },
    docLinks: docLinkSummary,
    nav,
    sameHeaderOnInner,
    news: { ...news, items: undefined },
    calendar,
    meetings,
    boardMembers: members,
    forms: formPages,
    externalHosts: [...externalHosts.entries()]
      .sort((a, b) => b[1].links - a[1].links)
      .map(([host, e]) => ({ host, links: e.links, pages: e.pages.size, sample: e.sample })),
    risks,
  };

  await save('inventory.json', summary);
  await save('pages.json', pageList);
  await save('files.json', { referenced: files.map((f) => ({ ...f, pages: [...references.get(f.id)!.pages] })), unreferencedProbe, beyond });
  await save('news.json', news.items);

  console.log(
    JSON.stringify(
      {
        sitemapUrls: sitemapUrls.length,
        crawled: summary.crawl,
        files: { referenced: references.size, byKind: summary.files.byKind, estimatedUnreferenced: summary.files.unreferencedProbe.estimatedLiveUnreferenced },
        news: { total: news.total, dateRange: news.dateRange },
        meetings: { pages: meetings.pages },
        forms: formPages.length,
        networkRequests: fetcher.networkRequests,
        durationSec: summary.scan.durationSec,
      },
      (k, v) => (k === 'notInSitemapExamples' || k === 'broken' || k === 'sitemapUrlsSkipped' ? undefined : v),
      2,
    ),
  );
}

await main();
