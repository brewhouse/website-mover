import * as cheerio from 'cheerio';
import type { PoliteFetcher } from './polite-fetch.js';

export interface SitemapResult {
  url: string;
  status: number;
  kind: 'index' | 'urlset' | 'missing' | 'not-xml';
  /** Page URLs listed (urlset). */
  urls: string[];
  /** Child sitemaps listed (index). */
  children: string[];
  raw: string;
}

/** Reads sitemaps and follows sitemap indexes, returning one entry per sitemap file. */
export async function readSitemaps(fetcher: PoliteFetcher, roots: string[], maxDepth = 3): Promise<SitemapResult[]> {
  const results: SitemapResult[] = [];
  const seen = new Set<string>();

  async function visit(url: string, depth: number): Promise<void> {
    if (seen.has(url) || depth > maxDepth) return;
    seen.add(url);
    const res = await fetcher.get(url);
    const type = res.headers['content-type'] ?? '';
    const looksXml = type.includes('xml') || res.body.trimStart().startsWith('<?xml');
    if (res.status !== 200 || !looksXml) {
      results.push({ url, status: res.status, kind: res.status === 200 ? 'not-xml' : 'missing', urls: [], children: [], raw: '' });
      return;
    }
    const $ = cheerio.load(res.body, { xml: true });
    const children = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
    const urls = $('urlset > url > loc').map((_, el) => $(el).text().trim()).get();
    results.push({ url, status: res.status, kind: children.length ? 'index' : 'urlset', urls, children, raw: res.body });
    await Promise.all(children.map((child) => visit(child, depth + 1)));
  }

  for (const root of roots) await visit(root, 0);
  return results;
}
