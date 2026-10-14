import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import robotsParserModule from 'robots-parser';
import { dispositionFilename, extensionForMime, extensionOf } from './urls.js';
import { safeFetch } from '@wm/net';

// robots-parser is CommonJS (module.exports = fn) but its types declare an ES
// default export, so under NodeNext the default import is typed as the namespace.
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;
type Robots = ReturnType<typeof robotsParser>;

export interface FetchResult {
  method: 'GET' | 'HEAD';
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  /** Response text for GET; empty for HEAD. */
  body: string;
  fetchedAt: string;
  fromCache: boolean;
}

/** A file fetched with download(): the body is streamed to disk, never held in memory. */
export interface DownloadResult {
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  /** Basename of the saved body inside the download directory (`<sha256>.<ext>`); null when nothing was saved. */
  file: string | null;
  bytes: number;
  sha256: string | null;
  fetchedAt: string;
  fromCache: boolean;
}

export interface PoliteFetcherOptions {
  userAgent: string;
  /** Max requests in flight at once. */
  concurrency?: number;
  /** Minimum gap between request starts; raised to robots.txt Crawl-delay when present. */
  minIntervalMs?: number;
  /** Retries for network errors, 429 and 5xx. */
  retries?: number;
  timeoutMs?: number;
  /** Timeout for one download() attempt, body included. */
  downloadTimeoutMs?: number;
  /** When set, responses are cached here and reused on later runs. */
  cacheDir?: string;
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`Disallowed by robots.txt: ${url}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Remembers what download() saved in a directory (one JSON line per URL; later lines win). */
const DOWNLOAD_INDEX = '.index.jsonl';

/** Extensions of server scripts that serve files (show_image.php?id=N): never a file's own extension. */
const SCRIPT_EXT = /^(php\d?|aspx?|ashx|jsp|cfm|cgi|pl)$/;

const sizeOf = (file: string) => stat(file).then((s) => s.size, () => -1);

/** Network errors (status 0), 429s and 5xx aren't cached, so a re-run tries them again. */
const isCacheable = (status: number) => status > 0 && status !== 429 && status < 500;

/**
 * fetch() wrapper for crawling other people's sites: caps concurrency, spaces out
 * requests, honours robots.txt (Disallow + Crawl-delay), retries with backoff and
 * caches responses on disk so re-runs don't hit the site again.
 */
export class PoliteFetcher {
  readonly userAgent: string;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly cacheDir?: string;
  private intervalMs: number;

  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private nextStartAt = 0;
  private readonly robots = new Map<string, Promise<Robots>>();
  /** Per download directory: URL → earlier result, from that directory's index file. */
  private readonly downloadIndexes = new Map<string, Promise<Map<string, DownloadResult>>>();
  private indexWrites: Promise<void> = Promise.resolve();

  /** Requests that actually went over the network (not served from cache). */
  networkRequests = 0;

  constructor(opts: PoliteFetcherOptions) {
    this.userAgent = opts.userAgent;
    this.concurrency = opts.concurrency ?? 4;
    this.intervalMs = opts.minIntervalMs ?? 250;
    this.retries = opts.retries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? 300_000;
    this.cacheDir = opts.cacheDir;
  }

  get(url: string): Promise<FetchResult> {
    return this.request('GET', url);
  }

  head(url: string): Promise<FetchResult> {
    return this.request('HEAD', url);
  }

  /**
   * GET a file and stream its body into `dir` as `<sha256>.<ext>` (extension from
   * Content-Disposition, else the content type, else the URL unless it's a script
   * like show_image.php). Same politeness as get(): robots.txt, concurrency
   * slots, spacing and retries.
   *
   * Downloads are remembered in `dir/.index.jsonl` (URL → result), so a re-run
   * into the same directory doesn't download again while the saved file is still
   * there. Empty and text/html bodies aren't saved (an HTML answer means "no file").
   */
  async download(url: string, dir: string): Promise<DownloadResult> {
    const robots = await this.robotsFor(url);
    if (robots.isAllowed(url, this.userAgent) === false) throw new RobotsDisallowedError(url);

    const index = await this.downloadIndex(dir);
    const known = index.get(url);
    if (known && (known.file === null || (await sizeOf(path.join(dir, known.file))) === known.bytes)) {
      return { ...known, fromCache: true };
    }

    await mkdir(dir, { recursive: true });
    const result = await this.withSlot(() => this.downloadWithRetry(url, dir));
    if (isCacheable(result.status)) {
      index.set(url, result);
      const line = `${JSON.stringify({ ...result, fromCache: undefined })}\n`;
      // Appends are chained so concurrent downloads don't interleave lines.
      const write = this.indexWrites.then(() => appendFile(path.join(dir, DOWNLOAD_INDEX), line));
      this.indexWrites = write.catch(() => undefined);
      await write;
    }
    return result;
  }

  /** Parsed robots.txt for the URL's origin (fetched once per origin). */
  robotsFor(url: string): Promise<Robots> {
    const origin = new URL(url).origin;
    let robots = this.robots.get(origin);
    if (!robots) {
      robots = this.loadRobots(origin);
      this.robots.set(origin, robots);
    }
    return robots;
  }

  async request(method: 'GET' | 'HEAD', url: string): Promise<FetchResult> {
    const robots = await this.robotsFor(url);
    if (robots.isAllowed(url, this.userAgent) === false) throw new RobotsDisallowedError(url);

    const cached = await this.readCache(method, url);
    if (cached) return cached;

    const result = await this.withSlot(() => this.fetchWithRetry(method, url));
    if (isCacheable(result.status)) await this.writeCache(result);
    return result;
  }

  private async loadRobots(origin: string): Promise<Robots> {
    const robotsUrl = `${origin}/robots.txt`;
    let text = '';
    const cached = await this.readCache('GET', robotsUrl);
    const res = cached ?? (await this.withSlot(() => this.fetchWithRetry('GET', robotsUrl)));
    if (!cached && isCacheable(res.status)) await this.writeCache(res);
    // A missing robots.txt means everything is allowed.
    if (res.status === 200) text = res.body;

    const robots = robotsParser(robotsUrl, text);
    const crawlDelay = robots.getCrawlDelay(this.userAgent);
    if (crawlDelay) this.intervalMs = Math.max(this.intervalMs, crawlDelay * 1000);
    return robots;
  }

  /** Runs fn with one of the concurrency slots, spacing out start times. */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // slot handed over by release

    const now = Date.now();
    const startAt = Math.max(now, this.nextStartAt);
    this.nextStartAt = startAt + this.intervalMs;
    if (startAt > now) await sleep(startAt - now);

    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  private async fetchWithRetry(method: 'GET' | 'HEAD', url: string): Promise<FetchResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.networkRequests++;
        const res = await safeFetch(url, {
          method,
          redirect: 'follow',
          headers: { 'User-Agent': this.userAgent, Accept: '*/*' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = method === 'GET' ? await res.text() : '';
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= this.retries) {
          return {
            method,
            url,
            finalUrl: res.url,
            status: res.status,
            headers: Object.fromEntries(res.headers),
            body,
            fetchedAt: new Date().toISOString(),
            fromCache: false,
          };
        }
        await sleep(this.backoffMs(attempt, res.headers.get('retry-after')));
      } catch (err) {
        if (attempt >= this.retries) {
          // Report network failures as status 0 rather than throwing, so one bad
          // URL doesn't abort a crawl.
          return {
            method,
            url,
            finalUrl: url,
            status: 0,
            headers: { 'x-error': String((err as Error).cause ?? err) },
            body: '',
            fetchedAt: new Date().toISOString(),
            fromCache: false,
          };
        }
        await sleep(this.backoffMs(attempt, null));
      }
    }
  }

  private async downloadWithRetry(url: string, dir: string): Promise<DownloadResult> {
    for (let attempt = 0; ; attempt++) {
      const tmp = path.join(dir, `.tmp-${randomUUID()}`);
      try {
        this.networkRequests++;
        const res = await safeFetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': this.userAgent, Accept: '*/*' },
          signal: AbortSignal.timeout(this.downloadTimeoutMs),
        });
        const headers = Object.fromEntries(res.headers);
        const done = (extra: Partial<DownloadResult>): DownloadResult => ({
          url,
          finalUrl: res.url,
          status: res.status,
          headers,
          file: null,
          bytes: 0,
          sha256: null,
          fetchedAt: new Date().toISOString(),
          fromCache: false,
          ...extra,
        });
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < this.retries) {
          await res.body?.cancel();
          await sleep(this.backoffMs(attempt, res.headers.get('retry-after')));
          continue;
        }
        if (res.status !== 200 || !res.body) {
          await res.body?.cancel();
          return done({});
        }

        const hash = createHash('sha256');
        let bytes = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk);
            bytes += chunk.length;
            callback(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), meter, createWriteStream(tmp));
        const contentType = headers['content-type'] ?? '';
        if (bytes === 0 || contentType.toLowerCase().startsWith('text/html')) {
          await unlink(tmp);
          return done({ bytes });
        }
        const sha256 = hash.digest('hex');
        const urlExt = extensionOf(new URL(res.url || url).pathname);
        const ext =
          extensionOf(dispositionFilename(headers['content-disposition'])) ??
          extensionForMime(contentType) ??
          (urlExt && !SCRIPT_EXT.test(urlExt) ? urlExt : undefined) ??
          'bin';
        const file = `${sha256}.${ext}`;
        // Same content already saved (another URL, or an earlier run): keep that copy.
        if ((await sizeOf(path.join(dir, file))) === bytes) await unlink(tmp);
        else await rename(tmp, path.join(dir, file));
        return done({ file, bytes, sha256 });
      } catch (err) {
        await unlink(tmp).catch(() => undefined);
        if (attempt >= this.retries) {
          return {
            url,
            finalUrl: url,
            status: 0,
            headers: { 'x-error': String((err as Error).cause ?? err) },
            file: null,
            bytes: 0,
            sha256: null,
            fetchedAt: new Date().toISOString(),
            fromCache: false,
          };
        }
        await sleep(this.backoffMs(attempt, null));
      }
    }
  }

  private downloadIndex(dir: string): Promise<Map<string, DownloadResult>> {
    let index = this.downloadIndexes.get(dir);
    if (!index) {
      index = readFile(path.join(dir, DOWNLOAD_INDEX), 'utf8')
        .then((text) => {
          const rows = text.split('\n').filter((line) => line.trim());
          return new Map(rows.map((line) => JSON.parse(line) as DownloadResult).map((row) => [row.url, row]));
        })
        .catch(() => new Map<string, DownloadResult>());
      this.downloadIndexes.set(dir, index);
    }
    return index;
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    const seconds = Number(retryAfter);
    if (retryAfter && Number.isFinite(seconds)) return seconds * 1000;
    return 1000 * 2 ** attempt + Math.random() * 250;
  }

  private cachePath(method: string, url: string): string | undefined {
    if (!this.cacheDir) return undefined;
    const key = createHash('sha256').update(`${method} ${url}`).digest('hex').slice(0, 24);
    return path.join(this.cacheDir, `${key}.json`);
  }

  private async readCache(method: 'GET' | 'HEAD', url: string): Promise<FetchResult | undefined> {
    const file = this.cachePath(method, url);
    if (!file) return undefined;
    try {
      const result = JSON.parse(await readFile(file, 'utf8')) as FetchResult;
      return { ...result, fromCache: true };
    } catch {
      return undefined;
    }
  }

  private async writeCache(result: FetchResult): Promise<void> {
    const file = this.cachePath(result.method, result.url);
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...result, fromCache: undefined }));
  }
}
