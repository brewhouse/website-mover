/** Collapses whitespace (including &nbsp;) and trims. */
export const cleanText = (text: string | undefined | null) => (text ?? '').replace(/\s+/g, ' ').trim();

/** Words with at least one letter or digit. */
export const countWords = (text: string) => cleanText(text).split(' ').filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

/** "11/15/2025" → "2025-11-15"; null when it isn't a real US-style date. */
export function usDateToIso(text: string): string | null {
  const m = cleanText(text).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [month, day, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Removes a trailing " - Site Name" / " | Site Name" from a <title>. */
export function stripSiteName(title: string, siteName: string): string {
  const text = cleanText(title);
  if (!siteName || text === siteName) return text;
  const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\s*[-|–—:]\\s*${escaped}$`, 'i'), '').trim() || text;
}
