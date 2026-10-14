/**
 * Where to go after logging in: a path on this site only. Anything else (other sites, protocol-relative
 * "//x", "/\x", which browsers read as "//x", or control characters) goes to the jobs list.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\s\x00-\x1f]/.test(next)) return '/';
  return next;
}

/** Whether the request reached the app over https (directly or through a proxy that says so). */
export function isHttps(headers: { get(name: string): string | null }): boolean {
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwarded) return forwarded === 'https';
  return headers.get('origin')?.startsWith('https:') ?? false;
}
