import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { jobPath, writeJsonl, type ExtractedPage, type MeetingAnalysis } from '@wm/core';
import { analyzeMeetings } from '../src/index.js';

// Fixture text is cut from real jaxha.org notices (typos such as "22rd" kept); names and emails left out.
const origin = 'https://www.jaxha.org';
const file = (id: number) => `${origin}/plugins/show_image.php?id=${id}`;

function page(url: string, title: string, contentHtml: string, over: Partial<ExtractedPage> = {}): ExtractedPage {
  const u = new URL(url, origin);
  return {
    sourceKey: `jaxha.org${u.pathname.toLowerCase()}${u.search}`,
    url: u.href,
    kind: 'meeting',
    kindReason: 'meeting-title',
    title,
    slug: u.search ? null : u.pathname.slice(1).toLowerCase(),
    date: null,
    categories: [],
    parentKey: null,
    contentHtml,
    wordCount: contentHtml.split(/\s+/).length,
    links: [],
    images: [],
    documents: [],
    warnings: [],
    ...over,
  };
}

let job = 0;
async function analyze(pages: ExtractedPage[]): Promise<MeetingAnalysis> {
  const jobId = `meetings-${++job}`;
  await writeJsonl(jobPath(jobId, 'extract', 'pages.jsonl'), pages);
  const result = await analyzeMeetings(jobId);
  // The planner reads the file, not the return value.
  expect(JSON.parse(await readFile(jobPath(jobId, 'analyze', 'meetings.json'), 'utf8'))).toEqual(result);
  return result;
}

beforeAll(async () => {
  process.env.WM_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'wm-meetings-'));
});

