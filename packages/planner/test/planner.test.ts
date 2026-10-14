import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtractedPage, SiteAnalysis, SnapshotFile, SnapshotPage } from '@wm/core';
import { approvePlan, buildPlan, loadApprovedPlan, loadDecisions, ReviewDecisions, saveDecisions, savePlan, wpSlug, type TargetEntity, type TargetInfo } from '../src/index.js';

describe('wpSlug', () => {
  // Expected values are WordPress 7.0.4's sanitize_title() output (wp eval on the local seed).
  it.each([
    ['august-16,-2021-board-(bpaal)-meeting', 'august-16-2021-board-bpaal-meeting'],
    ['dec.-8th-boc-acquisition-committee-meeting', 'dec-8th-boc-acquisition-committee-meeting'],
    ['Cost-and-Admin-Meetings', 'cost-and-admin-meetings'],
    ['$2.3M HUD Jobs Plus grant offers Jacksonville families chance', '2-3m-hud-jobs-plus-grant-offers-jacksonville-families-chance'],
    ['Board of Commissioners – Special Meeting', 'board-of-commissioners-special-meeting'],
    ['Rent Café / Résumé', 'rent-cafe-resume'],
    ['JHA’s “30th” Anniversary & More', 'jhas-30th-anniversary-more'],
    ['  --double--dash-- ', 'double-dash'],
    ['100% Section 8 × 2', '100-section-8-x-2'],
  ])('%s → %s (as WordPress stores it)', (input, expected) => {
    expect(wpSlug(input)).toBe(expected);
  });
});

const origin = 'https://www.jaxha.org';
const target: TargetInfo = {
  name: 'local',
  url: 'http://localhost:8088',
  wordpress: '7.0.4',
  theme: 'planeteriaweb',
  permalinks: '/%postname%/',
  disabledBlocks: [],
  reservedSlugs: ['people', 'events/category'],
  redirection: false,
  timezone: 'America/New_York',
};

function page(url: string, over: Partial<ExtractedPage> = {}): ExtractedPage {
  const u = new URL(url, origin);
  return {
    sourceKey: `jaxha.org${u.pathname.toLowerCase()}${u.search}`,
    url: u.href,
    kind: 'page',
    kindReason: 'test',
    title: 'Title',
    slug: u.search ? null : u.pathname.slice(1).toLowerCase(),
    date: null,
    categories: [],
    parentKey: null,
    contentHtml: '<p>x</p>',
    wordCount: 1,
    links: [],
    images: [],
    documents: [],
    warnings: [],
    ...over,
  };
}

function entity(id: number, over: Partial<TargetEntity>): TargetEntity {
  return { id, type: 'page', status: 'publish', title: `#${id}`, slug: `s${id}`, link: '', template: null, front_page: false, source_key: null, job_id: null, ...over };
}

function plan(pages: ExtractedPage[], extra: { snapshotPages?: SnapshotPage[]; files?: SnapshotFile[]; existing?: TargetEntity[] } = {}) {
  return buildPlan({
    jobId: 'test',
    version: 1,
    source: { origin, profile: 'bjm' },
    inputs: { extractSha256: 'test' },
    target,
    pages,
    snapshotPages: extra.snapshotPages ?? [],
    files: extra.files ?? [],
    existing: extra.existing ?? [],
  });
}

