/** URL helpers shared by the scan and the extractor. */

/** Document file extensions (links to these are documents, wherever they're hosted). */
export const DOC_EXT = /\.(pdf|docx?|dotx?|xlsx?|xlsm|csv|pptx?|rtf|odt|ods|odp|txt)$/i;
export const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|tiff?)$/i;

/**
 * Resolves an href/src against a base. Returns undefined for in-page anchors,
 * non-web schemes (mailto:, tel:, javascript:, data:) and unparseable values.
 * The fragment is dropped.
 */
export function resolveUrl(href: string | undefined | null, base: string | URL): URL | undefined {
  const trimmed = href?.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(mailto|tel|javascript|data|sms|callto):/i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed, base);
    url.hash = '';
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** Same site as the origin, ignoring scheme and a leading "www." (as sourceKey does). */
export function isSameSite(url: URL, origin: string | URL): boolean {
  return bareHost(url.hostname) === bareHost(new URL(origin).hostname);
}

/** Rewrites a same-site URL onto the origin's scheme and host (http://jaxha.org/x → https://www.jaxha.org/x). */
export function onOrigin(url: URL, origin: string | URL): URL {
  const base = new URL(origin);
  const out = new URL(url.href);
  out.protocol = base.protocol;
  out.host = base.host;
  return out;
}

const SAFE_LINKS_HOST = /(^|\.)safelinks\.protection\.outlook\.com$/i;

/**
 * Microsoft Outlook "Safe Links" wrap the real URL in `?url=…`; the other
 * parameters (`data=`, `sdata=`) carry the recipient's mailbox and tenant ids.
 * Returns the wrapped URL, or undefined when `url` isn't a Safe Link.
 */
export function unwrapSafeLink(url: URL): URL | undefined {
  if (!SAFE_LINKS_HOST.test(url.hostname)) return undefined;
  const inner = url.searchParams.get('url');
  if (!inner) return undefined;
  try {
    const target = new URL(inner);
    return target.protocol === 'http:' || target.protocol === 'https:' ? target : undefined;
  } catch {
    return undefined;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  dot: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  csv: 'text/csv',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
};

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tif',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
};

/** Lowercased extension of a filename or path ("Plan.PDF" → "pdf"), or undefined. */
export function extensionOf(name: string | null | undefined): string | undefined {
  return name?.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
}

export const mimeForExtension = (ext: string | undefined) => (ext ? MIME_BY_EXT[ext] : undefined);
export const extensionForMime = (mime: string) => EXT_BY_MIME[mime.split(';')[0]!.trim().toLowerCase()];

/** Filename from a Content-Disposition header (RFC 5987 `filename*` first). */
export function dispositionFilename(header: string | undefined): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|ISO-8859-1)?'[^']*'([^;]+)/i)?.[1]?.trim();
  if (star) {
    try {
      return decodeURIComponent(star);
    } catch {
      return star;
    }
  }
  // Quoted-string with quoted-pairs (BJM sends PHP-escaped names: "Commissioners\' Availability.pdf").
  const quoted = header.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i)?.[1];
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, '$1').trim() || null;
  return header.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() || null;
}
