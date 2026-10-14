/** Query parameters that never identify content. */
const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|_ga)$/i;

/**
 * Stable identity of a source URL, used as `_wm_source_key` on everything the
 * tool creates and as the key in plans and redirect maps.
 *
 * host without "www." + lowercased path without trailing slash + remaining query
 * parameters, sorted. Lowercasing the path matches servers that ignore case
 * (jaxha.org does); fragments are dropped.
 *
 *   https://www.jaxha.org/HCV-Landlords/   → jaxha.org/hcv-landlords
 *   https://www.jaxha.org/upages.php?id=433 → jaxha.org/upages.php?id=433
 */
export function sourceKey(input: string | URL): string {
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${pathname === '/' && !query ? '' : pathname}${query}`;
}
