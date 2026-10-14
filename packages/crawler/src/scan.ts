import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { jobPath, sourceKey, writeJson, writeJsonl, type JobInfo, type SnapshotFile, type SnapshotPage } from '@wm/core';
import { PoliteFetcher, RobotsDisallowedError, type FetchResult } from './polite-fetch.js';
import { getSiteProfile, type SiteProfile } from './profiles.js';
import { readSitemaps } from './sitemaps.js';
import { dispositionFilename, extensionOf, isSameSite, mimeForExtension, onOrigin, resolveUrl, unwrapSafeLink } from './urls.js';

export interface ScanOptions {
  jobId: string;
  /** Site origin, e.g. https://www.jaxha.org. Links on other hosts aren't crawled. */
  origin: string;
  /** Platform profile name (see profiles.ts): 'bjm', 'generic'. */
  profile: string;
  /** HTTP response cache shared across runs (PoliteFetcher format). */
  cacheDir?: string;
  maxPages?: number;
  userAgent?: string;
  log?: (msg: string) => void;
}

export interface ScanSummary {
  jobId: string;
  origin: string;
  profile: string;
  pages: number;
  pagesByStatus: Record<string, number>;
  pagesByVia: Record<string, number>;
  files: {
    /** Same-site files referenced from crawled pages (all downloaded or attempted). */
    referenced: number;
    downloaded: number;
    /** Referenced but not saved (missing, gone, empty). */
    failed: number;
    /** Listed only in sitemap.xml: recorded from a HEAD, not downloaded. */
    sitemapOnly: number;
    bytes: number;
    byType: Record<string, { count: number; bytes: number }>;
  };
  /** Requests that went over the network (the rest came from the caches). */
  networkRequests: number;
  durationMs: number;
}

const DEFAULT_USER_AGENT = 'website-mover/0.1 (+internal migration tool)';

interface QueueItem {
  url: string;
  via: string;
}

/**
 * Crawls a site into the job's snapshot:
 *
 *   robots.txt → sitemaps → the profile's HTML site map → same-site BFS over links
 *
 * Pages are deduped by sourceKey and always fetched on the origin's scheme and
 * host. Every same-site file a crawled page links to or embeds (by the
 * profile's file rule) is downloaded into snapshot/files/. Files nothing links
 * to are not looked for, and files on other hosts aren't recorded.
 *
 * Writes job.json, snapshot/pages.jsonl (+ snapshot/html/<sha1(url)>.html) and
 * snapshot/files.jsonl (+ snapshot/files/<sha256>.<ext>).
 */
