import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtractedPage, SnapshotFile, SnapshotPage } from '@wm/core';
import { approvePlan, buildPlan, loadApprovedPlan, savePlan, wpSlug, type TargetEntity, type TargetInfo } from '../src/index.js';

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
        entity(5, { type: 'post', source_key: 'jaxha.org/news-view?id=1', slug: 'news-from-last-run' }),
        entity(6, { type: 'attachment' }),
      ],
    });
    expect(p.keep.map((k) => k.id)).toEqual([1, 2]);
    expect(p.cleanup.map((c) => c.id)).toEqual([3, 4]);
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
    await savePlan({ ...p, version: 2 });
    await expect(loadApprovedPlan('test')).rejects.toThrow(/approval is for plan v1/i);
  });
});