describe('analyzeMeetings', () => {
  it('reads dates and times as the source writes them, title first', async () => {
    const a = await analyze([
      page('/upages.php?id=645', 'June 22rd, 2026 - Board of Commissioners Meeting',
        '<p>PUBLIC NOTICE</p><p>REGULAR MEETING OF THE BOARD OF COMMISSIONERS OF THE JACKSONVILLE HOUSING AUTHORITY</p><p>Monday, June 22, 2026 at 2:00 p.m.</p>' +
        '<p>Notice is hereby given that the Jacksonville Housing Authority (JHA) Board of Commissioners Board Meeting will hold its June Board Meeting in person on Monday, June 22, 2026 at 2:00 p.m. at its administrative office located at 1300 N. Broad Street, Jacksonville, Florida 32202.</p>'),
      page('/upages.php?id=639', 'May 11th, 2026 - BOC Finance and Audit Committee Meeting',
        '<p>PUBLIC NOTICE</p><p>THE BOARD OF COMMISSIONERS OF THE JACKSONVILLE HOUSING AUTHORITY WILL HOLD ITS FINANCE AND AUDIT COMMITTEE MEETING</p><p>ON MONDAY, MAY 11, 2026&nbsp;</p><p>BEGINNING AT 12:00 NOON</p>'),
      page('/upages.php?id=351', 'Mar. 21st BOC Finance Committee Meeting',
        '<p>PUBLIC NOTICE</p><p>Notice is hereby given that the Jacksonville Housing Authority (JHA) Board of Commissioners Finance Committee will meet in person at 1300 N. Broad Street, Jacksonville, Florida 32202 on, Tuesday, March 21, 2023, at 2:00 p.m.</p>'),
      page('/upages.php?id=626', 'PUBLIC NOTICE COLLECTIVE BARGAINING NEGOTIATIONS BETWEEN THE JACKSONVILLE HOUSING AUTHORITY AND THE INDEPENDENT ASSOCIATION OF PUBLIC AND PRIVATE EMPLOYEES',
        '<p>PUBLIC NOTICE</p><p>FRIDAY, JANUARY 30, 2026, 9:00 A.M. - 12:00 P.M.</p>'),
      page('/upages.php?id=612', 'Oct. 16th, 2025 - Collective Bargaining Negotiations', '<p>PUBLIC NOTICE</p><p>THURSDAY, OCTOBER 16, 2025, 3:00-5:00 P.M.</p>'),
      // Title and text disagree. The title's year is wrong: June 3, 2023 was a Saturday, and the
      // text's "Monday, June 3, 2024" checks out, so the text wins (flagged).
      page('/upages.php?id=470', 'June 3rd, 2023 - Board of Commissioners Monthly Meeting',
        '<p>PUBLIC NOTICE</p><p>REGULAR MEETING OF THE BOARD OF COMMISSIONERS</p><p>ON MONDAY, JUNE 3, 2024 AT 3:00 PM</p>'),
      // Here the weekday settles nothing (the title's Friday is a plausible meeting day), so the title is kept (flagged).
      page('/board-of-commissioners-governance-committee-meeting-november-13-2020-public-notice', 'November 13, 2020 Board of Commissioners Governance Committee Meeting Public Notice',
        '<p>JACKSONVILLE HOUSING AUTHORITY BOARD OF COMMISSIONERS MEETING AGENDA Monday, November 16, 2020 2:00 PM</p>'),
      page('/august-2020-executive-search-interview-schedule', 'August 7-12, 2020 Executive Search Interview Schedule', '<p>Friday, August 7, 2020</p><p>Monday, August 10, 2020</p>'),
    ]);
    const byTitle = Object.fromEntries(a.meetings.map((m) => [m.title.slice(0, 20), m]));
    expect(byTitle).toMatchObject({
      'June 22rd, 2026 - Bo': { date: '2026-06-22', startTime: '14:00', endTime: null, kind: 'Board of Commissioners Meeting', category: 'Board Meetings', location: '1300 N. Broad Street, Jacksonville, Florida 32202', confidence: 'high' },
      'May 11th, 2026 - BOC': { date: '2026-05-11', startTime: '12:00', kind: 'Finance Committee Meeting', category: 'Committee Meetings', type: 'committee' },
      'Mar. 21st BOC Financ': { date: '2023-03-21', startTime: '14:00', confidence: 'high' },
      'PUBLIC NOTICE COLLEC': { date: '2026-01-30', startTime: '09:00', endTime: '12:00', category: 'Union Negotiations', type: 'union' },
      'Oct. 16th, 2025 - Co': { date: '2025-10-16', startTime: '15:00', endTime: '17:00' },
      'June 3rd, 2023 - Boa': { date: '2024-06-03', startTime: '15:00', confidence: 'low' },
      'November 13, 2020 Bo': { date: '2020-11-13', confidence: 'low' },
    });
    expect(byTitle['June 3rd, 2023 - Boa']!.reasons.join(' ')).toMatch(/date-conflict: title 2023-06-03 .* text 2024-06-03 .*text date used/);
    expect(byTitle['November 13, 2020 Bo']!.reasons.join(' ')).toMatch(/date-conflict: title 2020-11-13 .* text 2020-11-16.*title kept/);
    expect(a.unresolved).toEqual([
      { sourceKey: 'jaxha.org/august-2020-executive-search-interview-schedule', title: 'August 7-12, 2020 Executive Search Interview Schedule', reason: expect.stringContaining('range') },
    ]);
  });

  it("merges one meeting's notice, agenda and minutes pages and gathers its files, recording and news; index pages stay pages", async () => {
    const index = page('/board-of-commissioners-meetings', 'Board of Commissioners Meetings',
      '<p><strong>June 2020</strong></p><ul>' +
        `<li><a href="${origin}/board-meeting-june-15-2020-public-notice">June 15, 2020 Board Meeting Public Notice</a><br><a href="https://youtu.be/abc123XYZ"><img src="${file(400)}" alt="YouTube video for June 15th Board Meeting"></a></li>` +
        `<li>June 15, 2020 Board Meeting - <a href="${file(290)}">Meeting Minutes</a></li></ul>`,
      { documents: [{ href: file(400), text: 'YouTube video for June 15th Board Meeting' }, { href: file(290), text: 'Meeting Minutes' }] });
    const parentKey = index.sourceKey;
    const printable = (what: string, id: number) => ({ href: file(id), text: `For a printable version of the ${what} (which includes all content as listed below), click here` });
    const a = await analyze([
      index,
      page('/board-meeting-june-15-2020-agenda', 'June 15, 2020 Board Meeting Agenda',
        '<p>Jacksonville Housing Authority Virtual RingCentral Board of Commissioners Meeting Agenda Monday, June 15, 2020 2:00 PM</p><p>Approval of Minutes: May 18, 2020 RingCentral Virtual Board Meeting</p><p>Cost &amp; Adm. Committee (10 minutes)</p>',
        { parentKey, documents: [printable('Agenda', 283)] }),
      page('/board-meeting-june-15-2020-meeting-minutes', 'June 15, 2020 Board Meeting Meeting Minutes',
        `<p>Virtual Board of Commissioners Board Meeting Minutes, June 15, 2020, 2:00 PM</p>${'<p>The Chair called the meeting to order.</p>'.repeat(40)}`,
        { parentKey, documents: [printable('Meeting Minutes', 284)] }),
      page('/board-meeting-june-15-2020-public-notice', 'June 15, 2020 Board Meeting Public Notice',
        "<p>PUBLIC NOTICE: Jacksonville Housing Authority Board of Commissioners 'Virtual' Board Meeting</p><p>Notice is hereby given that the Commissioners of the Jacksonville Housing Authority (JHA) will hold an Virtual Board Meeting Monday, June 15, 2020, at 2 PM. JHA will be using RingCentral technology to make the meeting available to the public.</p>",
        { parentKey, documents: [printable('Meeting', 282)] }),
      page('/executive-search-meeting-june-15-2020-public-notice', 'June 15, 2020 Executive Search Meeting Public Notice',
        "<p>PUBLIC NOTICE: Jacksonville Housing Authority Board of Commissioners 'Virtual' Board Meeting</p><p>Notice is hereby given that the Commissioners will hold a Virtual Meeting Monday, June 15, 2020, at 3 PM.</p>",
        { parentKey }),
      page('/news-view?id=39', 'June 15th Board of Commissioners Meeting', '<p>Notice is hereby given that the Commissioners will hold a Board Meeting Monday, June 15, 2020, at 2 PM.</p>',
        { kind: 'post', date: '2020-06-10', categories: ['Board of Commissioners'] }),
    ]);

    expect(a.indexPages).toEqual(['jaxha.org/board-of-commissioners-meetings']);
    expect(a.unresolved).toEqual([]);
    expect(a.meetings.map((m) => [m.key, m.startTime])).toEqual([
      ['meeting:2020-06-15:board-of-commissioners-meeting', '14:00'],
      ['meeting:2020-06-15:executive-search-committee-meeting', '15:00'],
    ]);
    expect(a.meetings[0]).toMatchObject({
      title: 'June 15, 2020 Board Meeting Public Notice',
      sourceKeys: ['jaxha.org/board-meeting-june-15-2020-public-notice', 'jaxha.org/board-meeting-june-15-2020-meeting-minutes', 'jaxha.org/board-meeting-june-15-2020-agenda'],
      newsKeys: ['jaxha.org/news-view?id=39'],
      location: 'using RingCentral technology',
      recordings: ['https://www.youtube.com/watch?v=abc123XYZ'],
      cancelled: false,
    });
    expect(a.meetings[0]!.documents.map((d) => [d.href, d.role])).toEqual([
      [file(282), 'notice'],
      [file(284), 'minutes'],
      [file(283), 'agenda'],
      [file(290), 'minutes'],
    ]);
  });

  it('marks cancelled meetings, and a cancellation notice cancels only the meeting at its own time', async () => {
    const searchNotice = (time: string) =>
      `<p>PUBLIC NOTICE JACKSONVILLE HOUSING AUTHORITY CEO SEARCH COMMITTEE SPECIAL MEETING VIA RINGCENTRAL</p><p>Notice is hereby given that the Committee will meet on Thursday, September 3, 2020 at ${time}.</p>`;
    const a = await analyze([
      page('/upages.php?id=607', '***CANCELED*** August 25th, 2025 - Board of Commissioners Monthly Meeting',
        '<p>***CANCELED***</p><p>PUBLIC NOTICE</p><p>REGULAR MEETING OF THE BOARD OF COMMISSIONERS</p><p>MONDAY, August 25, 2025 AT 2:00 PM</p><p>The Board of Commissioners will meet IN PERSON at the Waves Apartments Community Room, 123 S 8th Street Jacksonville Beach, Florida</p>'),
      page('/upages.php?id=223', 'October 18th, BOC Human Resources Committee Meeting',
        '<p>PUBLIC NOTICE</p><p>***CANCELLED***</p><p>Notice is hereby given that the Board of Commissioners Human Resources Committee will meet in person on Monday, October 18, 2021, at 3:00 p.m.</p>'),
      page('/executive-search-interview-meetings-september-3-2020--public-notice', 'September 3, 2020 Executive Search Interview Meetings Public Notice', searchNotice('10:00 a.m.')),
      page('/executive-search-commissioner-meeting-september-3-2020', 'September 3, 2020 Executive Search Commissioner Meeting', searchNotice('2:30 p.m.')),
      page('/executive-search-commissioner-meeting-september-3-2020-public-notice-canceled', 'September 3, 2020 Executive Search Commissioner Meeting Public Notice CANCELED',
        `<p>*CANCELED*</p>${searchNotice('2:30 p.m.')}`),
    ]);
    expect(a.meetings.map((m) => [m.date, m.startTime, m.cancelled, m.sourceKeys.length])).toEqual([
      ['2020-09-03', '10:00', false, 1],
      ['2020-09-03', '14:30', true, 2],
      ['2021-10-18', '15:00', true, 1],
      ['2025-08-25', '14:00', true, 1],
    ]);
    expect(a.meetings[3]!.location).toBe('the Waves Apartments Community Room, 123 S 8th Street Jacksonville Beach, Florida');
  });
});