export async function scanSite(options: ScanOptions): Promise<ScanSummary> {
  const startedAt = Date.now();
  const log = options.log ?? (() => {});
  const profile = getSiteProfile(options.profile);
  const origin = new URL(options.origin).origin;
  const maxPages = options.maxPages ?? 5000;
  const fetcher = new PoliteFetcher({
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    concurrency: 4,
    minIntervalMs: 250,
    cacheDir: options.cacheDir,
  });
  const job = (...parts: string[]) => jobPath(options.jobId, ...parts);
  await mkdir(job('snapshot', 'html'), { recursive: true });

  const crawl = new Crawl(origin, profile, fetcher, maxPages, log, options.jobId);

  // 1. robots.txt and sitemaps
  const robots = await fetcher.robotsFor(origin);
  const sitemapRoots = [...new Set([...robots.getSitemaps(), `${origin}/sitemap.xml`])];
  const sitemaps = await readSitemaps(fetcher, sitemapRoots);
  const sitemapUrls = [...new Set(sitemaps.flatMap((s) => s.urls))];
  log(`${sitemapUrls.length} URLs in ${sitemaps.filter((s) => s.kind === 'urlset').length} sitemap(s)`);

  // 2. Seeds: homepage, the profile's HTML site maps, sitemap URLs
  crawl.enqueue(new URL(`${origin}/`), 'seed');
  const siteMapItems = profile.siteMapPaths.map((p) => crawl.enqueue(new URL(p, origin), 'seed')).filter((item): item is QueueItem => item !== undefined);
  for (const href of sitemapUrls) {
    const url = resolveUrl(href, origin);
    if (url) crawl.enqueue(url, 'sitemap');
  }

  // 3. HTML site maps first, so the pages they list are tagged 'site-map', then BFS
  for (const item of siteMapItems) {
    crawl.dequeue(item);
    await crawl.visit(item, 'site-map');
  }
  await crawl.run();
  log(`Crawled ${crawl.pages.length} URLs (${fetcher.networkRequests} network requests so far)`);

  // 4. Files: download what crawled pages reference; record sitemap-only files from a HEAD
  const filesDir = job('snapshot', 'files');
  const referenced = [...crawl.fileRefs.keys()].sort(byFileOrder);
  log(`Downloading ${referenced.length} referenced files…`);
  let done = 0;
  const files: SnapshotFile[] = await Promise.all(
    referenced.map(async (url) => {
      const res = await fetcher.download(url, filesDir).catch((err) => {
        if (err instanceof RobotsDisallowedError) return undefined;
        throw err;
      });
      if (++done % 50 === 0) log(`  …${done}/${referenced.length} files (${fetcher.networkRequests} network requests so far)`);
      const filename = dispositionFilename(res?.headers['content-disposition']) ?? pathFilename(url);
      return {
        url,
        finalUrl: res?.finalUrl ?? url,
        status: res?.status ?? 0,
        contentType: fileContentType(res?.headers['content-type'], filename),
        filename,
        bytes: res?.bytes ?? 0,
        sha256: res?.sha256 ?? null,
        path: res?.file ? `snapshot/files/${res.file}` : null,
        referencedBy: [...crawl.fileRefs.get(url)!].sort(),
      };
    }),
  );

  const sitemapOnly = [...crawl.sitemapFiles].filter((url) => !crawl.fileRefs.has(url)).sort(byFileOrder);
  for (const url of sitemapOnly) {
    const res = await fetcher.head(url).catch(() => undefined);
    const filename = dispositionFilename(res?.headers['content-disposition']) ?? pathFilename(url);
    files.push({
      url,
      finalUrl: res?.finalUrl ?? url,
      status: res?.status ?? 0,
      contentType: fileContentType(res?.headers['content-type'], filename),
      filename,
      bytes: Number(res?.headers['content-length'] ?? 0) || 0,
      sha256: null,
      path: null,
      referencedBy: [],
    });
  }

  // 5. Write the snapshot
  await writeJson(job('job.json'), { id: options.jobId, origin, profile: profile.name, scannedAt: new Date().toISOString() } satisfies JobInfo);
  await writeJsonl(job('snapshot', 'pages.jsonl'), crawl.pages);
  await writeJsonl(job('snapshot', 'files.jsonl'), files);

  const saved = files.filter((f) => f.path);
  const byType: ScanSummary['files']['byType'] = {};
  for (const file of saved) {
    const type = file.contentType.split(';')[0]!.trim() || 'unknown';
    const entry = (byType[type] ??= { count: 0, bytes: 0 });
    entry.count++;
    entry.bytes += file.bytes;
  }
  return {
    jobId: options.jobId,
    origin,
    profile: profile.name,
    pages: crawl.pages.length,
    pagesByStatus: countBy(crawl.pages, (p) => String(p.status)),
    pagesByVia: countBy(crawl.pages, (p) => p.via),
    files: {
      referenced: referenced.length,
      downloaded: saved.length,
      failed: referenced.length - saved.length,
      sitemapOnly: sitemapOnly.length,
      bytes: saved.reduce((n, f) => n + f.bytes, 0),
      byType,
    },
    networkRequests: fetcher.networkRequests,
    durationMs: Date.now() - startedAt,
  };
}

/** The crawl's queue, visited pages and file references. */
class Crawl {
  readonly pages: SnapshotPage[] = [];
  /** Canonical file URL → source keys of the pages referencing it. */
  readonly fileRefs = new Map<string, Set<string>>();
  /** Canonical file URLs listed in sitemap.xml. */
  readonly sitemapFiles = new Set<string>();
  private readonly queue: QueueItem[] = [];
  private readonly queued = new Set<string>();

  constructor(
    private readonly origin: string,
    private readonly profile: SiteProfile,
    private readonly fetcher: PoliteFetcher,
    private readonly maxPages: number,
    private readonly log: (msg: string) => void,
    private readonly jobId: string,
  ) {}

  /** Queues a page URL (once per source key) and returns its queue item; files and skipped URLs return undefined. */
  enqueue(raw: URL, via: string): QueueItem | undefined {
    const file = this.profile.fileUrl(raw, this.origin);
    if (file) {
      if (via === 'sitemap') this.sitemapFiles.add(file);
      return undefined;
    }
    if (!isSameSite(raw, this.origin) || !this.profile.shouldCrawl(raw)) return undefined;
    const url = onOrigin(raw, this.origin);
    url.hash = '';
    const key = sourceKey(url);
    if (this.queued.has(key)) return undefined;
    this.queued.add(key);
    const item = { url: url.href, via };
    this.queue.push(item);
    return item;
  }

