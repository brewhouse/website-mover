import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import {
  jobPath,
  readJson,
  readJsonl,
  sourceKey,
  writeJsonl,
  type ExtractedPage,
  type JobInfo,
  type PageKind,
  type SnapshotFile,
  type SnapshotPage,
} from '@wm/core';
import { DOC_EXT, getSiteProfile, isSameSite } from '@wm/crawler';
import { classify } from './classify.js';
import { cleanContent, removeLeadingTitle } from './clean.js';
import { createExtractProfile } from './profiles/index.js';
import type { ExtractContext, ExtractProfile, PageRef } from './profiles/types.js';
import { cleanText, countWords } from './text.js';

export interface ExtractOptions {
  jobId: string;
  log?: (msg: string) => void;
}

export interface ExtractSummary {
  jobId: string;
  profile: string;
  pages: number;
  byKind: Partial<Record<PageKind, number>>;
  /** Kind reasons (rule names) with counts. */
  byReason: Record<string, number>;
  /** Crawled URLs that redirected to another page (listed in extract/redirects.jsonl, not extracted). */
  redirects: number;
  news: { total: number; withDate: number; withCategory: number };
  /** Warning codes (text before the first ":") with counts. */
  warnings: Record<string, number>;
}

/** A crawled URL that redirected to another URL. */
export interface ExtractRedirect {
  from: string;
  to: string;
  fromUrl: string;
  toUrl: string;
}

const VIRTUAL_MEETING_HOSTS: [RegExp, string][] = [
  [/(^|\.)teams\.(microsoft|live)\.com$|^aka\.ms$/i, 'teams'],
  [/(^|\.)ringcentral\.com$/i, 'ringcentral'],
  [/(^|\.)zoom\.(us|com)$/i, 'zoom'],
  [/(^|\.)webex\.com$/i, 'webex'],
  [/(^|\.)(gotomeeting|gotomeet)\.(com|me)$/i, 'gotomeeting'],
  [/^meet\.google\.com$/i, 'google-meet'],
];

/**
 * Reads the job's snapshot and writes extract/pages.jsonl: one ExtractedPage per
 * crawled 200 HTML page, cleaned of site chrome by the job's platform profile.
 * URLs that redirected to another page are not pages of their own; they're
 * written to extract/redirects.jsonl instead.
 */
export async function extractJob(options: ExtractOptions): Promise<ExtractSummary> {
  const log = options.log ?? (() => {});
  const job = (...parts: string[]) => jobPath(options.jobId, ...parts);
  const info = await readJson<JobInfo>(job('job.json'));
  const snapshot = await readJsonl<SnapshotPage>(job('snapshot', 'pages.jsonl'));
  const files = await readJsonl<SnapshotFile>(job('snapshot', 'files.jsonl')).catch(() => [] as SnapshotFile[]);
  const site = getSiteProfile(info.profile);
  const profile = createExtractProfile(info.profile);
  const filesByUrl = new Map(files.map((f) => [f.url, f]));

  // Pages to extract, keyed by their final URL. A URL that redirected is only
  // extracted when its target wasn't crawled itself (and is on this site).
  const ok = snapshot.filter((p) => p.status === 200 && p.html);
  const crawled = new Set(ok.map((p) => sourceKey(p.url)));
  const refs = new Map<string, PageRef>();
  const redirects: ExtractRedirect[] = [];
  for (const page of ok) {
    const url = new URL(page.finalUrl || page.url);
    const key = sourceKey(url);
    if (key !== sourceKey(page.url)) {
      redirects.push({ from: sourceKey(page.url), to: key, fromUrl: page.url, toUrl: url.href });
      if (crawled.has(key) || !isSameSite(url, info.origin)) continue;
    }
    if (refs.has(key)) continue;
    refs.set(key, { url, key, snapshot: page, load: async () => cheerio.load(await readFile(job(page.html!), 'utf8')) });
  }
  const pages = [...refs.values()];

  const home = pages.find((p) => p.url.pathname === '/' && !p.url.search);
  const siteName = home ? cleanText((await home.load())('title').first().text()) : '';
  const ctx: ExtractContext = { origin: info.origin, site, siteName };
  await profile.prepare(pages, ctx);
  log(`Extracting ${pages.length} pages (${redirects.length} redirecting URLs set aside)…`);

  const extracted: ExtractedPage[] = [];
  for (const page of pages) {
    extracted.push(extractPage(page, await page.load(), profile, ctx, filesByUrl));
    if (extracted.length % 200 === 0) log(`  …${extracted.length}`);
  }

  await writeJsonl(job('extract', 'pages.jsonl'), extracted);
  await writeJsonl(job('extract', 'redirects.jsonl'), redirects);

  const count = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
  const news = extracted.filter((p) => p.kind === 'post');
  return {
    jobId: options.jobId,
    profile: profile.name,
    pages: extracted.length,
    byKind: count(extracted.map((p) => p.kind)),
    byReason: count(extracted.map((p) => p.kindReason)),
    redirects: redirects.length,
    news: { total: news.length, withDate: news.filter((p) => p.date).length, withCategory: news.filter((p) => p.categories.length).length },
    warnings: count(extracted.flatMap((p) => p.warnings.map((w) => w.split(':')[0]!))),
  };
}

