import * as cheerio from 'cheerio';
import { sourceKey } from '@wm/core';
import type { Plan } from '@wm/planner';

/**
 * Maps source URLs to their new root-relative URLs: migrated pages and posts, uploaded files,
 * and every URL listed as a redirect source (aliases, duplicate uploads).
 */
export class LinkMap {
  private readonly byKey = new Map<string, string>();

  constructor(private readonly origin: string) {}

  set(sourceUrlOrKey: string, target: string): void {
    this.byKey.set(this.key(sourceUrlOrKey), target);
  }

  /** Register a plan entry: its own URL and its redirect sources. */
  add(entry: { sourceUrl: string; redirectFrom: string[] }, target: string): void {
    this.set(entry.sourceUrl, target);
    for (const from of entry.redirectFrom) this.set(new URL(from, this.origin).href, target);
  }

  resolve(url: string): string | undefined {
    try {
      return this.byKey.get(this.key(url));
    } catch {
      return undefined;
    }
  }

  private key(urlOrKey: string): string {
    return /^https?:\/\//.test(urlOrKey) ? sourceKey(urlOrKey) : urlOrKey;
  }

  /** Register every source path (path + query) that now lives at `target`. */
  addPaths(paths: string[], target: string): void {
    for (const from of paths) this.set(new URL(from, this.origin).href, target);
  }

  static forPlan(plan: Plan): LinkMap {
    const map = new LinkMap(plan.source.origin);
    // The target keeps its own front page.
    map.set(new URL('/', plan.source.origin).href, '/');
    for (const item of plan.items) map.add(item, item.targetPath);
    // Meetings, community entries, tables and listings: their source URLs are all redirect sources.
    for (const ev of plan.events) map.addPaths(ev.redirectFrom, ev.targetPath);
    for (const r of plan.records) map.add(r, r.targetPath);
    for (const t of plan.tables) map.addPaths(t.redirectFrom, t.targetPath);
    for (const ct of plan.contentTypes) map.addPaths(ct.listing.redirectFrom, ct.listing.targetPath);
    return map;
  }
}

/**
 * Rewrites links and image sources in content HTML. Same-site URLs that map to nothing
 * (content not migrated yet) are left as they are and returned in `unresolved`.
 */
export function rewriteLinks(html: string, links: LinkMap, sourceOrigin: string): { html: string; unresolved: string[] } {
  const $ = cheerio.load(html, null, false);
  const host = new URL(sourceOrigin).hostname.replace(/^www\./, '');
  const unresolved = new Set<string>();
  const rewrite = (el: cheerio.Cheerio<any>, attr: string) => {
    const value = el.attr(attr);
    if (!value || !/^https?:\/\//.test(value)) return;
    const target = links.resolve(value);
    if (target) {
      const hash = new URL(value).hash;
      el.attr(attr, target + (hash && !target.includes('#') ? hash : ''));
    } else if (new URL(value).hostname.replace(/^www\./, '') === host) {
      unresolved.add(value);
    }
  };
  $('a[href]').each((_, el) => rewrite($(el), 'href'));
  $('img[src]').each((_, el) => rewrite($(el), 'src'));
  return { html: $.html(), unresolved: [...unresolved] };
}