describe('buildPlan', () => {
  it('keeps source URLs where WordPress can serve them and redirects the rest', () => {
    const p = plan(
      [
        page('/hcv-landlords'),
        page('/Cost-and-Admin-Meetings', { slug: 'cost-and-admin-meetings' }),
        page('/august-16,-2021-board-(bpaal)-meeting'),
        page('/upages.php?id=431', { title: 'Special District Requirements' }),
        page('/news-view?id=263', { kind: 'post', title: 'Jobs Plus grant', date: '2024-07-10', categories: ['Grants'] }),
        page('/people', { title: 'People' }), // collides with a post type's URL base
        page('/upages.php?id=999', { title: 'HCV Landlords' }), // same title as a slug page
        page('/calendar', { kind: 'listing' }),
      ],
      {
        snapshotPages: [
          { url: `${origin}/upages.php?id=78`, finalUrl: `${origin}/hcv-landlords`, status: 200, contentType: 'text/html', fetchedAt: '', html: null, via: 'link' },
        ],
      },
    );
    const by = Object.fromEntries(p.items.map((i) => [i.sourceUrl.replace(origin, ''), i]));

    expect(by['/hcv-landlords']).toMatchObject({ targetPath: '/hcv-landlords/', redirectFrom: ['/upages.php?id=78'] });
    expect(by['/Cost-and-Admin-Meetings']).toMatchObject({ targetPath: '/cost-and-admin-meetings/', redirectFrom: [] });
    expect(by['/august-16,-2021-board-(bpaal)-meeting']!.redirectFrom).toEqual(['/august-16,-2021-board-(bpaal)-meeting']);
    expect(by['/upages.php?id=431']).toMatchObject({ targetPath: '/special-district-requirements/', redirectFrom: ['/upages.php?id=431'] });
    expect(by['/news-view?id=263']).toMatchObject({ type: 'post', targetPath: '/jobs-plus-grant/', redirectFrom: ['/news-view?id=263'] });
    expect(by['/people']!.targetPath).toBe('/people-2/');
    expect(by['/upages.php?id=999']!.targetPath).toBe('/hcv-landlords-2/');
    expect(p.notMigrated.map((s) => s.sourceUrl)).toEqual([`${origin}/calendar`]);
    expect(p.categories).toEqual(['Grants']);
  });

  it('trashes seed demo content but keeps the front page, reused framework pages and earlier runs', () => {
    const p = plan([page('/news-view?id=1', { kind: 'post', title: 'News' })], {
      existing: [
        entity(1, { front_page: true, slug: 'home' }),
        entity(2, { template: 'template-news.php', slug: 'news' }),
        entity(3, { type: 'tribe_events', title: 'Demo event' }),
        entity(4, { type: 'page', slug: 'parks' }),
        entity(5, { type: 'post', source_key: 'jaxha.org/news-view?id=1', slug: 'news-from-last-run', job_id: 'test' }),
        entity(6, { type: 'attachment' }),
        // Made by an earlier run of this job, no longer planned: trashed. Another job's: left alone.
        entity(7, { type: 'tribe_events', source_key: 'meeting:2023-06-03:board', job_id: 'test' }),
        entity(8, { type: 'page', source_key: 'other.org/page', job_id: 'other' }),
      ],
    });
    expect(p.keep.map((k) => k.id)).toEqual([1, 2]);
    expect(p.cleanup.map((c) => c.id)).toEqual([3, 4, 7]);
    // Same source key as an earlier run: keeps that run's slug instead of colliding with the kept "news" page.
    expect(p.items[0]!.targetPath).toBe('/news-from-last-run/');
  });

  it('uploads only files that migrated content uses, once per identical file', () => {
    const file = (id: number, sha: string, referencedBy: string[]): SnapshotFile => ({
      url: `${origin}/plugins/show_image.php?id=${id}`,
      finalUrl: `${origin}/plugins/show_image.php?id=${id}`,
      status: 200,
      contentType: 'application/pdf',
      filename: `doc-${id}.pdf`,
      bytes: 10,
      sha256: sha,
      path: `snapshot/files/${sha}.pdf`,
      referencedBy,
    });
    const p = plan([page('/plans-and-policies'), page('/upages.php?id=433', { kind: 'meeting' })], {
      files: [
        file(1, 'aaa', ['jaxha.org/plans-and-policies']),
        file(2, 'aaa', ['jaxha.org/plans-and-policies']), // same file uploaded twice on the source
        file(3, 'bbb', ['jaxha.org/upages.php?id=433']), // only on a meeting page (M2)
      ],
    });
    expect(p.media).toHaveLength(1);
    expect(p.media[0]!.redirectFrom).toEqual(['/plugins/show_image.php?id=1', '/plugins/show_image.php?id=2']);
    expect(p.notMigrated.find((s) => s.sourceUrl.endsWith('id=3'))!.reason).toMatch(/not migrated/);
  });
});

