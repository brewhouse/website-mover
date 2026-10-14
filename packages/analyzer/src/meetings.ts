import { existsSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { jobPath, readJsonl, writeJson } from '@wm/core';
import type { DocumentRole, ExtractedPage, MeetingAnalysis, MeetingRecord, SnapshotFile } from '@wm/core';
import { findDates, isoDate, sameDay, timeNearDate, weekdayOf, yearFromHints, type DateMention, type TimeFound } from './meetings/dates.js';
import {
  cancelledIn,
  documentRole,
  findLocation,
  htmlToText,
  collapse,
  noticeBlock,
  noticeHeading,
  pageArtefact,
  recordingUrl,
  rescheduledIn,
  type Artefact,
} from './meetings/details.js';
import { BOARD_MEETINGS, coveredBy, detectKind, kindSlug, REGULAR_BOARD, type MeetingKind } from './meetings/kinds.js';

/**
 * Groups the extracted meeting pages into meetings (one per date + kind) and writes
 * analyze/meetings.json. Deterministic rules only: every derived value names the rule that
 * produced it in `reasons`, and anything the rules can't place is listed in `unresolved`.
 */
export async function analyzeMeetings(jobId: string, log: (msg: string) => void = () => {}): Promise<MeetingAnalysis> {
  const pages = await readJsonl<ExtractedPage>(jobPath(jobId, 'extract', 'pages.jsonl'));
  const filesPath = jobPath(jobId, 'snapshot', 'files.jsonl');
  const files = existsSync(filesPath) ? await readJsonl<SnapshotFile>(filesPath) : [];
  const filenames = new Map(files.map((f) => [f.url, f.filename]));

  const analysis = buildAnalysis(pages, filenames, log);
  await writeJson(jobPath(jobId, 'analyze', 'meetings.json'), analysis);
  log(`meetings: ${analysis.meetings.length} meetings, ${analysis.indexPages.length} index pages, ${analysis.unresolved.length} unresolved`);
  return analysis;
}

// ---------------------------------------------------------------- per page

interface DateResult {
  date: string;
  reasons: string[];
  low: boolean;
}

const WEEKEND = new Set(['saturday', 'sunday']);

/** Meeting date from the title first, then the text; `hints` are dates that settle a missing year. */
function resolveDate(title: string, text: string, hints: string[] = []): DateResult | { unresolved: string } {
  const titleDates = findDates(title, { numeric: true });
  const textDates = findDates(text);
  const textDays = textDates.filter((d) => d.day !== null && !d.range);
  const textFull = textDays.filter((d) => d.year !== null);
  const yearHints = [...textFull.map((d) => isoDate(d.year!, d.month, d.day!)), ...hints];
  const reasons: string[] = [];
  let low = false;

  const titleDay = titleDates.find((d) => d.day !== null);
  if (titleDay?.range) return { unresolved: 'title gives a date range (several meetings)' };
  if (titleDay) {
    let year = titleDay.year;
    if (year !== null) reasons.push('date-title');
    else {
      year = textFull.find((d) => d.month === titleDay.month && d.day === titleDay.day)?.year ?? null;
      if (year !== null) reasons.push('date-title+year-text');
      else {
        year = yearFromHints(titleDay.month, titleDay.day!, yearHints);
        if (year === null) return { unresolved: 'title date has no year and nothing on the page gives one' };
        reasons.push('date-title+year-inferred');
        low = true;
      }
    }
    const date = isoDate(year, titleDay.month, titleDay.day!);
    if (textDays.length && !textDays.some((d) => sameDay(d, date))) {
      low = true;
      // The weekday settles it: the text names a weekday its date really falls on, and the title's
      // date is off (its own weekday is wrong, or it falls on a weekend while the text's is a weekday).
      const checked = textFull.find((d) => d.weekday && d.weekday === weekdayOf(isoDate(d.year!, d.month, d.day!)));
      const titleWeekday = weekdayOf(date);
      if (checked) {
        const textDate = isoDate(checked.year!, checked.month, checked.day!);
        const titleOff = titleDay.weekday ? titleDay.weekday !== titleWeekday : WEEKEND.has(titleWeekday) && !WEEKEND.has(checked.weekday!);
        if (titleOff) {
          reasons.splice(0, reasons.length, `date-conflict: title ${date} (${titleDay.weekday ? `says ${titleDay.weekday}, is a ` : ''}${titleWeekday}) vs text ${textDate} (says ${checked.weekday}, which matches); text date used`);
          return { date: textDate, reasons, low };
        }
      }
      const other = textFull[0] ?? textDays[0]!;
      const otherIso = other.year !== null ? isoDate(other.year, other.month, other.day!) : `${other.month}/${other.day}`;
      const wd = other.weekday ? `, text says ${other.weekday}` : '';
      reasons.push(`date-conflict: title ${date} (${titleWeekday}) vs text ${otherIso}${wd}; title kept`);
    }
    return { date, reasons, low };
  }

  const titleMonth = titleDates.find((d) => d.day === null);
  const candidates = titleMonth ? textDays.filter((d) => d.month === titleMonth.month && (d.year === null || d.year === titleMonth.year)) : textDays;
  const first = candidates[0];
  if (!first) {
    if (textDates.some((d) => d.range)) return { unresolved: 'text gives a date range (several meetings)' };
    return { unresolved: titleMonth ? 'title gives only a month and the text names no day in it' : 'no date in the title or the text' };
  }
  let year = first.year ?? titleMonth?.year ?? null;
  reasons.push(titleMonth ? 'date-text (title gives the month only)' : 'date-text');
  if (year === null) {
    year = yearFromHints(first.month, first.day!, yearHints);
    if (year === null) return { unresolved: 'the text gives a date without a year' };
    reasons.push('year-inferred');
    low = true;
  }
  const date = isoDate(year, first.month, first.day!);
  if (first.weekday && first.weekday !== weekdayOf(date)) {
    reasons.push(`weekday-mismatch: text says ${first.weekday}, ${date} is a ${weekdayOf(date)}`);
    low = true;
  }
  return { date, reasons, low };
}

interface PageInfo {
  page: ExtractedPage;
  text: string;
  heading: string;
  artefact: Artefact;
  date: string;
  dateReasons: string[];
  time: TimeFound | null;
  kind: MeetingKind | null;
  kindReason: string;
  low: boolean;
  cancelled: boolean;
  rescheduled: boolean;
}

/**
 * Kind from the page title; else from the notice's own heading lines; else from the opening of
 * "Notice is hereby given …". A notice heading that contradicts the title is flagged, and a
 * generic title ("Board Meeting Public Notice") gives way to a heading that names a special,
 * emergency or shade board meeting.
 */
function kindOf(title: string, text: string, artefact: Artefact): { kind: MeetingKind | null; reason: string; low: boolean } {
  const fromTitle = detectKind(title);
  const fromBlock = detectKind(noticeBlock(text));
  if (fromTitle) {
    if (artefact !== 'notice' || !fromBlock || fromBlock === fromTitle || fromBlock === REGULAR_BOARD) {
      return { kind: fromTitle, reason: `kind-title:${fromTitle.rule}`, low: false };
    }
    if (fromTitle === REGULAR_BOARD && fromBlock.category === BOARD_MEETINGS) {
      return { kind: fromBlock, reason: `kind-notice-heading:${fromBlock.rule} (title is generic)`, low: false };
    }
    return { kind: fromTitle, reason: `kind-title:${fromTitle.rule} (notice heading says ${fromBlock.rule})`, low: true };
  }
  if (fromBlock) return { kind: fromBlock, reason: `kind-notice-heading:${fromBlock.rule}`, low: false };
  const fromNotice = detectKind(noticeHeading(text));
  if (fromNotice) return { kind: fromNotice, reason: `kind-notice-text:${fromNotice.rule}`, low: false };
  return { kind: null, reason: 'kind-unknown', low: true };
}

/** Landing/index pages: no day in the title and a plural "… Meetings" / "Meeting Minutes" title, or parent of other meeting pages. */
function isIndexPage(page: ExtractedPage, parents: Set<string>): boolean {
  if (findDates(page.title, { numeric: true }).some((d) => d.day !== null)) return false;
  return /\bmeetings\b/i.test(page.title) || /^(?:approved\s+)?meeting\s+minutes$/i.test(page.title.trim()) || parents.has(page.sourceKey);
}

// ---------------------------------------------------------------- grouping

interface Group {
  key: string;
  date: string;
  kind: MeetingKind;
  pages: PageInfo[];
  reasons: string[];
  low: boolean;
  documents: MeetingRecord['documents'];
  recordings: string[];
  newsKeys: string[];
  /** "<index page> (<rule>)" → documents taken from it. */
  indexDocuments: Map<string, number>;
}

const ARTEFACT_ORDER: Artefact[] = ['notice', 'agenda', 'minutes', 'comment', 'other'];

function primaryFirst(pages: PageInfo[]): PageInfo[] {
  const noticeScore = (p: PageInfo) => (p.artefact === 'notice' ? 0 : 1);
  return [...pages].sort(
    (a, b) =>
      noticeScore(a) - noticeScore(b) ||
      b.page.wordCount - a.page.wordCount ||
      ARTEFACT_ORDER.indexOf(a.artefact) - ARTEFACT_ORDER.indexOf(b.artefact) ||
      a.page.sourceKey.localeCompare(b.page.sourceKey),
  );
}

/**
 * The one meeting a date (or month) and kind point to: same kind on that date; or, for an
 * unnamed or generic board meeting, the only meeting (or only board meeting) that day.
 */
function placeOn(groups: Group[], when: { date?: string; month?: string }, kind: MeetingKind | null): { group: Group; rule: string } | null {
  const sameWhen = groups.filter((g) => (when.date ? g.date === when.date : g.date.startsWith(when.month!)));
  if (kind) {
    const exact = sameWhen.filter((g) => g.kind === kind);
    if (exact.length === 1) return { group: exact[0]!, rule: when.date ? 'date+kind' : 'month+kind' };
    const joint = sameWhen.filter((g) => coveredBy(kind, g.kind));
    if (!exact.length && joint.length === 1 && when.date) return { group: joint[0]!, rule: 'date+joint committee' };
    if (exact.length > 1 || !when.date) return null;
  }
  if (!when.date) return null;
  if (kind && kind !== REGULAR_BOARD) return null;
  if (sameWhen.length === 1) return { group: sameWhen[0]!, rule: 'only meeting that day' };
  const board = sameWhen.filter((g) => g.kind.category === BOARD_MEETINGS && g.kind.rule !== 'bpaal');
  if (kind === REGULAR_BOARD && board.length === 1) return { group: board[0]!, rule: 'only board meeting that day' };
  return null;
}

// ---------------------------------------------------------------- index-page links

interface IndexLink {
  href: string;
  kind: 'document' | 'recording';
  text: string;
  date?: string;
  month?: string;
  meetingKind: MeetingKind | null;
}

/**
 * Date (or month) and kind for a link on an index page: from its own label (text, title, image alt)
 * when that names them, else from its list item, else from the heading above ("February 2023").
 */
function linkContext(own: string, block: string, heading: string): Pick<IndexLink, 'date' | 'month' | 'meetingKind'> {
  const ownDates = findDates(own, { numeric: true });
  const useOwn = ownDates.length > 0;
  const sources = useOwn ? [own, block, heading] : [block, heading];
  const mentions: DateMention[] = sources.flatMap((s) => findDates(s, { numeric: true }));
  // A day written without a year ("August 23 Board Meeting") takes it from the list item or the heading above ("2021").
  const headingYear = heading.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const yearOf = (month: number) => mentions.find((m) => m.year !== null && m.month === month)?.year ?? (headingYear ? Number(headingYear) : null);
  const meetingKind = detectKind(own) ?? detectKind(block);
  const day = mentions.find((m) => m.day !== null && !m.range);
  if (day) {
    const year = day.year ?? yearOf(day.month);
    if (year) return { date: isoDate(year, day.month, day.day!), meetingKind };
  }
  const month = mentions.find((m) => m.day === null && m.year !== null);
  if (month) return { month: `${month.year}-${String(month.month).padStart(2, '0')}`, meetingKind };
  return { meetingKind };
}

function indexLinks(page: ExtractedPage): IndexLink[] {
  const docHrefs = new Set(page.documents.map((d) => d.href));
  const $ = cheerio.load(page.contentHtml, null, false);
  const out: IndexLink[] = [];
  $('a[href], iframe[src]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? $el.attr('src') ?? '';
    const recording = recordingUrl(href);
    const isDoc = docHrefs.has(href);
    if (!recording && !isDoc) return;
    const text = collapse($el.text());
    const own = [text, $el.attr('title') ?? '', $el.find('img').attr('alt') ?? ''].filter(Boolean).join(' | ');
    const $block = $el.closest('li,p,td,tr,div');
    const block = collapse($block.length ? $block.text() : '');
    const $top = $el.parents().length ? $el.parents().last() : $el;
    const heading = collapse($top.prevAll().filter((_, s) => collapse($(s).text()) !== '').first().text());
    out.push({ href: recording ?? href, kind: recording ? 'recording' : 'document', text, ...linkContext(own, block, heading) });
  });
  return out;
}

