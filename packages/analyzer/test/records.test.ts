import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { jobPath, sourceKey, writeJsonl, type ExtractedPage, type PageKind, type RecordAnalysis, type SnapshotFile } from '@wm/core';
import { analyzeRecords } from '../src/index.js';

/**
 * analyzeRecords on a small job shaped like jaxha.org (BJM CMS): extract records written directly,
 * page markup trimmed from the real pages, names and addresses made up.
 */
const O = 'https://www.jaxha.org';
const img = (id: number) => `${O}/plugins/show_image.php?id=${id}`;

function page(url: string, kind: PageKind, title: string, contentHtml: string, extra: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    sourceKey: sourceKey(url),
    url,
    kind,
    kindReason: 'test',
    title,
    slug: new URL(url).pathname.split('/').pop() || null,
    date: null,
    categories: [],
    parentKey: null,
    contentHtml,
    wordCount: 0,
    links: [],
    images: [],
    documents: [],
    warnings: [],
    ...extra,
  };
}

const BOARD = `
<p><img src="${img(1)}" alt="a.jpg"></p>
<p><strong><a href="mailto:achair@example.org">Ann Chair</a>&nbsp;- Chair</strong></p>
<p><img src="${img(2)}" alt="Bea Second"></p>
<p><span><strong><a href="mailto:bsecond@example.org">Bea Second</a>&nbsp;- Secretary<br></strong>Resident Community Organizer</span></p>
<p><span><strong><img src="${img(3)}" alt="c.png"></strong></span></p>
<p><span><strong><span style="text-decoration: underline;">Cal Nolink</span> - Commissioner</strong></span></p>
<p>&nbsp;</p>
<p><strong><a href="mailto:dnophoto@example.org">Dee Nophoto</a>- Commissioner</strong></p>
<p>&nbsp;</p>
<p><strong><a href="mailto:eboss@example.org">Eve Boss</a> - Jacksonville Housing President/CEO</strong></p>`;

const STAFF = `
<p><strong>Eve Boss</strong>, President &amp; Chief Executive Officer,&nbsp; (CEO).</p>
<p><strong>Fay Mixon-Hale</strong>, Interim, Chief Operating Officer, (ICOO).</p>
<p><strong>Gus Lee,&nbsp;</strong>Deputy Chief Property Operations.</p>`;

const field = (label: string, value: string) => `
    <div class="columns small-12 large-6">
        <div class="field columns"><strong>${label}:</strong></div>
        <div class="value columns">
            ${value}
        </div>
    </div>`;
const COMMUNITY = `
<br clear="all" aria-hidden="true">
<div><div><img class="photo_img" src="${img(10)}" alt="Rental - Oak Court"></div></div>
<div>${field('Address', '1 Main Street')}${field('Zip', '32206')}${field('Office Phone', '(904) 555-0100')}${field('Website', '<a href="http://example.org/">example.org</a>')}
</div>
<br clear="all" aria-hidden="true">
<h3>Amenities/Resources:</h3>
<div><ul><li>Laundry Room</li></ul></div>`;
const LISTING = `
<div class="column"><div class="properties_img_container"><img src="${img(11)}" alt="x"></div>
<a href="${O}/locations/detail/7"><div class="location-list-item"><strong>Rental - Oak Court</strong><br><span>Multifamily / Senior Restricted</span><br><span>Address:</span><br>1 Main Street</div></a></div>`;
const MAP_HTML = `<script>
  var mapOptions = { center: new google.maps.LatLng(30.1, -81.1) };
  var html = '<div><a href="detail/7">View Details</a></div>';
  var latLong = new google.maps.LatLng(30.3602818, -81.6640332);
</script>`;

const zipTable = (rows: [string, string][], zip: string) => `
<div class="row"><div class="zip-code-table"><table><tbody>
${rows.map(([h, v]) => `<tr><td>${h}</td><td>${v}</td></tr>`).join('\n')}
</tbody></table>
<p><br><br><a href="${O}/payment-standards-map">Back to Map</a></p>
<p><a href="https://www.unitedstateszipcodes.org/${zip}/">View Demographics for Zip Code ${zip}</a></p></div></div>`;
const zipPage = (zip: string, rows: [string, string][]) =>
  page(`${O}/zip-codes-zones?field=title&value=${zip}`, 'record', zip, zipTable(rows, zip));
const FULL: [string, string][] = [
  ['Efficiency', '$1,567'],
  ['One-Bedroom', '$1,653'],
  ['Two-Bedroom', '$1,966'],
];