describe('approval', () => {
  it('lets execution use a plan only while it is exactly the approved one', async () => {
    process.env.WM_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'wm-'));
    const p = plan([page('/hcv-landlords')]);
    await savePlan(p);

    await expect(loadApprovedPlan('test')).rejects.toThrow(/not approved/);
    await approvePlan('test', 'Reviewer');
    await expect(loadApprovedPlan('test')).resolves.toMatchObject({ approval: { approvedBy: 'Reviewer', planVersion: 1 } });

    // Edited after approval (same version number): refused.
    await writeFile(path.join(process.env.WM_DATA_DIR, 'jobs/test/plan/plan.v1.json'), JSON.stringify({ ...p, items: [] }, null, 2));
    await expect(loadApprovedPlan('test')).rejects.toThrow(/changed since/);
    // A newer version needs its own approval.
    const sha2 = await savePlan({ ...p, version: 2 });
    await expect(loadApprovedPlan('test')).rejects.toThrow(/approval is for plan v1/i);

    // Approving from the review screen names the plan the reviewer saw; a newer one isn't approved by it.
    await savePlan({ ...p, version: 3 });
    await expect(approvePlan('test', 'Reviewer', { version: 2, sha256: sha2 })).rejects.toThrow(/latest plan is v3/);
    await expect(loadApprovedPlan('test')).rejects.toThrow(/approval is for plan v1/i);
  });
});

describe('buildPlan with analysis (M2)', () => {
  it('turns meeting pages into events, keeps index pages, and places forms', () => {
    const notice = page('/upages.php?id=639', { kind: 'meeting', title: 'May 11th, 2026 - Finance Committee Meeting' });
    const agenda = page('/may-11-2026-agenda', { kind: 'meeting', title: 'May 11, 2026 Agenda' });
    // A news item whose title-slug equals the agenda page's old URL, which will redirect to the event.
    const news = page('/news-view?id=51', { kind: 'post', title: 'May 11 2026 Agenda' });
    const index = page('/meetings', { kind: 'meeting', title: 'Meetings' });
    const help = page('/help-center', { kind: 'utility', title: 'Help Center' });
    const signup = page('/sign-up', { kind: 'utility', title: 'Sign Up' });
    const agendaFile: SnapshotFile = {
      url: `${origin}/plugins/show_image.php?id=7`,
      finalUrl: `${origin}/plugins/show_image.php?id=7`,
      status: 200,
      contentType: 'application/pdf',
      filename: 'agenda.pdf',
      bytes: 1,
      sha256: 'h7',
      path: 'snapshot/files/h7.pdf',
      referencedBy: [agenda.sourceKey],
    };
    const withAnalysis = buildPlan({
      jobId: 'test',
      version: 1,
      source: { origin, profile: 'bjm' },
      inputs: { extractSha256: 'test' },
      target,
      pages: [notice, agenda, index, help, signup, news],
      snapshotPages: [],
      files: [agendaFile],
      existing: [],
      analysis: {
        meetings: {
          meetings: [
            {
              key: 'meeting:2026-05-11:finance-committee-meeting',
              title: notice.title,
              date: '2026-05-11',
              startTime: '12:00',
              endTime: null,
              kind: 'Finance Committee Meeting',
              type: 'committee',
              category: 'Committee Meetings',
              location: null,
              cancelled: false,
              sourceKeys: [notice.sourceKey, agenda.sourceKey],
              newsKeys: [],
              documents: [{ href: `${origin}/plugins/show_image.php?id=7`, text: 'Agenda', role: 'agenda' }],
              recordings: [],
              confidence: 'high',
              reasons: [],
            },
          ],
          indexPages: [index.sourceKey],
          unresolved: [],
        },
        forms: {
          forms: [
            { key: `${help.sourceKey}#form-1`, pageKey: help.sourceKey, kind: 'form', title: 'Help Center', description: null, fields: [], sensitive: [], uploads: false, captcha: true, implementation: 'native', warnings: [] },
            { key: `${signup.sourceKey}#form-1`, pageKey: signup.sourceKey, kind: 'subscription', title: 'Sign Up', description: null, fields: [], sensitive: [], uploads: false, captcha: false, implementation: 'native', warnings: [] },
          ],
        },
      },
    });

    // The merged meeting pages are one event; their URLs redirect to it, and they aren't pages.
    expect(withAnalysis.events).toHaveLength(1);
    expect(withAnalysis.events[0]!.redirectFrom).toEqual(['/upages.php?id=639', '/may-11-2026-agenda']);
    expect(withAnalysis.items.map((i) => i.sourceUrl.replace(origin, ''))).toEqual(['/help-center', '/meetings', '/news-view?id=51']);
    // The old agenda URL redirects to the event, so the news post can't take it.
    expect(withAnalysis.items.find((i) => i.type === 'post')!.targetPath).toBe('/may-11-2026-agenda-2/');
    // Forms go on their page; a subscription sign-up is flagged, and its page isn't migrated.
    expect(withAnalysis.items.find((i) => i.sourceUrl.endsWith('/help-center'))!.forms).toEqual([`${help.sourceKey}#form-1`]);
    expect(withAnalysis.forms.map((f) => [f.title, f.action, f.captcha])).toEqual([['Help Center', 'rebuild', true], ['Sign Up', 'flag', false]]);
    expect(withAnalysis.notMigrated.find((s) => s.sourceUrl.endsWith('/sign-up'))!.reason).toMatch(/subscription/i);
    // A file used only by a meeting page is uploaded now that the meeting is migrated.
    expect(withAnalysis.media.map((m) => m.sourceUrl.replace(origin, ''))).toEqual(['/plugins/show_image.php?id=7']);
  });
});

