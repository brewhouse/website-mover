import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobPath, readJsonl, writeJson, writeJsonl, type ExtractedPage, type SnapshotPage } from '@wm/core';
import { extractJob, type ExtractRedirect } from '../src/index.js';

/**
 * extractJob on a small BJM job built from excerpts of cached jaxha.org pages
 * (chrome trimmed, personal details replaced). One run, several contracts.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/bjm/${name}`, import.meta.url), 'utf8');
const SITE = 'Jacksonville Housing - Jacksonville, Florida';
const page = (inner: string, title: string) => fixture('_chrome-top.html').replace('{{TITLE}}', title) + fixture(inner) + fixture('_chrome-bottom.html');

const ORIGIN = 'https://www.jaxha.org';
const PAGES: { url: string; finalUrl?: string; html: string }[] = [
  { url: `${ORIGIN}/`, html: page('home.inner.html', SITE) },
  { url: `${ORIGIN}/landlord-faq`, html: page('landlord-faq.inner.html', `Landlord FAQ - ${SITE}`) },
  // An id-only URL the CMS redirects to its slug page.
  { url: `${ORIGIN}/upages.php?id=380`, finalUrl: `${ORIGIN}/landlord-faq`, html: page('landlord-faq.inner.html', `Landlord FAQ - ${SITE}`) },
  { url: `${ORIGIN}/upages.php?id=652`, html: page('meeting-notice.inner.html', `October 19th, 2026 - Board of Commissioners Special Meeting - ${SITE}`) },
  { url: `${ORIGIN}/news-view?id=278`, html: page('news-view-278.inner.html', `News - ${SITE}`) },
  { url: `${ORIGIN}/news?category=1&year=-1`, html: page('news-category-1.inner.html', `News - ${SITE}`) },
  { url: `${ORIGIN}/quick-links`, html: page('quick-links.inner.html', `Quick Links - ${SITE}`) },
];

let dataDir: string;
let pages: Map<string, ExtractedPage>;
let redirects: ExtractRedirect[];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'wm-extract-'));
  process.env.WM_DATA_DIR = dataDir;
  const snapshot: SnapshotPage[] = [];
  for (const [i, p] of PAGES.entries()) {
    const html = `snapshot/html/${i}.html`;
    await mkdir(path.dirname(jobPath('t', html)), { recursive: true });
    await writeFile(jobPath('t', html), p.html);
    snapshot.push({ url: p.url, finalUrl: p.finalUrl ?? p.url, status: 200, contentType: 'text/html; charset=UTF-8', fetchedAt: '2026-10-14T00:00:00Z', html, via: 'sitemap' });
  }
  await writeJson(jobPath('t', 'job.json'), { id: 't', origin: ORIGIN, profile: 'bjm', scannedAt: '2026-10-14T00:00:00Z' });
  await writeJsonl(jobPath('t', 'snapshot', 'pages.jsonl'), snapshot);
  await writeJsonl(jobPath('t', 'snapshot', 'files.jsonl'), []);

  await extractJob({ jobId: 't' });
  pages = new Map((await readJsonl<ExtractedPage>(jobPath('t', 'extract', 'pages.jsonl'))).map((p) => [p.sourceKey, p]));
  redirects = await readJsonl<ExtractRedirect>(jobPath('t', 'extract', 'redirects.jsonl'));
});

afterAll(() => {
  delete process.env.WM_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (key: string) => {
  const p = pages.get(key);
  if (!p) throw new Error(`${key} not extracted (have: ${[...pages.keys()].join(', ')})`);
  return p;
};

describe('extractJob (bjm)', () => {
  it('classifies pages by the documented rules', () => {
    const kinds = Object.fromEntries([...pages.values()].map((p) => [p.sourceKey, `${p.kind} ${p.kindReason}`]));
    expect(kinds).toEqual({
      'jaxha.org': 'home home',
      'jaxha.org/landlord-faq': 'page default',
      'jaxha.org/upages.php?id=652': 'meeting meeting-title',
      // "Workshop" is in the title, but news items stay posts.
      'jaxha.org/news-view?id=278': 'post bjm-news-item',
      'jaxha.org/news?category=1&year=-1': 'listing bjm-listing',
      'jaxha.org/quick-links': 'utility empty-content',
    });
    expect(get('jaxha.org/quick-links').warnings).toContainEqual(expect.stringMatching(/^empty-content/));
  });

  it('sets a URL that redirected to a crawled page aside instead of extracting it twice', () => {
    expect(redirects).toEqual([
      { from: 'jaxha.org/upages.php?id=380', to: 'jaxha.org/landlord-faq', fromUrl: `${ORIGIN}/upages.php?id=380`, toUrl: `${ORIGIN}/landlord-faq` },
    ]);
  });

  it('reads a news item: date, category from the category listing, no title or date in the content', () => {
    const news = get('jaxha.org/news-view?id=278');
    expect(news).toMatchObject({ title: 'November 15th, 2025 - Land Lord Workshop', date: '2025-11-15', categories: ['Board of Commissioners'], slug: null });
    expect(news.contentHtml).not.toContain('11/15/2025');
    expect(news.contentHtml).not.toContain('Land Lord Workshop</');
    // File library renditions (&size=…) are canonicalized to ?id=N.
    expect(news.images).toEqual([{ src: `${ORIGIN}/plugins/show_image.php?id=1925`, alt: 'Jacksonville LL Workshop 111525 QR.png' }]);
    expect(news.documents).toEqual([{ href: `${ORIGIN}/plugins/show_image.php?id=1924`, text: 'Workshop flyer' }]);
  });

  it('reads a content page: main content only, absolute URLs, section parent, slug', () => {
    const faq = get('jaxha.org/landlord-faq');
    expect(faq).toMatchObject({ title: 'Landlord FAQ', slug: 'landlord-faq', parentKey: 'jaxha.org/hcv-landlords' });
    for (const chrome of ['Landlord Direct Deposit Enrollment', 'Staff Module', 'Site Map', 'More >', '<h1', '<script', 'Sub-Pages']) {
      expect(faq.contentHtml).not.toContain(chrome);
    }
    expect(faq.links).toEqual([{ href: `${ORIGIN}/landlord-forms`, text: 'landlord forms' }]);
    expect(faq.documents).toEqual([{ href: `${ORIGIN}/plugins/show_image.php?id=630`, text: 'Landlord Briefing' }]);
    expect(faq.images).toEqual([{ src: `${ORIGIN}/plugins/show_image.php?id=1312`, alt: 'Inspection checklist' }]);
  });

  it('unwraps Outlook Safe Links without keeping the mailbox they carry', () => {
    const notice = get('jaxha.org/upages.php?id=652');
    expect(notice.links).toContainEqual({
      href: 'https://teams.microsoft.com/meet/11112222333344?p=FixtureOnly',
      text: 'https://teams.microsoft.com/meet/11112222333344?p=FixtureOnly',
    });
    for (const leak of ['safelinks', 'staff.member', 'example.org', 'sdata', 'Original URL']) {
      expect(notice.contentHtml).not.toContain(leak);
    }
    expect(notice.warnings).toEqual(
      expect.arrayContaining(['virtual-meeting-link: teams', 'safe-links-unwrapped: 1', 'phone-number-link: +1%20555-010-0100,,123456789#']),
    );
  });
});
