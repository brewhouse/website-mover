/**
 * Outbound HTTP for every URL a person can type into the tool (source sites, WordPress targets):
 * refuses loopback, private, link-local and other non-public addresses (PLAN §8, SSRF).
 *
 * The check runs when each connection is made, on the addresses DNS actually returned, so it also
 * covers redirects and DNS rebinding. `WM_ALLOW_PRIVATE_HOSTS` (comma-separated host names, e.g.
 * "localhost") lists hosts that may resolve to private addresses: the local Docker seed in
 * development, never in production.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch, type RequestInfo, type RequestInit, type Response } from 'undici';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for addresses the tool must not connect to (IPv4-mapped IPv6 is checked as IPv4). */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return blocked.check(mapped, 'ipv4');
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) return blocked.check(ip, 'ipv6');
  return true; // not an address
}

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.WM_ALLOW_PRIVATE_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export class BlockedAddressError extends Error {
  constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, a private or reserved address: the tool only connects to public sites (WM_ALLOW_PRIVATE_HOSTS lists exceptions)`);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that fails when any address for a host outside the allowlist is non-public. */
function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (!allowedHosts().has(hostname.toLowerCase())) {
      const bad = addresses.find((a) => isBlockedAddress(a.address));
      if (bad) return callback(Object.assign(new BlockedAddressError(hostname, bad.address), { code: 'EBLOCKED' }), []);
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []);
    callback(null, first.address, first.family);
  });
}

const connect = buildConnector({ lookup: guardedLookup as never });

/** The dispatcher behind safeFetch: every connection goes through the address check. */
export const guardedAgent = new Agent({
  connect: (opts, callback) => {
    // Literal IP hosts skip DNS, so they're checked here.
    const host = opts.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isBlockedAddress(host) && !allowedHosts().has(host.toLowerCase())) {
      callback(new BlockedAddressError(host, host), null);
      return;
    }
    connect(opts, callback);
  },
});

/** fetch() that refuses non-public addresses. Only http and https URLs are allowed. */
export function safeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.reject(new Error(`Only http and https URLs are fetched, not ${url.protocol}`));
  }
  return undiciFetch(url as unknown as RequestInfo, { ...init, dispatcher: guardedAgent });
}

/**
 * Whether the tool may connect to a host: on the allowlist, or every address it resolves to is public.
 * For clients that do their own networking (Chromium in the QA stage), checked per request.
 */
export async function isAllowedHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowedHosts().has(host)) return true;
  if (isIP(host)) return !isBlockedAddress(host);
  const addresses = await new Promise<LookupAddress[]>((resolve) => dnsLookup(host, { all: true }, (err, a) => resolve(err ? [] : a)));
  return addresses.length > 0 && !addresses.some((a) => isBlockedAddress(a.address));
}

/**
 * Fails fast (at intake) when a URL isn't one the tool may fetch: wrong scheme, credentials in the
 * URL, or a host that resolves to a non-public address.
 */
export async function assertPublicUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an http:// or https:// URL');
  if (url.username || url.password) throw new Error('Leave credentials out of the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (allowedHosts().has(host.toLowerCase())) return url;
  const addresses = isIP(host) ? [{ address: host }] : await new Promise<LookupAddress[]>((resolve, reject) => dnsLookup(host, { all: true }, (err, a) => (err ? reject(err) : resolve(a))));
  const bad = addresses.find((a) => isBlockedAddress(a.address));
  if (bad) throw new BlockedAddressError(host, bad.address);
  return url;
}
