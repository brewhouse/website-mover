/**
 * Date and time mentions in meeting titles and notice text, as written on the source:
 * "May 11th, 2026", "June 22rd, 2026" (sic), "Mar. 21st", "MONDAY, MAY 11, 2026", "Feb.28th",
 * "September 14,2021", month-only "May 2020", and (in link text and filenames only) numeric
 * dates such as "2026-04-20", "1-17-25" and "2/27/2023".
 */

export interface DateMention {
  year: number | null;
  month: number;
  /** null for a month-only mention ("May 2020"). */
  day: number | null;
  /** Weekday named with the date ("Monday, June 3, 2024"), lower case. */
  weekday: string | null;
  /** The mention spans several days ("August 7-12, 2020"). */
  range: boolean;
  index: number;
  end: number;
}

const MONTH = '(jan(?:uary)?|feb(?:r?uary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY = '(?:(mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s+)?';
const YEAR = '((?:19|20)\\d{2})(?!\\d)';
const DAY_DATE = new RegExp(
  `\\b${WEEKDAY}${MONTH}\\.?\\s*(\\d{1,2})(?:\\s*(?:st|nd|rd|th))?(?!\\d)` +
    `(?:\\s*(?:-|–|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d))?(?:\\s*,\\s*|\\s+)?(?:${YEAR})?`,
  'gi',
);
const MONTH_YEAR = new RegExp(`\\b${MONTH}\\.?,?\\s+${YEAR}`, 'gi');
const ISO_DATE = /(?<!\d)((?:19|20)\d{2})-(\d{1,2})-(\d{1,2})(?!\d)/g;
const US_NUMERIC = /(?<![\d-])(\d{1,2})[-/.](\d{1,2})[-/.]((?:19|20)?\d{2})(?!\d)/g;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function monthNumber(name: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function weekdayName(abbr: string | undefined): string | null {
  if (!abbr) return null;
  return WEEKDAYS.find((w) => w.startsWith(abbr.toLowerCase().slice(0, 3))) ?? null;
}

function validDay(year: number | null, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate(); // 2024: allow Feb 29 when the year is unknown
  return day <= days;
}

/**
 * Every date mentioned in `text`, in order. Numeric forms are only read when `numeric` is set
 * (link text, filenames, embed titles): in body text they collide with phone numbers.
 */
export function findDates(text: string, opts: { numeric?: boolean } = {}): DateMention[] {
  const out: DateMention[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s);
  const add = (m: DateMention) => {
    if (overlaps(m.index, m.end)) return;
    taken.push([m.index, m.end]);
    out.push(m);
  };
  for (const m of text.matchAll(DAY_DATE)) {
    const month = monthNumber(m[2]!);
    const day = Number(m[3]);
    const year = m[5] ? Number(m[5]) : null;
    if (!validDay(year, month, day)) continue;
    add({ year, month, day, weekday: weekdayName(m[1]), range: m[4] !== undefined, index: m.index, end: m.index + m[0].trimEnd().length });
  }
  if (opts.numeric) {
    for (const m of text.matchAll(ISO_DATE)) {
      const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (validDay(year, month, day)) add({ year, month, day, weekday: null, range: false, index: m.index, end: m.index + m[0].length });
    }
    for (const m of text.matchAll(US_NUMERIC)) {
      const [month, day] = [Number(m[1]), Number(m[2])];
      const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      if (validDay(year, month, day)) add({ year, month, day, weekday: null, range: false, index: m.index, end: m.index + m[0].length });
    }
  }
  for (const m of text.matchAll(MONTH_YEAR)) {
    add({ year: Number(m[2]), month: monthNumber(m[1]!), day: null, weekday: null, range: false, index: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;
}

/** Same calendar day; a mention without a year matches any year. */
export function sameDay(m: DateMention, iso: string): boolean {
  if (m.day === null) return false;
  const [y, mo, d] = iso.split('-').map(Number);
  return m.month === mo && m.day === d && (m.year === null || m.year === y);
}

/**
 * Year for a month/day written without one: the year that puts it closest to one of the `hints`
 * (other full dates on the same page, or a news item's listing date), within 120 days.
 */
export function yearFromHints(month: number, day: number, hints: string[]): number | null {
  let best: { year: number; distance: number } | null = null;
  for (const hint of hints) {
    const h = Date.parse(`${hint}T00:00:00Z`);
    const hy = new Date(h).getUTCFullYear();
    for (const year of [hy - 1, hy, hy + 1]) {
      if (!validDay(year, month, day)) continue;
      const distance = Math.abs(Date.UTC(year, month - 1, day) - h) / 86_400_000;
      if (distance <= 120 && (!best || distance < best.distance)) best = { year, distance };
    }
  }
  return best?.year ?? null;
}

// ---------------------------------------------------------------- times

const TIME_SRC = '(?:(\\d{1,2})(?::\\s?(\\d{2}))?\\s*(a\\.?\\s?m\\b\\.?|p\\.?\\s?m\\b\\.?|noon\\b)|\\b(noon)\\b)';
const TIME = new RegExp(TIME_SRC, 'gi');
const TIME_AT_START = new RegExp(`^${TIME_SRC}`, 'i');
const RANGE_JOIN = /^\s*(?:-|–|—|to|until|till)\s*/i;
/** What may stand between a date and its time: "at", "beginning at", ", ", "Time:". */
const DATE_TIME_GAP = /^[\s,.:;()-]*(?:(?:at|beginning|starting|commencing|from|time)\b[\s,.:;()-]*)*$/i;
const TIME_BEFORE_DATE = new RegExp(`${TIME_SRC}\\s*,?\\s*(?:on\\s+)?$`, 'i');
/** "3:00-5:00 P.M.": one meridiem for both ends. */
const SHARED_MERIDIEM_RANGE = /^([\s\S]*?)\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\b\.?|p\.?\s?m\b\.?)/i;

function to24h(m: RegExpMatchArray): string | null {
  if (m[4]) return '12:00';
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = m[3]!.toLowerCase();
  if (suffix.startsWith('noon')) return hour === 12 && minute === 0 ? '12:00' : null;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (suffix.startsWith('p') && hour !== 12) hour += 12;
  if (suffix.startsWith('a') && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Start and end of "3:00-5:00 P.M." / "11:00-2:00 p.m.": the start takes the end's meridiem unless that would put it after the end. */
function sharedRange(m: RegExpMatchArray): { start: string; end: string } | null {
  const [sh, sm, eh, em] = [Number(m[2]), Number(m[3] ?? 0), Number(m[4]), Number(m[5] ?? 0)];
  if (sh < 1 || sh > 12 || eh < 1 || eh > 12 || sm > 59 || em > 59) return null;
  const pm = m[6]!.toLowerCase().startsWith('p');
  const end = pm ? (eh === 12 ? 12 : eh + 12) : eh === 12 ? 0 : eh;
  let start = pm ? (sh === 12 ? 12 : sh + 12) : sh === 12 ? 0 : sh;
  if (start * 60 + sm > end * 60 + em) start -= 12;
  if (start < 0) return null;
  return { start: hhmm(start, sm), end: hhmm(end, em) };
}

export interface TimeFound {
  start: string;
  end: string | null;
  /** Verbatim text the times were read from. */
  text: string;
}

/** The time written right after (or just before) a mention of the meeting's date. */
export function timeNearDate(text: string, dates: DateMention[], iso: string): TimeFound | null {
  for (const d of dates.filter((m) => sameDay(m, iso))) {
    const after = text.slice(d.end, d.end + 80);
    const range = after.match(SHARED_MERIDIEM_RANGE);
    if (range && DATE_TIME_GAP.test(range[1]!)) {
      const r = sharedRange(range);
      if (r) return { ...r, text: range[0].slice(range[1]!.length).trim() };
    }
    for (const t of after.matchAll(TIME)) {
      if (!DATE_TIME_GAP.test(after.slice(0, t.index))) break;
      const start = to24h(t);
      if (!start) break;
      const rest = after.slice(t.index + t[0].length);
      const join = rest.match(RANGE_JOIN);
      const endMatch = join ? rest.slice(join[0].length).match(TIME_AT_START) : null;
      const end = endMatch ? to24h(endMatch) : null;
      const span = after.slice(t.index, t.index + t[0].length + (end && join && endMatch ? join[0].length + endMatch[0].length : 0));
      return { start, end, text: span.trim() };
    }
    const before = text.slice(Math.max(0, d.index - 30), d.index).match(TIME_BEFORE_DATE);
    if (before) {
      const start = to24h(before);
      if (start) return { start, end: null, text: before[0].trim() };
    }
  }
  return null;
}
