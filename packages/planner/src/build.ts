import type { ExtractedPage, SnapshotFile, SnapshotPage } from '@wm/core';
import { sourceKey } from '@wm/core';
import { Plan, type PlanCleanup, type PlanItem, type PlanMedia, type PlanSkip, type TargetInfo } from './schema.js';
import { SlugRegistry, wpSlug } from './slug.js';

/** Content on the target, as listed by the bridge (`GET /website-mover/v1/entities`). */
export interface TargetEntity {
  id: number;
  type: string;
  status: string;
  title: string;
  slug: string;
  link: string;
  template: string | null;
  front_page: boolean;
  source_key: string | null;
  job_id: string | null;
}

export interface BuildPlanInput {
  jobId: string;
  version: number;
  source: { origin: string; profile: string };
  target: TargetInfo;
  pages: ExtractedPage[];
  snapshotPages: SnapshotPage[];
  files: SnapshotFile[];
  existing: TargetEntity[];
}

/** Why a page kind isn't migrated in this milestone. */
const NOT_MIGRATED: Record<string, string> = {
  home: 'Homepage: rebuilt from the homepage template fields (M3)',
  listing: 'Listing: replaced by the framework listing template',
  utility: 'Site function or empty shell, not content',
  meeting: 'Meeting: migrated as an event in M2',
  record: 'Structured record (community, ZIP payment standard): M2 content types',
};

/** Seed content types the migration owns; anything of these types not created by the tool is demo content. */
const OWNED_TYPES = new Set([
  'post', 'page', 'tribe_events', 'tribe_venue', 'tribe_organizer', 'tribe_event_series',
  'alert', 'departments', 'faqs', 'people', 'resource_library',
]);

/** Framework pages the migration reuses rather than replaces. */
const KEEP_TEMPLATES: Record<string, string> = {
  'template-news.php': 'News listing page (framework News template)',
};

/** WordPress paths a page slug must not take. */
const WP_RESERVED = [
  'wp-admin', 'wp-content', 'wp-includes', 'wp-json', 'wp-login', 'wp-sitemap', 'feed', 'embed',
  'page', 'comments', 'attachment', 'search', 'author', 'category', 'tag', 'trackback', 'robots', 'sitemap',
];