/** Library files: [id, filename, contentType, linking page, link text]. */
type Doc = [number, string, string, ExtractedPage, string];
const meeting = page(`${O}/upages.php?id=500`, 'meeting', 'November 16, 2020 Board Meeting Public Notice', '');
const minutesIndex = page(`${O}/upages.php?id=433`, 'meeting', 'Meeting Minutes', '');
const forms = page(`${O}/upages.php?id=603`, 'page', 'HCV Forms', '');
const plans = page(`${O}/plans-and-policies`, 'page', 'Plans and Policies', '');
const comment = page(`${O}/news-view?id=9`, 'post', 'Public Comment Period - Revised ACOP 2024', '');
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCS: Doc[] = [
  [101, 'November 16, 2020 Board Meeting Public Notice.pdf', PDF, meeting, 'For a printable version of the meeting agenda, click here'],
  [102, '11-9-23_JHA_BOC_Special_Meeting (Condensed).pdf', PDF, minutesIndex, 'Meeting Minutes'],
  [103, 'Utility Debit Card Information Sheet.pdf', PDF, forms, 'Utility Debit Card Information Sheet'],
  [104, 'Form_Notice of Intent to Vacate_250813.pdf', PDF, forms, 'Notice to Vacate'],
  [105, 'GC-#1752881-v1-JHA_COJ_Loan_Resolution 2026-JHA-06 HW.docx', DOCX, meeting, 'Resolution'],
  [106, 'FY2026.pdf', PDF, plans, 'Jacksonville Housing Administrative Plan FY2026'],
  [107, 'Revised ACOP 2024 - Updated.pdf', PDF, comment, 'Revised ACOP 2024 - Updated.pdf'],
  [108, 'SAFMR Payment Standards eff. 6.1.22 for Website 5.21.22.pdf', PDF, forms, 'SAFMR Payment Standards Effective 6/1/22'],
  [109, 'S8 Utility Chart 10.01.24  - 09.30.25 (Final).pdf', PDF, forms, 'HCV Utility Allowances 10/1/24 - 9/30/25'],
  [110, 'Budget Comparison -  Mar 2026.pdf', PDF, meeting, 'Budget Comparison - Mar 2026'],
  [111, 'JHA_Public_Notice_Board_of_Commissioners_September_25_2026_FINAL.pdf', PDF, meeting, 'Public notice'],
  [112, 'Letter of Concern.docx', DOCX, meeting, 'Letter of Concern'],
  [113, 'photo.jpg', 'image/jpeg', meeting, 'A photo'],
];

let analysis: RecordAnalysis;
const logs: string[] = [];

beforeAll(async () => {
  process.env.WM_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'wm-records-'));
  const linking = new Map<string, ExtractedPage>();
  for (const [id, , , p, text] of DOCS) {
    const target = linking.get(p.sourceKey) ?? { ...p, documents: [] };
    target.documents.push({ href: img(id), text });
    linking.set(p.sourceKey, target);
  }
  const pages: ExtractedPage[] = [
    page(`${O}/board-of-commissioners`, 'page', 'Board of Commisioners', BOARD),
    page(`${O}/senior-management`, 'page', 'Senior Management', STAFF),
    page(`${O}/locations/detail/7`, 'record', 'Rental - Oak Court', COMMUNITY),
    page(`${O}/locations/list`, 'listing', 'Communities List', LISTING),
    zipPage('32003', FULL),
    zipPage('32002', FULL.filter(([h]) => h !== 'One-Bedroom')),
    zipPage('32001', FULL),
    page(`${O}/zip-code-map`, 'record', 'Payment Standards Map', '<h3>Zip Code Map</h3>', {
      links: ['32001', '32002', '32003'].map((z) => ({ href: `${O}/zip-codes-zones?field=title&value=${z}`, text: z })),
    }),
    ...linking.values(),
  ];
  await writeJsonl(jobPath('t', 'extract', 'pages.jsonl'), pages);

  const mapHtml = 'snapshot/html/map.html';
  await mkdir(path.dirname(jobPath('t', mapHtml)), { recursive: true });
  await writeFile(jobPath('t', mapHtml), MAP_HTML);
  await writeJsonl(jobPath('t', 'snapshot', 'pages.jsonl'), [
    { url: `${O}/locations/map`, finalUrl: `${O}/locations/map`, status: 200, contentType: 'text/html', fetchedAt: '', html: mapHtml, via: 'sitemap' },
  ]);
  const files: SnapshotFile[] = DOCS.map(([id, filename, contentType, p]) => ({
    url: img(id),
    finalUrl: img(id),
    status: 200,
    contentType,
    filename,
    bytes: 1,
    sha256: String(id),
    path: `snapshot/files/${id}`,
    referencedBy: [p.sourceKey],
  }));
  await writeJsonl(jobPath('t', 'snapshot', 'files.jsonl'), files);

  analysis = await analyzeRecords('t', (m) => logs.push(m));
});