describe('buildPlan with the site structure (M3)', () => {
  it('links menus and homepage tiles to migrated content and clears contact placeholders the source has no value for', () => {
    const about = page('/about-us', { title: 'About Us' });
    const site: SiteAnalysis = {
      siteName: 'Jacksonville Housing',
      menus: {
        top: [{ label: 'Calendar', href: `${origin}/calendar` }],
        main: [{ label: 'About Us', href: `${origin}/about-us`, children: [{ label: 'Old Page', href: `${origin}/not-migrated` }] }],
        footer: [],
        social: [{ label: 'Like us on Facebook', href: 'https://www.facebook.com/JacksonvilleHousingAuthority' }],
        explore: [],
      },
      contact: { address: '1300 N Broad Street, Jacksonville, FL 32202', phone: '904-630-3810', email: null, fax: null, hours: null },
      footerNotices: [],
      home: {
        slides: [],
        buttons: [
          { label: 'View Our Full Calendar', href: `${origin}/calendar` },
          { label: 'Old Tile', href: `${origin}/not-migrated` },
        ],
      },
    };
    const result = buildPlan({
      jobId: 'test',
      version: 1,
      source: { origin, profile: 'bjm' },
      inputs: { extractSha256: 'test' },
      // The Events Calendar is active: the source's calendar page becomes its /events/ archive.
      target: { ...target, reservedSlugs: [...target.reservedSlugs, 'event'] },
      pages: [about],
      snapshotPages: [],
      files: [],
      existing: [],
      analysis: { site },
    });

    const menu = (name: string) => result.site!.menus.find((m) => m.name === name)!.items.map((i) => [i.title, i.key, i.url]);
    // Links to migrated pages carry the page's key (the menu follows later slug changes); a link to
    // content that isn't migrated is left out and reported; external links and labels stay as in the source.
    expect(menu('Main Menu')).toEqual([['About Us', about.sourceKey, '/about-us/']]);
    expect(menu('Top Menu')).toEqual([['Calendar', null, '/events/']]);
    expect(menu('Social Menu')).toEqual([['Like us on Facebook', null, 'https://www.facebook.com/JacksonvilleHousingAuthority']]);
    expect(result.site!.home.quickLinks).toEqual([{ title: 'View Our Full Calendar', url: '/events/', key: null }]);
    expect(result.warnings.join('\n')).toMatch(/"Old Page"[\s\S]*"Old Tile"/);

    // The seed's placeholder email and fax, with their headings and icons, are cleared so the
    // footer doesn't show empty rows; the phone keeps the seed's heading.
    expect(result.site!.options).toEqual({
      footer_address: '1300 N Broad Street, Jacksonville, FL 32202',
      footer_address_heading: '',
      footer_phone: '904-630-3810',
      footer_email: '',
      footer_email_heading: '',
      footer_email_icon: '',
      footer_fax: '',
      footer_fax_heading: '',
      footer_fax_icon: '',
    });
    expect(result.site!.home.clearOthers).toBe(true);
  });

  it('keeps dropdown parents without a page of their own as headings, links documents, and empties menus the source lacks', () => {
    const fss = page('/fss', { title: 'FSS Program' });
    const planPdf = `${origin}/plugins/show_image.php?id=12`;
    const pdf: SnapshotFile = {
      url: planPdf,
      finalUrl: planPdf,
      status: 200,
      contentType: 'application/pdf',
      filename: 'annual-plan.pdf',
      bytes: 1,
      sha256: 'h12',
      path: 'snapshot/files/h12.pdf',
      referencedBy: [],
    };
    // Shaped like a site.json from before homepage tiles were read (no `home.buttons`).
    const site = {
      siteName: null,
      menus: {
        top: [],
        main: [
          { label: 'Residents', href: '', children: [{ label: 'FSS Program', href: `${origin}/fss` }] },
          { label: 'Annual Plan', href: planPdf },
        ],
        footer: [],
        social: [],
        explore: [],
      },
      contact: { address: null, phone: null, email: null, fax: null, hours: null },
      footerNotices: [],
      home: { slides: [] },
    } as unknown as SiteAnalysis;
    const result = buildPlan({
      jobId: 'test',
      version: 1,
      source: { origin, profile: 'bjm' },
      inputs: { extractSha256: 'test' },
      target,
      pages: [fss],
      snapshotPages: [],
      files: [pdf],
      existing: [],
      analysis: { site },
    });

    const main = result.site!.menus.find((m) => m.name === 'Main Menu')!.items;
    expect(main.map((i) => [i.title, i.key, i.url, i.parent])).toEqual([
      ['Residents', null, '#', null],
      ['FSS Program', fss.sourceKey, '/fss/', 0],
      // A document only the menu links to is uploaded; the executor links the item to the file.
      ['Annual Plan', 'jaxha.org/plugins/show_image.php?id=12', '/plugins/show_image.php?id=12', null],
    ]);
    expect(result.media.map((m) => [m.sourceKey, m.usedBy])).toEqual([['jaxha.org/plugins/show_image.php?id=12', ['site']]]);
    // Menus the source has no links for are still planned, so the seed's demo links are removed.
    expect(result.site!.menus.map((m) => [m.name, m.items.length])).toEqual([
      ['Main Menu', 3],
      ['Top Menu', 0],
      ['Footer Menu', 0],
      ['Social Menu', 0],
      ['Explore Menu', 0],
    ]);
    expect(result.site!.home.quickLinks).toEqual([]);
    expect(result.site!.options).toMatchObject({ footer_address: '', footer_address_heading: '', footer_address_icon: '' });
  });
});