function extractPage(page: PageRef, $page: CheerioAPI, profile: ExtractProfile, ctx: ExtractContext, filesByUrl: Map<string, SnapshotFile>): ExtractedPage {
  const parts = profile.read(page, $page, ctx);
  const { $, safeLinksUnwrapped, scriptsRemoved, phoneHrefs } = cleanContent(parts.contentHtml, { base: page.url.href, origin: ctx.origin, site: ctx.site });
  removeLeadingTitle($, parts.title);
  const warnings: string[] = [];

  // Links, documents (any file link, plus document extensions anywhere) and images.
  const links: ExtractedPage['links'] = [];
  const documents: ExtractedPage['documents'] = [];
  const virtualMeetings = new Set<string>();
  const missingFiles = new Set<string>();
  $('a[href], area[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const text = cleanText($(el).text()) || cleanText($(el).attr('title')) || cleanText($(el).find('img').attr('alt'));
    for (const [host, name] of VIRTUAL_MEETING_HOSTS) if (host.test(url.hostname)) virtualMeetings.add(name);
    const fileUrl = ctx.site.fileUrl(url, ctx.origin);
    if (fileUrl || DOC_EXT.test(url.pathname)) {
      documents.push({ href: url.href, text });
      const file = fileUrl ? filesByUrl.get(fileUrl) : undefined;
      if (fileUrl && file && !file.path) missingFiles.add(`${fileUrl} (${file.status})`);
    } else {
      links.push({ href: url.href, text });
    }
  });
  const images: ExtractedPage['images'] = [];
  const externalImageHosts = new Set<string>();
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src') ?? '';
    images.push({ src, alt: $(el).attr('alt') ?? '' });
    try {
      const url = new URL(src);
      if (!isSameSite(url, ctx.origin)) externalImageHosts.add(url.hostname);
      const fileUrl = ctx.site.fileUrl(url, ctx.origin);
      const file = fileUrl ? filesByUrl.get(fileUrl) : undefined;
      if (fileUrl && file && !file.path) missingFiles.add(`${fileUrl} (${file.status})`);
    } catch {
      // relative or malformed src that couldn't be resolved: left as is
    }
  });

  const text = $.root().text();
  const wordCount = countWords(text);
  const forms = $('form').not('[role=search], .search-form');
  const formBuilder = $('.fb-render, #rendered-content').length > 0;
  const formCount = forms.length || (formBuilder ? 1 : 0);
  const outside = cheerio.load($.html(), null, false);
  outside('form').remove();
  const wordsOutsideForms = countWords(outside.root().text());
  const iframes = $('iframe[src]').map((_, el) => $(el).attr('src') ?? '').get();
  const tables = $('table').length;

  const kind = classify(
    {
      url: page.url,
      title: parts.title,
      sectionTitle: parts.sectionTitle,
      wordCount,
      wordsOutsideForms,
      forms: formCount,
      media: images.length + iframes.length + $('video, audio, embed, object, svg').length + tables,
      documents: documents.length,
    },
    profile,
  );

  if (!parts.title) warnings.push('no-title');
  if (wordCount === 0 && !images.length && !iframes.length && !documents.length && !tables) warnings.push('empty-content: no text, images or documents');
  else if (wordCount < 20 && !images.length && !documents.length && (kind.kind === 'page' || kind.kind === 'post')) warnings.push(`thin-content: ${wordCount} words`);
  if (formCount) warnings.push(`form-embedded: ${formCount} form(s)${formBuilder ? ' (formBuilder, rendered by script)' : ''}`);
  const iframeHosts = new Map<string, number>();
  for (const src of iframes) iframeHosts.set(hostOf(src), (iframeHosts.get(hostOf(src)) ?? 0) + 1);
  for (const [host, n] of iframeHosts) warnings.push(`iframe: ${host}${n > 1 ? ` (${n})` : ''}`);
  for (const name of virtualMeetings) warnings.push(`virtual-meeting-link: ${name}`);
  for (const host of externalImageHosts) warnings.push(`external-image: ${host}`);
  if (safeLinksUnwrapped) warnings.push(`safe-links-unwrapped: ${safeLinksUnwrapped}`);
  for (const file of missingFiles) warnings.push(`missing-file: ${file}`);
  for (const href of phoneHrefs) warnings.push(`phone-number-link: ${href}`);
  if (scriptsRemoved) warnings.push(`scripts-removed: ${scriptsRemoved}`);
  const svgs = $('svg').length;
  if (svgs) warnings.push(`inline-svg: ${svgs} (drawn or interactive graphic, e.g. a map)`);
  warnings.push(...(profile.warnings?.($, ctx) ?? []));

  const parentKey = parts.parentUrl && isSameSite(new URL(parts.parentUrl), ctx.origin) ? sourceKey(parts.parentUrl) : null;
  return {
    sourceKey: page.key,
    url: page.url.href,
    kind: kind.kind,
    kindReason: kind.reason,
    title: parts.title,
    slug: slugOf(page.url),
    date: parts.date,
    categories: parts.categories,
    parentKey: parentKey && parentKey !== page.key ? parentKey : null,
    contentHtml: $.html().trim(),
    wordCount,
    links,
    images,
    documents,
    warnings,
  };
}

/**
 * The source slug: the last path segment, lowercased, kept as spelled (the
 * planner sanitizes it). None for query-string URLs (upages.php?id=N,
 * news-view?id=N), scripts, numeric ids and the root.
 */
export function slugOf(url: URL): string | null {
  if (url.search) return null;
  const segment = url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  if (!segment || /\.(php\d?|aspx?|jsp|cfm|cgi)$/i.test(segment) || /^\d+$/.test(segment)) return null;
  let slug = segment;
  try {
    slug = decodeURIComponent(segment);
  } catch {
    // keep the encoded form
  }
  return slug.replace(/\.html?$/i, '').toLowerCase() || null;
}

function hostOf(src: string): string {
  try {
    return new URL(src).hostname;
  } catch {
    return src.slice(0, 80);
  }
}