export function buildPlan(input: BuildPlanInput): Plan {
  const { pages, target, existing } = input;
  const warnings: string[] = [];

  // Existing content: keep the front page and reused framework pages; trash other demo content.
  const keep: Plan['keep'] = [];
  const cleanup: PlanCleanup[] = [];
  const ours = new Map<string, TargetEntity>();
  for (const e of existing) {
    if (e.source_key) {
      ours.set(e.source_key, e);
      continue;
    }
    if (!OWNED_TYPES.has(e.type)) continue;
    const entry = { id: e.id, type: e.type, title: e.title, link: e.link };
    if (e.front_page) keep.push({ ...entry, reason: 'Front page (homepage template)' });
    else if (e.template && KEEP_TEMPLATES[e.template]) keep.push({ ...entry, reason: KEEP_TEMPLATES[e.template]! });
    else cleanup.push(entry);
  }

  const keptSlugs = existing.filter((e) => keep.some((k) => k.id === e.id)).map((e) => e.slug);
  const slugs = new SlugRegistry([...WP_RESERVED, ...target.reservedSlugs, ...keptSlugs]);

  // Source URLs that redirected to another page are aliases of it.
  const aliases = new Map<string, string[]>();
  for (const s of input.snapshotPages) {
    if (s.status !== 200 || s.url === s.finalUrl) continue;
    const to = sourceKey(s.finalUrl);
    if (to !== sourceKey(s.url)) aliases.set(to, [...(aliases.get(to) ?? []), pathAndQuery(s.url)]);
  }

  // Pages with a source slug first, so they keep their URL; then id-only pages; then posts.
  const migrated = pages.filter((p) => p.kind === 'page' || p.kind === 'post');
  const order = (p: ExtractedPage) => (p.kind === 'page' ? (p.slug ? 0 : 1) : 2);
  migrated.sort((a, b) => order(a) - order(b) || a.sourceKey.localeCompare(b.sourceKey));

  const items: PlanItem[] = [];
  for (const page of migrated) {
    const previous = ours.get(page.sourceKey)?.slug;
    const preferred = previous || wpSlug(page.slug ?? page.title);
    const slug = slugs.claim(preferred);
    const targetPath = `/${slug}/`;
    const from = pathAndQuery(page.url);
    const redirectFrom = [...(aliases.get(page.sourceKey) ?? [])];
    // Same path apart from case and trailing slash needs no redirect: WordPress resolves it.
    if (from.toLowerCase().replace(/\/$/, '') !== `/${slug}`) redirectFrom.unshift(from);
    items.push({
      sourceKey: page.sourceKey,
      sourceUrl: page.url,
      type: page.kind === 'post' ? 'post' : 'page',
      title: page.title,
      slug,
      targetPath,
      date: page.date,
      categories: page.kind === 'post' ? page.categories : [],
      parentKey: page.parentKey,
      redirectFrom: [...new Set(redirectFrom)],
      warnings:
        page.kind === 'post' && page.date && new Date(`${page.date}T00:00:00`) > new Date()
          ? [...page.warnings, `future-date: source date ${page.date} is in the future; published with the migration date`]
          : page.warnings,
    });
  }
  const included = new Set(items.map((i) => i.sourceKey));

  const notMigrated: PlanSkip[] = pages
    .filter((p) => p.kind !== 'page' && p.kind !== 'post')
    .map((p) => ({ sourceKey: p.sourceKey, sourceUrl: p.url, what: p.kind, title: p.title, reason: NOT_MIGRATED[p.kind] ?? p.kind }));

  // Files: only those used by migrated content; identical files (same hash) become one upload.
  // Image files often have no name (BJM serves them from a script), so name them after their alt text.
  const alts = new Map<string, string>();
  for (const p of migrated) for (const img of p.images) if (img.alt) alts.set(safeKey(img.src), img.alt);
  const media: PlanMedia[] = [];
  const byHash = new Map<string, PlanMedia>();
  for (const f of input.files) {
    if (f.status !== 200 || !f.path || !f.sha256) continue;
    const key = sourceKey(f.url);
    const usedBy = f.referencedBy.filter((k) => included.has(k));
    if (!usedBy.length) {
      notMigrated.push({
        sourceKey: key,
        sourceUrl: f.url,
        what: isImage(f) ? 'image' : 'document',
        title: f.filename ?? key,
        reason: f.referencedBy.length ? 'File: only used by content not migrated in M1' : 'File: not linked from any page',
      });
      continue;
    }
    const dupe = byHash.get(f.sha256);
    if (dupe) {
      dupe.redirectFrom.push(pathAndQuery(f.url));
      dupe.usedBy = [...new Set([...dupe.usedBy, ...usedBy])];
      continue;
    }
    const item: PlanMedia = {
      sourceKey: key,
      sourceUrl: f.url,
      type: isImage(f) ? 'image' : 'document',
      filename: f.filename ?? fallbackName(key, alts.get(key), f.contentType),
      contentType: f.contentType,
      bytes: f.bytes,
      sha256: f.sha256,
      path: f.path,
      usedBy,
      fields: { index_for_library: !isImage(f), publication_date: null },
      redirectFrom: [pathAndQuery(f.url)],
    };
    byHash.set(f.sha256, item);
    media.push(item);
  }

  const categories = [...new Set(items.flatMap((i) => i.categories))].sort();
  const redirects = [...items, ...media].reduce((n, i) => n + i.redirectFrom.length, 0);

  const deferredLinks = items.filter((i) => i.warnings.some((w) => /not migrated|meeting/i.test(w))).length;
  if (deferredLinks) warnings.push(`${deferredLinks} migrated pages mention content that isn't migrated in M1.`);
  if (!target.redirection) warnings.push('Redirection is not active on the target: redirects are written to redirects.csv only.');

  return Plan.parse({
    schema: 'website-mover/plan@1',
    jobId: input.jobId,
    version: input.version,
    createdAt: new Date().toISOString(),
    source: input.source,
    target,
    items,
    media,
    categories,
    cleanup,
    keep,
    notMigrated,
    expected: {
      pages: items.filter((i) => i.type === 'page').length,
      posts: items.filter((i) => i.type === 'post').length,
      documents: media.filter((m) => m.type === 'document').length,
      images: media.filter((m) => m.type === 'image').length,
      categories: categories.length,
      redirects,
      cleanup: cleanup.length,
    },
    warnings,
  });
}

/** "<alt-text-slug>.<ext>", else "<last path part>-<id>.<ext>". */
function fallbackName(key: string, alt: string | undefined, contentType: string): string {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp', 'application/pdf': 'pdf' }[contentType] ?? 'bin';
  const base = (alt && wpSlug(alt, 60)) || wpSlug(key.split('/').pop()!.replace(/\.\w+(?=\?|$)/, '').replace(/[?&=]/g, '-'), 60);
  return `${base}.${ext}`;
}

function safeKey(url: string): string {
  try {
    return sourceKey(url);
  } catch {
    return url;
  }
}

function isImage(f: SnapshotFile): boolean {
  return f.contentType.startsWith('image/');
}

/** "/path?query" of a URL, as redirect rules match it. */
export function pathAndQuery(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