describe('buildPlan with reviewer decisions (M4)', () => {
  it('excludes, includes, retypes, renames and keeps what the reviewer chose, and reports decisions that match nothing', () => {
    const about = page('/about', { title: 'About' });
    const news = page('/news-view?id=1', { kind: 'post', title: 'Annual Report', date: '2026-01-05' });
    const quick = page('/quick-links', { kind: 'utility', title: 'Quick Links' });
    const old = page('/old', { title: 'Old Page' });
    const notice = page('/upages.php?id=5', { kind: 'meeting', title: 'May 11th, 2026 - Board Meeting' });
    const file = (id: number, referencedBy: string[]): SnapshotFile => ({
      url: `${origin}/plugins/show_image.php?id=${id}`,
      finalUrl: `${origin}/plugins/show_image.php?id=${id}`,
      status: 200,
      contentType: 'application/pdf',
      filename: `doc-${id}.pdf`,
      bytes: 1,
      sha256: `h${id}`,
      path: `snapshot/files/h${id}.pdf`,
      referencedBy,
    });
    const meetingKey = 'meeting:2026-05-11:board-meeting';
    const decisions = {
      exclude: [old.sourceKey, meetingKey, 'jaxha.org/plugins/show_image.php?id=3'],
      include: [quick.sourceKey, 'jaxha.org/plugins/show_image.php?id=2', 'jaxha.org/gone'],
      type: { [news.sourceKey]: 'page' as const },
      slug: { [about.sourceKey]: 'About JHA' },
      keep: [50],
    };
    const result = buildPlan({
      jobId: 'test',
      version: 2,
      source: { origin, profile: 'bjm' },
      inputs: { extractSha256: 'test' },
      target,
      pages: [about, news, quick, old, notice],
      snapshotPages: [],
      // File 1 is used only by the excluded page; file 2 isn't linked from anywhere; file 3 is
      // linked from a migrated page but excluded itself.
      files: [file(1, [old.sourceKey]), file(2, []), file(3, [about.sourceKey])],
      existing: [
        entity(50, { title: 'Demo page' }),
        // The news item, created as a post by an earlier run.
        entity(60, { type: 'post', slug: 'annual-report', source_key: news.sourceKey, job_id: 'test' }),
        // The About page, created by an earlier run under its source slug.
        entity(70, { slug: 'about', source_key: about.sourceKey, job_id: 'test' }),
      ],
      analysis: {
        meetings: {
          meetings: [
            {
              key: meetingKey,
              title: notice.title,
              date: '2026-05-11',
              startTime: null,
              endTime: null,
              kind: 'Board Meeting',
              type: 'regular',
              category: 'Board Meetings',
              location: null,
              cancelled: false,
              sourceKeys: [notice.sourceKey],
              newsKeys: [],
              documents: [],
              recordings: [],
              confidence: 'high',
              reasons: [],
            },
          ],
          indexPages: [],
          unresolved: [],
        },
      },
      decisions,
    });

    const items = Object.fromEntries(result.items.map((i) => [i.sourceKey, i]));
    // New slug (even though an earlier run created the page under the old one), with the source URL redirecting to it.
    expect([items[about.sourceKey]!.targetPath, items[about.sourceKey]!.redirectFrom]).toEqual(['/about-jha/', ['/about']]);
    expect(items[news.sourceKey]!.type).toBe('page');
    expect(items[quick.sourceKey]!.type).toBe('page');
    expect(Object.keys(items).sort()).toEqual([about.sourceKey, news.sourceKey, quick.sourceKey].sort());

    // Excluded content isn't migrated (nor is a file only it used), and says why.
    expect(result.events).toEqual([]);
    const skipped = Object.fromEntries(result.notMigrated.map((s) => [s.sourceKey, s.reason]));
    expect(skipped[old.sourceKey]).toBe('Excluded by the reviewer');
    expect(skipped[notice.sourceKey]).toBe('Excluded by the reviewer');
    expect(skipped['jaxha.org/plugins/show_image.php?id=3']).toBe('Excluded by the reviewer');
    expect(result.media.map((m) => [m.sourceKey, m.usedBy])).toEqual([['jaxha.org/plugins/show_image.php?id=2', ['reviewer']]]);

    // The demo page stays; the earlier post goes, since the item is now a page.
    expect(result.keep.map((k) => [k.id, k.reason])).toEqual([[50, 'Kept by the reviewer']]);
    expect(result.cleanup.map((c) => [c.id, c.reason])).toEqual([[60, 'now migrated as a page; the earlier post goes']]);

    expect(result.warnings).toContain('Reviewer decisions that no longer match anything (ignored): jaxha.org/gone');
    expect(result.decisions).toEqual(decisions);
  });

  it('says when a chosen slug has nothing a URL can use, and keeps the page’s own', () => {
    const a = page('/residents', { title: 'Residents' });
    const result = plan2([a], { slug: { [a.sourceKey]: '!!!' } });
    expect(result.items[0]!.slug).toBe('residents');
    expect(result.warnings).toContain('The slug "!!!" chosen for "Residents" has no characters a URL can use: the page keeps its own.');
  });

  it('refuses a damaged decisions file rather than planning as if there were no decisions', async () => {
    process.env.WM_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'wm-'));
    expect(await loadDecisions('test')).toEqual({ exclude: [], include: [], type: {}, slug: {}, keep: [] });
    await saveDecisions('test', ReviewDecisions.parse({ exclude: ['jaxha.org/b', 'jaxha.org/a'] }));
    expect((await loadDecisions('test')).exclude).toEqual(['jaxha.org/a', 'jaxha.org/b']);
    await writeFile(path.join(process.env.WM_DATA_DIR, 'jobs/test/review/decisions.json'), '{"exclude": ["jaxha.org/a"');
    await expect(loadDecisions('test')).rejects.toThrow(/Can't read the reviewer decisions/);
  });

  it('gives a chosen slug that is taken a suffix and says so', () => {
    const a = page('/residents', { title: 'Residents' });
    const b = page('/upages.php?id=9', { title: 'Resident Handbook' });
    const result = plan2([a, b], { slug: { [b.sourceKey]: 'residents' } });
    expect(result.items.find((i) => i.sourceKey === b.sourceKey)!.slug).toBe('residents-2');
    expect(result.warnings).toContain('The slug "residents" chosen for "Resident Handbook" is taken: it gets "residents-2".');
  });
});

function plan2(pages: ExtractedPage[], decisions: Partial<ReviewDecisions>) {
  return buildPlan({
    jobId: 'test',
    version: 1,
    source: { origin, profile: 'bjm' },
    inputs: { extractSha256: 'test' },
    target,
    pages,
    snapshotPages: [],
    files: [],
    existing: [],
    decisions: ReviewDecisions.parse(decisions),
  });
}