  dequeue(item: QueueItem): void {
    const i = this.queue.indexOf(item);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** Breadth-first over the queue until it's empty or maxPages is reached. */
  async run(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let inFlight = 0;
      const pump = () => {
        // Cache hits don't take fetcher slots, so a little more parallelism keeps parsing busy.
        while (inFlight < 8 && this.queue.length && this.pages.length + inFlight < this.maxPages) {
          const item = this.queue.shift()!;
          inFlight++;
          this.visit(item, 'link')
            .then(() => {
              inFlight--;
              pump();
            })
            .catch(reject);
        }
        if (inFlight === 0) resolve();
      };
      pump();
    });
  }

  /** Fetches one page, records it, and queues the links found on it (tagged `linkVia`). */
  async visit(item: QueueItem, linkVia: string): Promise<void> {
    let res: FetchResult;
    try {
      res = await this.fetcher.get(item.url);
    } catch (err) {
      if (err instanceof RobotsDisallowedError) {
        this.log(`  robots.txt disallows ${item.url}`);
        return;
      }
      throw err;
    }
    const contentType = res.headers['content-type'] ?? '';
    const isHtml = /html/i.test(contentType) && res.body.length > 0;
    let html: string | null = null;
    if (isHtml) {
      html = `snapshot/html/${createHash('sha1').update(item.url).digest('hex')}.html`;
      await writeFile(jobPath(this.jobId, html), res.body);
    }
    this.pages.push({ url: item.url, finalUrl: res.finalUrl || item.url, status: res.status, contentType, fetchedAt: res.fetchedAt, html, via: item.via });
    if (this.pages.length % 100 === 0) this.log(`  …${this.pages.length} pages (${this.fetcher.networkRequests} network requests so far)`);
    if (res.status !== 200 || !isHtml) return;

    const base = res.finalUrl || item.url;
    const final = new URL(base);
    // A redirect target is a page of its own (e.g. /locations → /locations/map).
    if (sourceKey(final) !== sourceKey(item.url)) this.enqueue(final, 'redirect');

    const $ = cheerio.load(res.body);
    const pageKey = sourceKey(isSameSite(final, this.origin) ? final : item.url);
    const addFile = (raw: URL) => {
      const file = this.profile.fileUrl(raw, this.origin);
      if (!file) return false;
      let refs = this.fileRefs.get(file);
      if (!refs) this.fileRefs.set(file, (refs = new Set()));
      refs.add(pageKey);
      return true;
    };

    $('a[href], area[href]').each((_, el) => {
      let url = resolveUrl($(el).attr('href'), base);
      if (!url) return;
      url = unwrapSafeLink(url) ?? url;
      if (!addFile(url)) this.enqueue(url, linkVia);
    });
    $('img[src], source[src], iframe[src], embed[src], object[data], video[poster]').each((_, el) => {
      const url = resolveUrl($(el).attr('src') ?? $(el).attr('data') ?? $(el).attr('poster'), base);
      if (url) addFile(url);
    });
    $('img[srcset], source[srcset]').each((_, el) => {
      for (const candidate of ($(el).attr('srcset') ?? '').split(',')) {
        const url = resolveUrl(candidate.trim().split(/\s+/)[0], base);
        if (url) addFile(url);
      }
    });
    // Inline backgrounds (BJM's news cards: style="background-image: url(/plugins/show_image.php?id=N)").
    for (const match of res.body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const url = resolveUrl(match[1], base);
      if (url) addFile(url);
    }
    for (const href of this.profile.extraPages?.(final, $) ?? []) {
      const url = resolveUrl(href, base);
      if (url) this.enqueue(url, 'profile');
    }
  }
}

/** Last path segment when it looks like a filename (not a script such as show_image.php). */
function pathFilename(url: string): string | null {
  const segment = new URL(url).pathname.split('/').pop() ?? '';
  if (!extensionOf(segment) || /\.(php|aspx?|jsp|cfm|cgi|pl)$/i.test(segment)) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The server's content type, except that a generic one (BJM sends Word and
 * Excel files as application/octet-stream) is replaced by the filename's type.
 */
function fileContentType(header: string | undefined, filename: string | null): string {
  const type = header?.split(';')[0]!.trim().toLowerCase() ?? '';
  if (type && type !== 'application/octet-stream' && type !== 'binary/octet-stream') return header!;
  return mimeForExtension(extensionOf(filename)) ?? (type || 'application/octet-stream');
}

/** Numeric ids sort numerically (show_image.php?id=2 before id=10). */
function byFileOrder(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