// ---------------------------------------------------------------- analysis

const NEWS_CATEGORIES = /board of commissioners|jh union|public notice/i;

function buildAnalysis(pages: ExtractedPage[], filenames: Map<string, string | null>, log: (msg: string) => void): MeetingAnalysis {
  const meetingPages = pages.filter((p) => p.kind === 'meeting');
  const parents = new Set(meetingPages.map((p) => p.parentKey).filter((k): k is string => !!k));
  const indexPages: ExtractedPage[] = [];
  const unresolved: MeetingAnalysis['unresolved'] = [];
  const infos: PageInfo[] = [];

  for (const page of meetingPages) {
    if (isIndexPage(page, parents)) {
      indexPages.push(page);
      continue;
    }
    const text = htmlToText(page.contentHtml);
    const heading = noticeHeading(text);
    const dated = resolveDate(page.title, text);
    if ('unresolved' in dated) {
      unresolved.push({ sourceKey: page.sourceKey, title: page.title, reason: dated.unresolved });
      continue;
    }
    const artefact = pageArtefact(page.title, heading);
    const kind = kindOf(page.title, text, artefact);
    infos.push({
      page,
      text,
      heading,
      artefact,
      date: dated.date,
      dateReasons: dated.reasons,
      time: timeNearDate(text, findDates(text), dated.date) ?? timeNearDate(page.title, findDates(page.title, { numeric: true }), dated.date),
      kind: kind.kind,
      kindReason: kind.reason,
      low: dated.low || kind.low,
      cancelled: cancelledIn(page.title) || cancelledIn(heading),
      rescheduled: rescheduledIn(page.title) || rescheduledIn(heading),
    });
  }

  // Group pages that name their kind by date + kind. Notices for the same day and kind that state
  // different start times are different meetings (e.g. a committee at 10:00 and the board at 14:30).
  const byDateKind = new Map<string, PageInfo[]>();
  for (const info of infos.filter((i) => i.kind)) {
    const base = `meeting:${info.date}:${kindSlug(info.kind!)}`;
    byDateKind.set(base, [...(byDateKind.get(base) ?? []), info]);
  }
  const groups: Group[] = [];
  const newGroup = (key: string, list: PageInfo[], reasons: string[] = []): Group => ({
    key, date: list[0]!.date, kind: list[0]!.kind!, pages: list, reasons, low: false, documents: [], recordings: [], newsKeys: [], indexDocuments: new Map(),
  });
  for (const [base, list] of byDateKind) {
    const starts = [...new Set(list.map((i) => i.time?.start).filter((t): t is string => !!t))].sort();
    if (starts.length <= 1) {
      groups.push(newGroup(base, list));
      continue;
    }
    for (const start of starts) {
      groups.push(newGroup(`${base}-${start.replace(':', '')}`, list.filter((i) => i.time?.start === start), [`split from other ${list[0]!.kind!.name} pages that day by start time (${starts.join(', ')})`]));
    }
    for (const info of list.filter((i) => !i.time)) {
      unresolved.push({ sourceKey: info.page.sourceKey, title: info.page.title, reason: `${starts.length} meetings of this kind that day (at ${starts.join(', ')}) and the page states no time` });
    }
  }

  // Pages that don't name a kind (minutes, public comments) join the meeting held that day.
  for (const info of infos.filter((i) => !i.kind)) {
    const placed = placeOn(groups, { date: info.date }, null);
    if (!placed) {
      const n = groups.filter((g) => g.date === info.date).length;
      unresolved.push({ sourceKey: info.page.sourceKey, title: info.page.title, reason: n ? `no meeting kind found and ${n} meetings that day` : 'no meeting kind found and no other meeting that day' });
      continue;
    }
    info.kindReason = `kind-from-group (${placed.rule})`;
    info.low = info.dateReasons.some((r) => /conflict|inferred|mismatch/.test(r));
    placed.group.pages.push(info);
  }

  // Per meeting: primary page, reasons, documents and recordings from its own pages.
  for (const g of groups) {
    g.pages = primaryFirst(g.pages);
    const primary = g.pages[0]!;
    g.low = g.pages.some((p) => p.low);
    for (const p of g.pages) {
      const why = [...p.dateReasons, p.kindReason].join(', ');
      g.reasons.push(g.pages.length > 1 ? `${p.page.sourceKey}: ${why}` : why);
    }
    if (g.pages.length > 1) g.reasons.push(`grouped ${g.pages.length} pages by date+kind; primary = ${primary.artefact === 'notice' ? 'notice' : 'longest page'}`);
    for (const p of g.pages) {
      for (const d of p.page.documents) {
        if (g.documents.some((x) => x.href === d.href)) continue;
        g.documents.push({ href: d.href, text: d.text, role: documentRole(d.text, filenames.get(d.href) ?? null, { printableOf: p.artefact }) });
      }
      for (const href of [...p.page.links.map((l) => l.href), ...[...p.page.contentHtml.matchAll(/<iframe[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]!)]) {
        const rec = recordingUrl(href);
        if (rec && !g.recordings.includes(rec)) g.recordings.push(rec);
      }
    }
  }

  // Documents and recordings listed on index pages ("Meeting Minutes", the BOC meetings list).
  let placedLinks = 0;
  const unplacedLinks: string[] = [];
  for (const index of indexPages) {
    const listOf: DocumentRole | undefined = /minutes/i.test(index.title) ? 'minutes' : undefined;
    for (const link of indexLinks(index)) {
      const when = link.date ? { date: link.date } : link.month ? { month: link.month } : null;
      const placed = when ? placeOn(groups, when, link.meetingKind) : null;
      if (!placed) {
        unplacedLinks.push(`${index.sourceKey}: ${link.kind} "${link.text || link.href}" (${link.date ?? link.month ?? 'no date'}, ${link.meetingKind?.rule ?? 'no kind'})`);
        continue;
      }
      const g = placed.group;
      if (link.kind === 'recording') {
        if (!g.recordings.includes(link.href)) {
          g.recordings.push(link.href);
          g.reasons.push(`recording from ${index.sourceKey} (${placed.rule})`);
        }
      } else if (!g.documents.some((d) => d.href === link.href)) {
        const text = index.documents.find((d) => d.href === link.href)?.text ?? link.text;
        g.documents.push({ href: link.href, text, role: documentRole(text, filenames.get(link.href) ?? null, { listOf }) });
        const from = `${index.sourceKey} (${placed.rule})`;
        g.indexDocuments.set(from, (g.indexDocuments.get(from) ?? 0) + 1);
      }
      placedLinks++;
    }
  }

  // News items announcing a meeting stay news posts; the meeting links to them.
  let newsMatched = 0;
  for (const post of pages.filter((p) => p.kind === 'post')) {
    if (/\bschedule\b/i.test(post.title)) continue;
    const text = htmlToText(post.contentHtml);
    const heading = noticeHeading(text);
    const titleKind = detectKind(post.title);
    const kind = titleKind ?? (post.categories.some((c) => NEWS_CATEGORIES.test(c)) ? detectKind(heading) : null);
    if (!kind) continue;
    const dated = resolveDate(post.title, text, post.date ? [post.date] : []);
    if ('unresolved' in dated) continue;
    const placed = placeOn(groups, { date: dated.date }, kind);
    if (!placed) continue;
    placed.group.newsKeys.push(post.sourceKey);
    placed.group.reasons.push(`news ${post.sourceKey} (${placed.rule})`);
    newsMatched++;
  }

  const meetings: MeetingRecord[] = groups
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
    .map((g) => {
      // Time and place from the primary page, else the next page that states them.
      const primary = g.pages[0]!;
      const timed = g.pages.find((p) => p.time);
      const time = timed?.time ?? null;
      const timeRule = timed ? `time: "${timed.time!.text}"${timed === primary ? '' : ` (from ${timed.page.sourceKey})`}` : 'time: none stated';
      let location: ReturnType<typeof findLocation> = null;
      for (const p of g.pages) {
        location = findLocation(p.text);
        if (location) break;
      }
      const cancelled = g.pages.some((p) => p.cancelled);
      const reasons = [...g.reasons, timeRule, location ? location.rule : 'location: none stated'];
      if (g.indexDocuments.size) reasons.push(`documents from index pages: ${[...g.indexDocuments].map(([from, n]) => `${n} from ${from}`).join(', ')}`);
      if (cancelled) reasons.push(`cancelled: ${g.pages.filter((p) => p.cancelled).map((p) => p.page.sourceKey).join(', ')}`);
      if (g.pages.some((p) => p.rescheduled)) reasons.push('rescheduled (see notice)');
      return {
        key: g.key,
        title: primary.page.title,
        date: g.date,
        startTime: time?.start ?? null,
        endTime: time?.end ?? null,
        kind: g.kind.name,
        type: g.kind.type,
        category: g.kind.category,
        location: location?.value ?? null,
        cancelled,
        sourceKeys: g.pages.map((p) => p.page.sourceKey),
        newsKeys: [...new Set(g.newsKeys)],
        documents: g.documents,
        recordings: g.recordings,
        confidence: g.low ? 'low' : 'high',
        reasons,
      } satisfies MeetingRecord;
    });

  // Every meeting page lands in exactly one place.
  const placedKeys = [...meetings.flatMap((m) => m.sourceKeys), ...indexPages.map((p) => p.sourceKey), ...unresolved.map((u) => u.sourceKey)];
  if (placedKeys.length !== meetingPages.length || new Set(placedKeys).size !== meetingPages.length) {
    throw new Error(`meetings: ${meetingPages.length} meeting pages but ${placedKeys.length} placed (${new Set(placedKeys).size} distinct)`);
  }

  log(`meetings: ${placedLinks} index-page links placed on meetings, ${unplacedLinks.length} left on their index pages; ${newsMatched} news items matched`);
  for (const u of unplacedLinks) log(`  unplaced: ${u}`);
  return { meetings, indexPages: indexPages.map((p) => p.sourceKey), unresolved };
}