describe('analyzeRecords', () => {
  it('reads the board and staff in page order, with photos, mailto emails and bios; the CEO is staff and listed once', () => {
    expect(analysis.people.map(({ name, role, group, email, photo, bio, order }) => ({ name, role, group, email, photo, bio, order }))).toEqual([
      { name: 'Ann Chair', role: 'Chair', group: 'board', email: 'achair@example.org', photo: img(1), bio: null, order: 0 },
      { name: 'Bea Second', role: 'Secretary', group: 'board', email: 'bsecond@example.org', photo: img(2), bio: 'Resident Community Organizer', order: 1 },
      { name: 'Cal Nolink', role: 'Commissioner', group: 'board', email: null, photo: img(3), bio: null, order: 2 },
      { name: 'Dee Nophoto', role: 'Commissioner', group: 'board', email: 'dnophoto@example.org', photo: null, bio: null, order: 3 },
      { name: 'Eve Boss', role: 'Jacksonville Housing President/CEO', group: 'staff', email: 'eboss@example.org', photo: null, bio: null, order: 4 },
      { name: 'Fay Mixon-Hale', role: 'Interim, Chief Operating Officer, (ICOO)', group: 'staff', email: null, photo: null, bio: null, order: 1 },
      { name: 'Gus Lee', role: 'Deputy Chief Property Operations', group: 'staff', email: null, photo: null, bio: null, order: 2 },
    ]);
  });

  it('turns a community page into labelled fields, with the list view type and the map position', () => {
    expect(analysis.communities).toHaveLength(1);
    const c = analysis.communities[0]!;
    expect(c).toMatchObject({
      title: 'Rental - Oak Court',
      fields: { Address: '1 Main Street', Zip: '32206', 'Office Phone': '(904) 555-0100', Website: 'example.org' },
      type: 'Multifamily / Senior Restricted',
      photo: img(10),
      lat: 30.3602818,
      lng: -81.6640332,
    });
    // The body still shows the labelled values and the free sections.
    expect(c.contentHtml).toContain('<li><strong>Address:</strong> 1 Main Street</li>');
    expect(c.contentHtml).toContain('<h3>Amenities/Resources:</h3>');
  });

  it('assembles the ZIP pages into one table, ascending, keeping a page whose headings differ', () => {
    expect(analysis.tables).toHaveLength(1);
    const t = analysis.tables[0]!;
    expect(t).toMatchObject({ key: 'payment-standards', title: 'Payment Standards', notes: [] });
    expect(t.columns).toEqual(['Zip Code', 'Efficiency', 'One-Bedroom', 'Two-Bedroom']);
    expect(t.rows).toEqual([
      ['32001', '$1,567', '$1,653', '$1,966'],
      ['32002', '$1,567', '', '$1,966'],
      ['32003', '$1,567', '$1,653', '$1,966'],
    ]);
    expect(t.sourceKeys).toContain('jaxha.org/zip-code-map');
    expect(t.sourceKeys).toHaveLength(4);
    expect(logs.some((l) => l.includes('32002') && l.includes('One-Bedroom'))).toBe(true);
  });

  it.each([
    // [file id, type, library, date]
    [101, 'Notice', null, '2020-11-16'], // the filename names the file; the link text was copied from an agenda page
    [102, 'Minutes', null, '2023-11-09'], // generic filename: the link text says what it is
    [103, 'Form', null, null], // nothing in the name: filed under the "HCV Forms" page
    [104, 'Form', null, null], // "Form_" beats the "Notice" in the name; 250813 is not a stated date
    [105, 'Resolution', 'Bills & Resolutions', null],
    [106, 'Plan', 'Key Documents', null], // listed on Plans and Policies
    [107, 'Policy', null, null], // ACOP put out for public comment: a proposal, not a key document
    [108, 'Schedule', null, '2022-06-01'], // the link text's one date wins over the filename's two
    [109, 'Schedule', null, null], // a date range is not one date
    [110, 'Budget', null, null], // "Mar 2026" is not a full date
    [111, 'Notice', null, '2026-09-25'],
    [112, 'Other', null, null],
  ])('types library file %i as %s', (id, type, library, date) => {
    const doc = analysis.documents.find((d) => d.url === img(id));
    expect(doc).toMatchObject({ type, library, date });
    expect(doc!.reasons.length).toBeGreaterThan(0);
  });

  it('leaves images out of the documents', () => {
    expect(analysis.documents.map((d) => d.url)).not.toContain(img(113));
  });
});
