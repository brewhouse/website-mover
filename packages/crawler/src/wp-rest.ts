import type { PoliteFetcher } from './polite-fetch.js';

export interface WpApiProbe {
  /** REST root (e.g. https://example.org/wp-json/), or null when none answered. */
  apiRoot: string | null;
  namespaces: string[];
  /** What we looked at and what came back, for the inventory report. */
  evidence: string[];
}

/**
 * Looks for a public WordPress REST API: the `<link rel="https://api.w.org/">`
 * tag, then `/wp-json/`, then the `?rest_route=/` form used without pretty permalinks.
 */
export async function probeWpApi(fetcher: PoliteFetcher, origin: string, homepageHtml: string): Promise<WpApiProbe> {
  const evidence: string[] = [];
  const candidates: string[] = [];

  const linkTag = homepageHtml.match(/<link[^>]+rel=["']https:\/\/api\.w\.org\/["'][^>]*>/i)?.[0];
  const linkHref = linkTag?.match(/href=["']([^"']+)["']/i)?.[1];
  evidence.push(linkHref ? `api.w.org link tag → ${linkHref}` : 'no <link rel="https://api.w.org/"> on homepage');
  if (linkHref) candidates.push(linkHref);
  candidates.push(`${origin}/wp-json/`, `${origin}/?rest_route=/`);

  for (const url of new Set(candidates)) {
    const res = await fetcher.get(url);
    const type = res.headers['content-type'] ?? '';
    const index = type.includes('json') ? tryParse(res.body) : undefined;
    const namespaces = Array.isArray(index?.namespaces) ? (index.namespaces as string[]) : [];
    evidence.push(`GET ${url} → ${res.status} ${type || '(no content-type)'}${namespaces.length ? `, ${namespaces.length} namespaces` : ''}`);
    if (res.status === 200 && namespaces.length) return { apiRoot: url, namespaces, evidence };
  }
  return { apiRoot: null, namespaces: [], evidence };
}

/** Builds a REST URL for either root style (`/wp-json/` or `?rest_route=/`). */
export function wpUrl(apiRoot: string, route: string, params: Record<string, string | number> = {}): string {
  const url = new URL(apiRoot);
  const cleanRoute = route.replace(/^\/+/, '');
  if (url.searchParams.has('rest_route')) url.searchParams.set('rest_route', `/${cleanRoute}`);
  else url.pathname = url.pathname.replace(/\/?$/, '/') + cleanRoute;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

/** Total item count for a collection, read from X-WP-Total with a 1-item page. */
export async function wpTotal(fetcher: PoliteFetcher, apiRoot: string, route: string): Promise<{ status: number; total: number | null }> {
  const res = await fetcher.get(wpUrl(apiRoot, route, { per_page: 1 }));
  const total = res.headers['x-wp-total'];
  return { status: res.status, total: total === undefined ? null : Number(total) };
}

/** Yields every item of a collection, 100 per page, following X-WP-TotalPages. */
export async function* wpPaginate<T>(
  fetcher: PoliteFetcher,
  apiRoot: string,
  route: string,
  params: Record<string, string | number> = {},
): AsyncGenerator<T> {
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const res = await fetcher.get(wpUrl(apiRoot, route, { ...params, per_page: 100, page }));
    if (res.status !== 200) throw new Error(`GET ${route} page ${page} → ${res.status}`);
    totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
    yield* JSON.parse(res.body) as T[];
  }
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
