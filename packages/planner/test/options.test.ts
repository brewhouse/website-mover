import { describe, expect, it } from 'vitest';
import type { ExtractedPage, NavLink, SiteAnalysis, SnapshotFile } from '@wm/core';
import { buildPlan, renderPlan, withSectionNav, type PlanOptions, type TargetEntity, type TargetInfo } from '../src/index.js';

const origin = 'https://www.jaxha.org';
const target: TargetInfo = {
  name: 'dev',
  url: 'https://dev-jha.example.io',
  wordpress: '7.0.4',
  theme: 'planeteriaweb',
  permalinks: '/%postname%/',
  disabledBlocks: [],
  reservedSlugs: [],
  redirection: true,
  timezone: 'UTC',
  tagline: 'City Seed Site',
};

function page(path: string, over: Partial<ExtractedPage> = {}): ExtractedPage {
  const u = new URL(path, origin);
  return {
    sourceKey: `jaxha.org${u.pathname.toLowerCase()}${u.search}`,
    url: u.href,
    kind: 'page',
    kindReason: 'test',
    title: u.pathname.slice(1),
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

const file = (id: number, referencedBy: string[]): SnapshotFile => ({
  url: `${origin}/plugins/show_image.php?id=${id}`,
  finalUrl: `${origin}/plugins/show_image.php?id=${id}`,
  status: 200,
  contentType: 'application/pdf',
  filename: `doc-${id}.pdf`,
  bytes: 10,
  sha256: `sha${id}`,
  path: `snapshot/files/sha${id}.pdf`,
  referencedBy,
});

const link = (label: string, path: string, children?: NavLink[]): NavLink => ({ label, href: `${origin}${path}`, ...(children ? { children } : {}) });

function site(over: Partial<SiteAnalysis> = {}): SiteAnalysis {
  return {
    siteName: 'Jacksonville Housing',
    menus: { top: [], main: [link('About Us', '/about-us'), link('Residents', '/residents')], footer: [], social: [], explore: [] },
    contact: { address: null, phone: null, email: null, fax: null, hours: null },
    footerNotices: [],
    home: { slides: [], buttons: [], intro: null },
    ...over,
  };
}

function plan(options: Partial<PlanOptions>, extra: { pages?: ExtractedPage[]; existing?: TargetEntity[]; files?: SnapshotFile[]; site?: SiteAnalysis } = {}) {
  return buildPlan({
    jobId: 'jha-render',
    version: 1,
    source: { origin, profile: 'bjm' },
    inputs: { extractSha256: 'test' },
    target,
    pages: extra.pages ?? [],
    snapshotPages: [],
    files: extra.files ?? [],
    existing: extra.existing ?? [],
    analysis: { site: extra.site ?? site() },
    timezone: 'America/New_York',
    options,
  });
}

describe('incremental (only new content)', () => {
  // The target after the first migration (job jha-dev, on another machine): two pages and a file are
  // there, plus a page an editor added since and the seed's News page.
  const pages = [
    page('/about-us', { links: [] }),
    page('/residents'),
    page('/new-program', { contentHtml: '<p>New</p>', links: [{ href: `${origin}/about-us`, text: 'About' }] }),
  ];
  const existing = [
    entity(10, { slug: 'about-us', link: `${target.url}/about-us/`, source_key: 'jaxha.org/about-us', job_id: 'jha-dev' }),
    entity(11, { slug: 'residents-2', link: `${target.url}/residents-2/`, source_key: 'jaxha.org/residents', job_id: 'jha-dev' }),
    entity(12, { type: 'attachment', slug: 'doc-1-file', link: `${target.url}/wp-content/uploads/doc-1.pdf`, source_key: 'jaxha.org/plugins/show_image.php?id=1', job_id: 'jha-dev' }),
    entity(20, { slug: 'new-program', title: 'Editor page' }),
  ];
  const files = [file(1, ['jaxha.org/about-us', 'jaxha.org/new-program']), file(2, ['jaxha.org/new-program']), file(3, ['jaxha.org/residents'])];

  it('plans only what is not on the target, keeps everything there, and records it for links and menus', () => {
    const p = plan({ incremental: true }, { pages, existing, files });
    expect(p.items.map((i) => i.sourceKey)).toEqual(['jaxha.org/new-program']);
    // The editor's page isn't trashed, and keeps its slug: the new page gets another.
    expect(p.cleanup).toEqual([]);
    expect(p.items[0]!.slug).not.toBe('new-program');
    // Only the new file the new page uses goes up; the uploaded one is linked to; file 3 is only on an old page.
    expect(p.media.map((m) => m.sourceKey)).toEqual(['jaxha.org/plugins/show_image.php?id=2']);
    expect(p.alreadyMigrated.map((e) => [e.key, e.kind, e.id, e.path])).toEqual([
      ['jaxha.org/about-us', 'page', 10, '/about-us/'],
      ['jaxha.org/residents', 'page', 11, '/residents-2/'],
      ['jaxha.org/plugins/show_image.php?id=1', 'document', 12, '/wp-content/uploads/doc-1.pdf'],
    ]);
    expect(p.alreadyMigrated[0]!.from).toContain('/about-us');
    expect(p.expected.pages).toBe(1);
    // Menus still list the pages already there.
    expect(p.site!.menus.find((m) => m.name === 'Main Menu')!.items.map((i) => i.key)).toEqual(['jaxha.org/about-us', 'jaxha.org/residents']);
    expect(p.warnings.join('\n')).toMatch(/3 objects already on the target are left exactly as they are/);
    expect(p.warnings.join('\n')).toMatch(/1 items on the target that no migration created/);
    expect(p.warnings.join('\n')).toMatch(/1 files that only content already on the target uses/);
    expect(renderPlan(p)).toMatch(/only new content/);
  });

  it('without the option, plans everything again and trashes untagged pages, as before', () => {
    const p = plan({}, { pages, existing, files });
    expect(p.items).toHaveLength(3);
    expect(p.alreadyMigrated).toEqual([]);
    expect(p.cleanup.map((c) => c.id)).toEqual([20]);
  });
});

describe('content only', () => {
  it('plans content and its redirects but no menus, options, homepage, design or settings', () => {
    const p = plan({ contentOnly: true, sideNavMenu: true }, { pages: [page('/about-us')], existing: [entity(30, { title: 'News', slug: 'news', link: `${target.url}/news/`, template: 'template-news.php' })] });
    expect(p.items).toHaveLength(1);
    expect(p.site).toBeNull();
    expect(p.design).toBeNull();
    expect(p.settings).toEqual([]);
    expect(p.siteRedirects).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/Content only: menus/);
    expect(p.warnings.join('\n')).toMatch(/timezone/);
    expect(p.warnings.join('\n')).toMatch(/no effect with "Content only"/);
  });

  it('without the option, plans the site structure and settings', () => {
    const p = plan({}, { pages: [page('/about-us')] });
    expect(p.site).not.toBeNull();
    expect(p.settings.map((s) => s.key)).toEqual(['timezone', 'description']);
  });
});

describe('side navigation in the main menu', () => {
  // As jaxha.org shows it: About Us's side menu lists sections that are top-level menu items too,
  // HCV Program's lists HCV Landlords, whose own lists the landlord pages.
  const sectionNav: NonNullable<SiteAnalysis['sectionNav']> = [
    { parent: link('About Us', '/about-us'), children: [link('Careers', '/careers'), link('Residents', '/residents'), link('HCV Program', '/hcv-program')] },
    { parent: link('HCV Program', '/hcv-program'), children: [link('HCV Landlords', '/hcv-landlords'), link('HCV Forms', '/upages.php?id=603')] },
    { parent: link('HCV Landlords', '/hcv-landlords'), children: [link('Landlord FAQ', '/landlord-faq'), link('About Us', '/about-us')] },
    { parent: link('Landlord FAQ', '/landlord-faq'), children: [link('Too Deep', '/too-deep')] },
  ];

  it('adds each section’s links under its menu item, once, down to three levels', () => {
    const warnings: string[] = [];
    const main = withSectionNav([link('About Us', '/about-us', [link('Careers', '/careers')]), link('Residents', '/residents')], sectionNav, warnings);
    const shape = (links: NavLink[]): unknown => links.map((l) => (l.children?.length ? [l.label, shape(l.children)] : l.label));
    expect(shape(main)).toEqual([
      ['About Us', ['Careers', ['HCV Program', ['HCV Landlords', 'HCV Forms']]]],
      'Residents',
    ]);
    expect(warnings.join('\n')).toMatch(/3 links added/);
    expect(warnings.join('\n')).toMatch(/"Landlord FAQ" \(under "HCV Landlords"\)/);
  });

  it('puts the merged menu in the plan, linking to migrated pages and dropping the rest', () => {
    const pages = ['/about-us', '/residents', '/careers', '/hcv-program', '/hcv-landlords'].map((p) => page(p));
    const p = plan({ sideNavMenu: true }, { pages, site: site({ sectionNav }) });
    const items = p.site!.menus.find((m) => m.name === 'Main Menu')!.items;
    expect(items.map((i) => [i.title, i.parent === null ? null : items[i.parent]!.title])).toEqual([
      ['About Us', null],
      ['Careers', 'About Us'],
      ['HCV Program', 'About Us'],
      ['HCV Landlords', 'HCV Program'],
      ['Residents', null],
    ]);
    expect(p.warnings.join('\n')).toMatch(/HCV Forms/);
  });

  it('leaves the main menu as the source has it without the option, and says when the analysis has no side navigation', () => {
    const pages = ['/about-us', '/residents', '/careers'].map((p) => page(p));
    expect(plan({}, { pages, site: site({ sectionNav }) }).site!.menus.find((m) => m.name === 'Main Menu')!.items).toHaveLength(2);
    expect(plan({ sideNavMenu: true }, { pages }).warnings.join('\n')).toMatch(/predates side navigation/);
  });
});
