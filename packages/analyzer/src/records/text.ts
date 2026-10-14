/** Text as shown: non-breaking spaces become spaces, whitespace runs collapse, ends trimmed. */
export function cleanText(text: string): string {
  return text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Heather Horovitz" → "heather-horovitz". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ISO = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g;
/** 9-3-20, 10_19-20, 2.20.19, 4/20/2021 (US order; separators - . / _), or "03 21 25" (single spaces). */
const NUMERIC = /(?<![\d.])(\d{1,2})[-./_](\d{1,2})[-./_](\d{4}|\d{2})(?!\d)|(?<![\d.])(\d{1,2}) (\d{1,2}) (\d{4}|\d{2})(?![\d.])/g;
/** June 15, 2020 · FRIDAY, MARCH 14, 2025 · Feb 21 2025 · June 16th, 2023 · May 11,2026 · February_2_2024. */
const NAMED =
  /(?<![a-z])(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[\s_]+(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:[\s_]*,[\s_]*|[\s_]+)(\d{4})(?!\d)/gi;

function iso(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null; // Feb 30 and similar
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Full calendar dates stated in a filename or link text, as YYYY-MM-DD, distinct, in order of
 * appearance. Only complete dates count: "Budget Comparison - Mar 2026", "250813" or "5 8 24"
 * state no date. Two-digit years are 20YY.
 */
export function findDates(text: string): string[] {
  const found: { at: number; date: string }[] = [];
  let rest = text;
  for (const m of text.matchAll(ISO)) {
    const date = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (date) found.push({ at: m.index, date });
    rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  for (const m of rest.matchAll(NUMERIC)) {
    const [month, day, y] = m[1] ? [m[1], m[2]!, m[3]!] : [m[4]!, m[5]!, m[6]!];
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const date = iso(year, Number(month), Number(day));
    if (date) found.push({ at: m.index, date });
  }
  for (const m of rest.matchAll(NAMED)) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    const date = iso(Number(m[3]), month, Number(m[2]));
    if (date) found.push({ at: m.index, date });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.date))];
}
