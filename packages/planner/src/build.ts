import type { ExtractedPage, FormAnalysis, FormRecord, MeetingAnalysis, NavLink, RecordAnalysis, SiteAnalysis, SnapshotFile, SnapshotPage } from '@wm/core';
import { createHash } from 'node:crypto';
import { sourceKey } from '@wm/core';
import {
  Plan,
  PlanOptions,
  type PlanCleanup,
  type PlanExisting,
  type PlanContentType,
  type PlanEvent,
  type PlanForm,
  type PlanItem,
  type PlanMedia,
  type PlanPerson,
  type PlanRecord,
  type PlanMenuItem,
  type PlanSetting,
  type PlanSite,
  type PlanSkip,
  type PlanTable,
  type ReviewDecisions,
  type TargetInfo,
} from './schema.js';
import { planDesign, type BrandInput } from './design.js';
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
  inputs: { extractSha256: string; analysisSha256?: Record<string, string> };
  target: TargetInfo;
  pages: ExtractedPage[];
  snapshotPages: SnapshotPage[];
  files: SnapshotFile[];
  existing: TargetEntity[];
  /** Output of the analyze stage (M2); without it, structured content is listed as not migrated. */
  analysis?: { meetings?: MeetingAnalysis; forms?: FormAnalysis; records?: RecordAnalysis; site?: SiteAnalysis };
  /** Site timezone the target should have (IANA name). */
  timezone?: string;
  /** The reviewer's changes (M4). */
  decisions?: ReviewDecisions;
  /** GA4 measurement ID: set as the theme's `ga4_measurement_id` option (theme change T13). */
  ga4Id?: string;
  /** The brand imported with `wm brand`: the Design section (M3 branding). */
  brand?: BrandInput;
  /** Job options: incremental, content only, side navigation in the main menu. */
  options?: Partial<PlanOptions>;
}

const EXCLUDED = 'Excluded by the reviewer';

/** Why a page kind isn't migrated in this milestone. */
const NOT_MIGRATED: Record<string, string> = {
  home: 'Homepage: rebuilt from the homepage template fields (M3)',
  listing: 'Listing: replaced by the framework listing template',
  utility: 'Site function or empty shell, not content',
  meeting: 'Meeting page: not analyzed (run "wm analyze")',
  record: 'Structured record: not analyzed (run "wm analyze")',
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

/**
 * Paths the framework's templates link to with no page behind them on the seed: the "All News" button
 * (single.php) and the news breadcrumb (functions.php). They redirect to the News page (theme change
 * T14 removes the hard-coding).
 */
const FRAMEWORK_NEWS_PATHS = ['/latest-news/', '/current-news/'];

/** WordPress paths a page slug must not take. */
const WP_RESERVED = [
  'wp-admin', 'wp-content', 'wp-includes', 'wp-json', 'wp-login', 'wp-sitemap', 'feed', 'embed',
  'page', 'comments', 'attachment', 'search', 'author', 'category', 'tag', 'trackback', 'robots', 'sitemap',
];

/** Taglines that are placeholders, not the organization's: the seed's ("City Seed Site") and WordPress's default. */
const PLACEHOLDER_TAGLINES = [/\bseed site\b/i, /^just another wordpress site$/i];

export function buildPlan(input: BuildPlanInput): Plan {
  const { pages, target, existing } = input;
  const options = PlanOptions.parse(input.options ?? {});
  const meetings = input.analysis?.meetings;
  const forms = input.analysis?.forms;
  const records = input.analysis?.records;
  const warnings: string[] = [];
  const pageByKey = new Map(pages.map((p) => [p.sourceKey, p]));
  const d = input.decisions;
  const decisions = d && (d.exclude.length || d.include.length || Object.keys(d.type).length || Object.keys(d.slug).length || d.keep.length) ? d : undefined;
  const excluded = new Set(decisions?.exclude ?? []);
  const includedByReviewer = new Set(decisions?.include ?? []);
  const typeOverride = decisions?.type ?? {};
  const slugOverride = decisions?.slug ?? {};
  // Source pages left out because the reviewer excluded them or the structured record they feed.
  const excludedPages = new Set([...excluded].filter((k) => pageByKey.has(k)));

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
    if (decisions?.keep.includes(e.id)) keep.push({ ...entry, reason: 'Kept by the reviewer' });
    else if (e.front_page) keep.push({ ...entry, reason: 'Front page (homepage template)' });
    else if (e.template && KEEP_TEMPLATES[e.template]) keep.push({ ...entry, reason: KEEP_TEMPLATES[e.template]! });
    else cleanup.push(entry);
  }
  // Incremental: the site is live, so nothing on it is demo content. Untagged pages (added by editors
  // since the migration) stay, and keep their slugs.
  const spared = options.incremental ? cleanup.splice(0) : [];

  // Custom types this plan creates (their URL bases are ours, not reserved by something else).
  const communities = (records?.communities ?? []).filter((c) => pageByKey.has(c.sourceKey) && !excluded.has(c.sourceKey));
  const meetingList = (meetings?.meetings ?? []).filter((m) => !excluded.has(m.key));
  const tableList = (records?.tables ?? []).filter((t) => !excluded.has(`table:${t.key}`));
  for (const m of meetings?.meetings ?? []) if (excluded.has(m.key)) for (const k of m.sourceKeys) excludedPages.add(k);
  for (const t of records?.tables ?? []) if (excluded.has(`table:${t.key}`)) for (const k of t.sourceKeys) excludedPages.add(k);
  const contentTypes: PlanContentType[] = [];
  const ownBases = new Set(communities.length ? ['communities'] : []);

  const keptSlugs = existing.filter((e) => keep.some((k) => k.id === e.id) || spared.some((k) => k.id === e.id)).map((e) => e.slug);
  // Old single-segment URLs that will redirect somewhere else (meeting pages merged into events,
  // community pages, table sources) must not be handed out as new slugs: the redirect would win.
  const movedAway = new Set([...meetingList.flatMap((m) => m.sourceKeys), ...communities.map((c) => c.sourceKey), ...tableList.flatMap((t) => t.sourceKeys)]);
  const sourcePaths = [...movedAway].map((k) => pageByKey.get(k)).filter((p): p is ExtractedPage => !!p).map((p) => pathAndQuery(p.url));
  // Aliases (URLs that already redirected on the source) and listing pages that redirect to a
  // listing are redirect sources too.
  for (const s of input.snapshotPages) {
    if (s.status === 200 && sourceKey(s.url) !== sourceKey(s.finalUrl)) sourcePaths.push(pathAndQuery(s.url));
  }
  if (communities.length) {
    for (const p of pages) if (p.kind === 'listing' && /^\/locations(\/|$)/.test(new URL(p.url).pathname)) sourcePaths.push(pathAndQuery(p.url));
  }
  const movedAwaySlugs = sourcePaths
    .filter((path) => !path.includes('?'))
    .map((path) => path.toLowerCase().replace(/^\/|\/$/g, ''))
    .filter((s) => s && !s.includes('/'));
  const slugs = new SlugRegistry([...WP_RESERVED, ...target.reservedSlugs.filter((s) => !ownBases.has(s)), ...keptSlugs, ...movedAwaySlugs]);
  // An object an earlier run created keeps its slug, unless the reviewer chose a new one.
  const claim = (key: string, preferred: string, registry = slugs) => registry.claim((!slugOverride[key] && ours.get(key)?.slug) || preferred);

  // Source URLs that redirected to another page are aliases of it.
  const aliases = new Map<string, string[]>();
  for (const s of input.snapshotPages) {
    if (s.status !== 200 || s.url === s.finalUrl) continue;
    const to = sourceKey(s.finalUrl);
    if (to !== sourceKey(s.url)) aliases.set(to, [...(aliases.get(to) ?? []), pathAndQuery(s.url)]);
  }
  const redirectsFor = (key: string, newPath: string) => {
    const page = pageByKey.get(key);
    const from = page ? [pathAndQuery(page.url), ...(aliases.get(key) ?? [])] : [];
    // Same path apart from case and trailing slash needs no redirect: WordPress resolves it.
    return [...new Set(from)].filter((f) => f.toLowerCase().replace(/\/$/, '') !== newPath.toLowerCase().replace(/\/$/, ''));
  };

  // Which extracted pages become pages/posts.
  const indexPages = new Set(meetings?.indexPages ?? []);
  const unresolvedMeetings = new Set((meetings?.unresolved ?? []).map((u) => u.sourceKey));
  const formsByPage = new Map<string, FormRecord[]>();
  for (const f of forms?.forms ?? []) formsByPage.set(f.pageKey, [...(formsByPage.get(f.pageKey) ?? []), f]);
  const rebuiltForms = (key: string) => (formsByPage.get(key) ?? []).filter((f) => f.kind === 'form');
  const asItem = (p: ExtractedPage): boolean =>
    !excludedPages.has(p.sourceKey) &&
    (p.kind === 'page' ||
      p.kind === 'post' ||
      (p.kind === 'meeting' && (indexPages.has(p.sourceKey) || unresolvedMeetings.has(p.sourceKey))) ||
      (p.kind === 'utility' && rebuiltForms(p.sourceKey).length > 0) ||
      // The reviewer can bring in a page the rules left out, unless a structured record uses it.
      (includedByReviewer.has(p.sourceKey) && !movedAway.has(p.sourceKey)));
  const typeOf = (p: ExtractedPage): 'page' | 'post' => typeOverride[p.sourceKey] ?? (p.kind === 'post' ? 'post' : 'page');

  // Pages with a source slug first, so they keep their URL; then id-only pages; then posts.
  const migrated = pages.filter(asItem);
  const order = (p: ExtractedPage) => (typeOf(p) === 'post' ? 2 : p.slug ? 0 : 1);
  migrated.sort((a, b) => order(a) - order(b) || a.sourceKey.localeCompare(b.sourceKey));

  const items: PlanItem[] = [];
  for (const page of migrated) {
    const type = typeOf(page);
    const requested = slugOverride[page.sourceKey] ? wpSlug(slugOverride[page.sourceKey]!) : null;
    if (slugOverride[page.sourceKey] && !requested) warnings.push(`The slug "${slugOverride[page.sourceKey]}" chosen for "${page.title}" has no characters a URL can use: the page keeps its own.`);
    const slug = claim(page.sourceKey, requested || wpSlug(page.slug ?? page.title));
    if (requested && slug !== requested) warnings.push(`The slug "${requested}" chosen for "${page.title}" is taken: it gets "${slug}".`);
    const targetPath = `/${slug}/`;
    const itemWarnings = [...page.warnings];
    if (type === 'post' && page.date && new Date(`${page.date}T00:00:00`) > new Date()) {
      itemWarnings.push(`future-date: source date ${page.date} is in the future; published with the migration date`);
    }
    if (unresolvedMeetings.has(page.sourceKey)) itemWarnings.push('needs-review: meeting page the rules could not place; migrated as a page');
    items.push({
      sourceKey: page.sourceKey,
      sourceUrl: page.url,
      type,
      title: page.title,
      slug,
      targetPath,
      date: page.date,
      categories: type === 'post' ? page.categories : [],
      parentKey: page.parentKey,
      redirectFrom: redirectsFor(page.sourceKey, targetPath),
      forms: rebuiltForms(page.sourceKey).map((f) => f.key),
      warnings: itemWarnings,
      contentSha256: createHash('sha256').update(page.contentHtml).digest('hex'),
    });
  }

  // Events: one per meeting (The Events Calendar, single URLs under /event/).
  const eventSlugs = new SlugRegistry([]);
  const events: PlanEvent[] = meetingList.map((m) => {
    const slug = claim(m.key, wpSlug(m.title), eventSlugs);
    const targetPath = `/event/${slug}/`;
    return {
      key: m.key,
      title: m.title,
      slug,
      targetPath,
      date: m.date,
      startTime: m.startTime,
      endTime: m.endTime,
      category: m.category,
      kind: m.kind,
      location: m.location,
      cancelled: m.cancelled,
      sourceKeys: m.sourceKeys,
      newsKeys: m.newsKeys,
      documents: m.documents.map((d) => ({ url: d.href, text: d.text, role: d.role })),
      recordings: m.recordings,
      redirectFrom: [...new Set(m.sourceKeys.flatMap((k) => redirectsFor(k, targetPath)))],
      confidence: m.confidence,
      warnings: m.confidence === 'low' ? [`low-confidence: ${m.reasons.join('; ')}`] : [],
    };
  });
  const eventPages = new Set(events.flatMap((e) => e.sourceKeys));

  // People (board, staff): the seed's people type, single URLs under /people/.
  const peopleSlugs = new SlugRegistry([]);
  const people: PlanPerson[] = (records?.people ?? []).filter((p) => !excluded.has(p.key)).map((p) => ({
    key: p.key,
    pageKey: p.pageKey,
    group: p.group,
    name: p.name,
    slug: claim(p.key, wpSlug(p.name), peopleSlugs),
    role: p.role,
    email: p.email,
    phone: p.phone,
    photo: p.photo,
    bio: p.bio,
    order: p.order,
  }));

  // Forms: rebuilt in the forms plugin, or flagged (subscriptions); logins are never migrated.
  const planForms: PlanForm[] = (forms?.forms ?? [])
    .filter((f) => f.kind !== 'login')
    .map((f) => ({
      key: f.key,
      pageKey: f.pageKey,
      action: f.kind === 'form' ? 'rebuild' : 'flag',
      title: f.title,
      description: f.description,
      fields: f.fields as unknown as Record<string, unknown>[],
      sensitive: f.sensitive,
      retentionDays: f.sensitive.length ? SENSITIVE_RETENTION_DAYS : null,
      uploads: f.uploads,
      captcha: f.captcha,
      reason:
        f.kind === 'form'
          ? f.sensitive.length
            ? `Collects ${f.sensitive.join(', ')}: left out of notification emails, entries deleted after ${SENSITIVE_RETENTION_DAYS} days. Needs the client's sign-off.`
            : 'Rebuilt in the forms plugin'
          : 'Subscription service (alerts sign-up): not rebuilt; needs a tool behind it',
    }));

  // Communities: a custom type created through ACF, with a listing page.
  const recordsPlan: PlanRecord[] = [];
  if (communities.length) {
    const labels = new Map<string, string>();
    for (const c of communities) for (const label of Object.keys(c.fields)) labels.set(fieldName(label), label);
    // Title from the source's list view (the map view is the same data drawn on a map).
    const listings = pages.filter((p) => p.kind === 'listing' && /^\/locations(\/|$)/.test(new URL(p.url).pathname));
    const listingPage = listings.find((p) => /\/list$/.test(new URL(p.url).pathname)) ?? listings[0];
    const listingSlug = claim('listing:community', 'communities');
    contentTypes.push({
      postType: 'community',
      label: 'Communities',
      singular: 'Community',
      rewriteSlug: 'communities',
      taxonomy: { name: 'community_type', label: 'Community Types', singular: 'Community Type' },
      fields: Object.fromEntries(labels),
      listing: {
        title: listingPage?.title || 'Communities',
        slug: listingSlug,
        targetPath: `/${listingSlug}/`,
        redirectFrom: pages
          .filter((p) => p.kind === 'listing' && /^\/locations(\/|$)/.test(new URL(p.url).pathname))
          .flatMap((p) => [pathAndQuery(p.url), ...(aliases.get(p.sourceKey) ?? [])]),
      },
    });
    const communitySlugs = new SlugRegistry([]);
    for (const c of communities) {
      const slug = claim(c.sourceKey, wpSlug(c.title), communitySlugs);
      const targetPath = `/communities/${slug}/`;
      recordsPlan.push({
        sourceKey: c.sourceKey,
        sourceUrl: pageByKey.get(c.sourceKey)!.url,
        postType: 'community',
        title: c.title,
        slug,
        targetPath,
        fields: Object.fromEntries(Object.entries(c.fields).map(([label, value]) => [fieldName(label), value])),
        term: c.type,
        photo: c.photo,
        redirectFrom: redirectsFor(c.sourceKey, targetPath),
      });
    }
  }
  const recordPages = new Set(recordsPlan.map((r) => r.sourceKey));

  // Tables assembled from many pages (payment standards): one page each.
  const tables: PlanTable[] = tableList.map((t) => {
    const slug = claim(`table:${t.key}`, wpSlug(t.title));
    const targetPath = `/${slug}/`;
    return {
      key: t.key,
      title: t.title,
      slug,
      targetPath,
      columns: t.columns,
      rows: t.rows,
      notes: t.notes,
      sourceKeys: t.sourceKeys,
      redirectFrom: [...new Set(t.sourceKeys.flatMap((k) => redirectsFor(k, targetPath)))],
    };
  });
  const tablePages = new Set(tables.flatMap((t) => t.sourceKeys));

  const included = new Set([...items.map((i) => i.sourceKey), ...eventPages, ...recordPages]);

  // Objects an earlier run of this job created that the plan no longer has (e.g. a meeting whose
  // date was corrected): trash them so they don't linger or hold their slugs. Media stays (WordPress
  // deletes attachments outright rather than trashing them).
  const plannedKeys = new Set([
    ...items.map((i) => i.sourceKey),
    ...events.map((e) => e.key),
    ...people.map((p) => p.key),
    ...recordsPlan.map((r) => r.sourceKey),
    ...tables.map((t) => `table:${t.key}`),
    ...contentTypes.map((c) => `listing:${c.postType}`),
  ]);
  // A page the reviewer switched to a post (or back) is created anew; the earlier object goes too.
  const itemTypes = new Map(items.map((i) => [i.sourceKey, i.type]));
  // Incremental plans leave everything already on the target alone.
  for (const [key, e] of options.incremental ? [] : ours) {
    if (e.job_id !== input.jobId || e.type === 'attachment') continue;
    const switched = itemTypes.has(key) && itemTypes.get(key) !== e.type;
    if (!plannedKeys.has(key) || switched) {
      const entry = { id: e.id, type: e.type, title: e.title, link: e.link };
      if (decisions?.keep.includes(e.id)) keep.push({ ...entry, reason: 'Kept by the reviewer' });
      else cleanup.push({ ...entry, reason: switched ? `now migrated as a ${itemTypes.get(key)}; the earlier ${e.type} goes` : 'created by an earlier run of this job; no longer in the plan' });
    }
  }

  const notMigrated: PlanSkip[] = pages
    .filter((p) => !included.has(p.sourceKey) && !tablePages.has(p.sourceKey))
    .map((p) => ({ sourceKey: p.sourceKey, sourceUrl: p.url, what: p.kind, title: p.title, reason: excludedPages.has(p.sourceKey) ? EXCLUDED : skipReason(p, formsByPage.get(p.sourceKey)) }));

  // Files: only those used by migrated content; identical files (same hash) become one upload.
  // Image files often have no name (BJM serves them from a script), so name them after their alt text.
  const alts = new Map<string, string>();
  for (const p of pages) if (included.has(p.sourceKey)) for (const img of p.images) if (img.alt) alts.set(safeKey(img.src), img.alt);
  const docInfo = new Map((records?.documents ?? []).map((d) => [safeKey(d.url), d]));
  // Files the site structure uses: slide images, and documents that menus, slides and tiles link to.
  const sideNav = options.sideNavMenu && !options.contentOnly;
  const siteFiles = new Set(input.analysis?.site && !options.contentOnly ? siteHrefs(input.analysis.site, sideNav).map(safeKey) : []);
  for (const s of input.analysis?.site?.home.slides ?? []) if (s.image && s.alt) alts.set(safeKey(s.image), s.alt);
  const media: PlanMedia[] = [];
  const byHash = new Map<string, PlanMedia>();
  for (const f of input.files) {
    if (f.status !== 200 || !f.path || !f.sha256) continue;
    const key = sourceKey(f.url);
    const usedBy = f.referencedBy.filter((k) => included.has(k));
    if (siteFiles.has(key)) usedBy.push('site');
    if (includedByReviewer.has(key)) usedBy.push('reviewer');
    if (!usedBy.length || excluded.has(key)) {
      notMigrated.push({
        sourceKey: key,
        sourceUrl: f.url,
        what: isImage(f) ? 'image' : 'document',
        title: f.filename ?? key,
        reason: excluded.has(key) ? EXCLUDED : f.referencedBy.length ? 'File: only used by content not migrated' : 'File: not linked from any page',
      });
      continue;
    }
    const dupe = byHash.get(f.sha256);
    if (dupe) {
      dupe.redirectFrom.push(pathAndQuery(f.url));
      dupe.usedBy = [...new Set([...dupe.usedBy, ...usedBy])];
      continue;
    }
    const doc = docInfo.get(key);
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
      fields: { index_for_library: !isImage(f), publication_date: doc?.date ?? null, library_select: doc?.library ?? null },
      documentType: isImage(f) ? null : (doc?.type ?? null),
      redirectFrom: [pathAndQuery(f.url)],
    };
    byHash.set(f.sha256, item);
    media.push(item);
  }

  // Site settings.
  const settings: PlanSetting[] = [];
  if (options.contentOnly) {
    // No site settings.
  } else if (input.timezone && target.timezone !== input.timezone) {
    settings.push({ key: 'timezone', from: target.timezone || '(UTC offset)', to: input.timezone, reason: 'Event and meeting times are in the organization\'s local time' });
  }
  // The header shows the tagline under the site name (theme change T1). A placeholder one (the seed's,
  // WordPress's default) is cleared; one an editor wrote stays.
  if (input.analysis?.site && !options.contentOnly && PLACEHOLDER_TAGLINES.some((re) => re.test(target.tagline))) {
    settings.push({ key: 'description', from: target.tagline, to: '', reason: 'The header shows the tagline under the site name, and this one is a placeholder' });
  }

  const site = input.analysis?.site && !options.contentOnly
    ? planSite(input.analysis.site, {
        sideNavMenu: sideNav,
        ga4Id: input.ga4Id,
        origin: input.source.origin,
        keep,
        target,
        entries: [
          ...items.map((i) => ({ key: i.sourceKey, path: i.targetPath, from: [pathAndQuery(i.sourceUrl), ...i.redirectFrom] })),
          ...events.map((e) => ({ key: e.key, path: e.targetPath, from: e.redirectFrom })),
          ...recordsPlan.map((r) => ({ key: r.sourceKey, path: r.targetPath, from: [pathAndQuery(r.sourceUrl), ...r.redirectFrom] })),
          ...tables.map((t) => ({ key: `table:${t.key}`, path: t.targetPath, from: t.redirectFrom })),
          ...contentTypes.map((c) => ({ key: `listing:${c.postType}`, path: c.listing.targetPath, from: c.listing.redirectFrom })),
          // Files: the executor links to the uploaded file; until then, the legacy URL (it redirects there).
          ...media.map((m) => ({ key: m.sourceKey, path: m.redirectFrom[0]!, from: m.redirectFrom })),
        ],
        pages,
        existing,
        warnings,
      })
    : null;

  const siteRedirects: Plan['siteRedirects'] = [];
  const newsPage = keep.find((k) => /News listing/.test(k.reason));
  if (newsPage?.link && !options.contentOnly) {
    const newsPath = new URL(newsPage.link, target.url).pathname;
    // Paths with a page of their own stay: migrated ones, and existing target pages that aren't trashed.
    const trashed = new Set(cleanup.map((c) => c.id));
    const existingPaths = existing.filter((e) => !trashed.has(e.id) && e.link).map((e) => new URL(e.link, target.url).pathname);
    const taken = new Set([...items.map((i) => i.targetPath), ...tables.map((t) => t.targetPath), ...contentTypes.map((c) => c.listing.targetPath), ...existingPaths]);
    for (const from of FRAMEWORK_NEWS_PATHS) {
      if (from !== newsPath && !taken.has(from)) siteRedirects.push({ from, to: newsPath, reason: 'The framework links here for "All News"; the News page is elsewhere' });
    }
  }

  // Incremental: everything was planned as usual (so slugs, links and menus agree with what's on the
  // target), and now what's already there comes out of the plan. It stays listed, so new content and
  // menus link to it.
  const alreadyMigrated: PlanExisting[] = [];
  if (options.incremental) {
    const settle = <T>(list: T[], key: (t: T) => string, describe: (t: T) => Omit<PlanExisting, 'key' | 'postType' | 'id' | 'path'> & { path: string }) => {
      const fresh = list.filter((t) => {
        const e = ours.get(key(t));
        if (!e) return true;
        const { path, ...rest } = describe(t);
        alreadyMigrated.push({ key: key(t), postType: e.type, id: e.id, path: targetPath(e, target.url) ?? path, ...rest });
        return false;
      });
      list.splice(0, list.length, ...fresh);
    };
    settle(items, (i) => i.sourceKey, (i) => ({ kind: i.type, path: i.targetPath, from: [pathAndQuery(i.sourceUrl), ...i.redirectFrom] }));
    settle(events, (e) => e.key, (e) => ({ kind: 'event', path: e.targetPath, from: e.redirectFrom }));
    settle(people, (p) => p.key, () => ({ kind: 'person', path: '', from: [] }));
    settle(recordsPlan, (r) => r.sourceKey, (r) => ({ kind: 'record', path: r.targetPath, from: [pathAndQuery(r.sourceUrl), ...r.redirectFrom] }));
    settle(tables, (t) => `table:${t.key}`, (t) => ({ kind: 'page', path: t.targetPath, from: t.redirectFrom }));
    // A custom type's listing page lists its entries; one already on the target isn't rebuilt.
    for (const c of contentTypes) {
      const e = ours.get(`listing:${c.postType}`);
      if (!e) continue;
      alreadyMigrated.push({ key: `listing:${c.postType}`, kind: 'page', postType: e.type, id: e.id, path: targetPath(e, target.url) ?? c.listing.targetPath, from: c.listing.redirectFrom });
      const added = recordsPlan.filter((r) => r.postType === c.postType).length;
      if (added) warnings.push(`${added} new ${c.label.toLowerCase()} entries: the "${c.listing.title}" page already on the target isn't rebuilt, so add them to it by hand.`);
    }
    contentTypes.splice(0, contentTypes.length, ...contentTypes.filter((c) => recordsPlan.some((r) => r.postType === c.postType) || !ours.has(`listing:${c.postType}`)));
    // Files: those already uploaded are linked to; new ones go up only if new content uses them.
    const fresh = new Set([...items.map((i) => i.sourceKey), ...events.flatMap((e) => e.sourceKeys), ...recordsPlan.map((r) => r.sourceKey), ...people.map((p) => p.pageKey), 'site', 'reviewer']);
    let unused = 0;
    settle(media, (m) => m.sourceKey, (m) => ({ kind: m.type, path: m.redirectFrom[0] ?? '', from: m.redirectFrom }));
    media.splice(0, media.length, ...media.filter((m) => m.usedBy.some((k) => fresh.has(k)) || (unused++, false)));
    if (unused) warnings.push(`${unused} files that only content already on the target uses (it changed on the source since) aren't uploaded: incremental runs don't update existing content.`);
    // Forms live on pages; those on pages already migrated are there too.
    planForms.splice(0, planForms.length, ...planForms.filter((f) => fresh.has(f.pageKey)));
    warnings.unshift(
      `Incremental: ${alreadyMigrated.length} objects already on the target are left exactly as they are (changes to them on the source are not copied). Nothing is trashed.`,
      ...(spared.length ? [`Incremental: ${spared.length} items on the target that no migration created (e.g. added by editors) are kept.`] : []),
    );
  }
  if (options.contentOnly) {
    warnings.unshift('Content only: menus, theme options, homepage fields, branding, site settings and framework redirects are left as they are on the target.');
    if (input.timezone && target.timezone !== input.timezone) warnings.push(`Content only: the target's timezone (${target.timezone || 'UTC offset'}) isn't changed to ${input.timezone}; event times are read in the target's timezone.`);
    if (options.sideNavMenu) warnings.push('"Side navigation in the main menu" has no effect with "Content only": menus are left as they are.');
  }

  const categories = [...new Set(items.flatMap((i) => i.categories))].sort();
  const eventCategories = [...new Set(events.map((e) => e.category))].sort();
  const documentTypes = [...new Set(media.map((m) => m.documentType).filter((t): t is string => !!t))].sort();
  const redirectSources = [...items, ...media, ...events, ...recordsPlan, ...tables, ...contentTypes.map((c) => c.listing)];
  const redirects = redirectSources.reduce((n, i) => n + i.redirectFrom.length, 0) + siteRedirects.length;

  const deferredLinks = items.filter((i) => i.warnings.some((w) => /not migrated/i.test(w))).length;
  if (deferredLinks) warnings.push(`${deferredLinks} migrated pages mention content that isn't migrated.`);
  const low = events.filter((e) => e.confidence === 'low').length;
  if (low) warnings.push(`${low} meetings were placed with low confidence: check their dates and kinds.`);
  if (unresolvedMeetings.size) warnings.push(`${unresolvedMeetings.size} meeting pages could not be placed and are migrated as pages: review them.`);
  for (const f of planForms) if (f.sensitive.length || f.action === 'flag') warnings.push(`Form "${f.title}": ${f.reason}`);
  if (!target.redirection) warnings.push('Redirection is not active on the target: redirects are written to redirects.csv only.');
  if (decisions) warnings.push(...staleDecisions(decisions, input, cleanup, keep));
  const design = input.brand && !options.contentOnly ? planDesign(input.brand) : null;
  if (design) warnings.push(...design.warnings);

  return Plan.parse({
    schema: 'website-mover/plan@1',
    jobId: input.jobId,
    version: input.version,
    createdAt: new Date().toISOString(),
    source: input.source,
    inputs: { ...input.inputs, brandSha256: input.brand?.sha256 ?? null },
    target,
    items,
    media,
    categories,
    events,
    eventCategories,
    people,
    forms: planForms,
    contentTypes,
    records: recordsPlan,
    tables,
    documentTypes,
    settings,
    site,
    design: options.contentOnly ? null : (design?.design ?? null),
    decisions: decisions ?? null,
    options,
    alreadyMigrated,
    siteRedirects,
    cleanup,
    keep,
    notMigrated,
    expected: {
      pages: items.filter((i) => i.type === 'page').length + tables.length + contentTypes.length,
      posts: items.filter((i) => i.type === 'post').length,
      documents: media.filter((m) => m.type === 'document').length,
      images: media.filter((m) => m.type === 'image').length,
      categories: categories.length,
      redirects,
      cleanup: cleanup.length,
      events: events.length,
      people: people.length,
      forms: planForms.filter((f) => f.action === 'rebuild').length,
      records: recordsPlan.length,
      tables: tables.length,
    },
    warnings,
  });
}

/** The framework's named menus and the source menus that feed them. */
const MENUS: [name: string, from: keyof SiteAnalysis['menus']][] = [
  ['Main Menu', 'main'],
  ['Top Menu', 'top'],
  ['Footer Menu', 'footer'],
  ['Social Menu', 'social'],
  ['Explore Menu', 'explore'],
  // Links with the footer's contact details (e.g. a staff login); theme change T19.
  ['Footer Contact Menu', 'contact'],
];

/** The theme's notice icons (its `footer_notice_icons` choices), by the source image's alt text. */
const NOTICE_ICONS: [RegExp, string][] = [
  [/equal housing/i, 'equal_housing'],
  [/handicap|wheelchair|accessible\b/i, 'accessible'],
  [/accessibility|universal access/i, 'universal_access'],
];

interface SiteContext {
  /** Add the source's side navigation to the main menu as dropdowns. */
  sideNavMenu?: boolean;
  ga4Id?: string;
  origin: string;
  keep: Plan['keep'];
  target: TargetInfo;
  entries: { key: string; path: string; from: string[] }[];
  pages: ExtractedPage[];
  existing: TargetEntity[];
  warnings: string[];
}

/** Menus, footer options, homepage fields and the site title from the source's shared structure. */
function planSite(site: SiteAnalysis, ctx: SiteContext): PlanSite {
  const byKey = new Map<string, { key: string | null; path: string }>();
  for (const e of ctx.entries) for (const from of e.from) byKey.set(safeKey(new URL(from, ctx.origin).href), { key: e.key, path: e.path });
  // Listings the framework replaces with its own pages.
  const newsPage = ctx.keep.find((k) => /News listing/.test(k.reason));
  const replacements: [RegExp, string | null][] = [
    [/^\/$/, '/'],
    [/^\/(news|press_full_list\.php)$/, newsPage ? new URL(newsPage.link).pathname : null],
    [/^\/calendar$/, ctx.target.reservedSlugs.includes('event') ? '/events/' : null],
  ];
  const resolve = (href: string): { key: string | null; url: string } | null => {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.hostname.replace(/^www\./, '') !== new URL(ctx.origin).hostname.replace(/^www\./, '')) return { key: null, url: href };
    const hit = byKey.get(safeKey(href));
    if (hit) return { key: hit.key, url: hit.path + url.hash };
    for (const [re, to] of replacements) if (re.test(url.pathname.toLowerCase()) && to) return { key: null, url: to };
    return null;
  };

  const dropped: string[] = [];
  const headings: string[] = [];
  let main = site.menus.main;
  if (ctx.sideNavMenu) {
    if (!site.sectionNav) ctx.warnings.push('Side navigation in the main menu: this analysis predates side navigation. Run "Analyze → plan" (or "Scan → plan") to read it.');
    else if (!site.sectionNav.length) ctx.warnings.push('Side navigation in the main menu: the source pages show no side navigation the tool can read.');
    else main = withSectionNav(main, site.sectionNav, ctx.warnings);
  }
  // Every framework menu is planned, empty ones included, so none keeps the seed's demo links.
  const menus = MENUS.map(([name, from]) => {
    const items: PlanMenuItem[] = [];
    const add = (link: NavLink, parent: number | null) => {
      let target = resolve(link.href);
      if (!target) {
        // A dropdown parent without a migrated page of its own stays as a heading, so its children aren't lost.
        if (!link.children?.some((c) => resolve(c.href))) {
          dropped.push(`${name}: "${link.label}" (${link.href || 'no link'})`);
          return;
        }
        if (link.href) headings.push(`${name}: "${link.label}" (${link.href})`);
        target = { key: null, url: '#' };
      }
      items.push({ title: link.label, sourceUrl: link.href, key: target.key, url: target.url, parent });
      const index = items.length - 1;
      for (const child of link.children ?? []) add(child, index);
    };
    // `contact` is newer than the first M3 analyses.
    for (const link of (from === 'main' ? main : site.menus[from]) ?? []) add(link, null);
    return { name, items };
  });
  if (dropped.length) ctx.warnings.push(`Menu links to content that isn't migrated were left out: ${dropped.join('; ')}`);
  if (headings.length) ctx.warnings.push(`Dropdown parents whose own page isn't migrated are kept as headings without a link: ${headings.join('; ')}`);

  // Footer contact. Where the source has no value, the seed's placeholder (and its heading and
  // icon, which the footer would still show) is cleared. The seed's address heading ("City Hall")
  // is a demo label, so it's cleared either way.
  const options: Record<string, string | string[]> = { footer_address_heading: '' };
  for (const [field, value] of [['address', site.contact.address], ['phone', site.contact.phone], ['email', site.contact.email], ['fax', site.contact.fax]] as const) {
    options[`footer_${field}`] = value ?? '';
    if (!value) Object.assign(options, { [`footer_${field}_heading`]: '', [`footer_${field}_icon`]: '' });
  }
  // Office hours and footer notices (theme change T8), and GA4 (T13). On a seed without the theme
  // changes the executor reports the fields as missing.
  options.footer_hours = site.contact.hours ?? '';
  // One paragraph per notice: the field turns blank lines into paragraphs.
  options.footer_notices = site.footerNotices.join('\n\n');
  if (ctx.ga4Id) options.ga4_measurement_id = ctx.ga4Id;
  // The footer's links band heading and the icons beside the notices (theme change T19); newer than
  // the first M3 analyses.
  if (site.exploreHeading !== undefined) options.footer_links_heading = site.exploreHeading ?? '';
  if (site.footerIcons) {
    const icons = site.footerIcons.map((alt) => ({ alt, choice: NOTICE_ICONS.find(([re]) => re.test(alt))?.[1] }));
    const unknown = icons.filter((i) => !i.choice).map((i) => `"${i.alt}"`);
    if (unknown.length) ctx.warnings.push(`Footer icons the theme has no match for: ${unknown.join(', ')}: left out.`);
    options.footer_notice_icons = [...new Set(icons.flatMap((i) => (i.choice ? [i.choice] : [])))];
  }

  const banner = site.home.slides.map((s) => {
    const target = s.link ? resolve(s.link) : null;
    return { title: s.title, image: s.image, linkUrl: target?.url ?? null, linkKey: target?.key ?? null, linkTitle: s.subtitle };
  });
  // `buttons` is newer than the first M3 analyses.
  const quickLinks = (site.home.buttons ?? []).flatMap((b) => {
    const target = resolve(b.href);
    if (!target) ctx.warnings.push(`Homepage link "${b.label}" (${b.href}) points to content that isn't migrated: left out.`);
    return target ? [{ title: b.label, url: target.url, key: target.key }] : [];
  });
  // Kept framework pages (the News page): their template's text fields are the seed's demo content.
  const clearPages = ctx.existing
    .filter((e) => e.template && KEEP_TEMPLATES[e.template] && ctx.keep.some((k) => k.id === e.id))
    .map((e) => ({ pageId: e.id, template: e.template!, title: e.title }));
  return { title: site.siteName, menus, options, home: { banner, quickLinks, intro: site.home.intro ?? null, clearOthers: true }, clearPages };
}

/** Decisions that no longer match anything the job has (the source or the analysis changed). */
function staleDecisions(d: ReviewDecisions, input: BuildPlanInput, cleanup: PlanCleanup[], keep: Plan['keep']): string[] {
  const known = new Set([
    ...input.pages.map((p) => p.sourceKey),
    ...input.files.map((f) => sourceKey(f.url)),
    ...(input.analysis?.meetings?.meetings ?? []).map((m) => m.key),
    ...(input.analysis?.records?.people ?? []).map((p) => p.key),
    ...(input.analysis?.records?.tables ?? []).map((t) => `table:${t.key}`),
  ]);
  const ids = new Set([...cleanup, ...keep].map((e) => e.id));
  const stale = [
    ...[...d.exclude, ...d.include, ...Object.keys(d.type), ...Object.keys(d.slug)].filter((k) => !known.has(k)),
    ...d.keep.filter((id) => !ids.has(id)).map((id) => `#${id}`),
  ];
  return stale.length ? [`Reviewer decisions that no longer match anything (ignored): ${[...new Set(stale)].join(', ')}`] : [];
}

/** Main menu depth with the side navigation added: top level plus two dropdown levels. */
export const SIDE_NAV_MAX_DEPTH = 3;

/**
 * The main menu with the source's side navigation added as dropdowns. Breadth first from the menu as
 * it is: each item gets the links its section's side menu lists, down to SIDE_NAV_MAX_DEPTH levels. A page
 * appears once: links already in the menu (e.g. a section the side menu lists under "About Us" but the
 * main menu has at the top level) aren't added again, and the shallowest place wins.
 */
export function withSectionNav(main: NavLink[], sections: NonNullable<SiteAnalysis['sectionNav']>, warnings: string[] = []): NavLink[] {
  const key = (href: string) => (href ? safeKey(href) : '');
  const childrenOf = new Map(sections.map((s) => [key(s.parent.href), s.children]));
  const clone = (l: NavLink): NavLink => ({ label: l.label, href: l.href, ...(l.children ? { children: l.children.map(clone) } : {}) });
  const menu = main.map(clone);
  const seen = new Set<string>();
  const mark = (links: NavLink[]) => links.forEach((l) => (l.href && seen.add(key(l.href)), mark(l.children ?? [])));
  mark(menu);
  let added = 0;
  const tooDeep: string[] = [];
  for (let level: { link: NavLink; depth: number }[] = menu.map((link) => ({ link, depth: 1 })); level.length; ) {
    const next: typeof level = [];
    for (const { link, depth } of level) {
      for (const child of link.children ?? []) next.push({ link: child, depth: depth + 1 });
      const kids = link.href ? childrenOf.get(key(link.href)) ?? [] : [];
      for (const kid of kids) {
        const k = key(kid.href);
        if (!k || seen.has(k)) continue;
        if (depth >= SIDE_NAV_MAX_DEPTH) {
          tooDeep.push(`"${kid.label}" (under "${link.label}")`);
          continue;
        }
        seen.add(k);
        const item: NavLink = { label: kid.label, href: kid.href };
        (link.children ??= []).push(item);
        next.push({ link: item, depth: depth + 1 });
        added++;
      }
    }
    level = next;
  }
  warnings.push(`Side navigation in the main menu: ${added} links added as dropdowns.`);
  if (tooDeep.length) warnings.push(`Side navigation links below the main menu's ${SIDE_NAV_MAX_DEPTH} levels are left out: ${[...new Set(tooDeep)].join('; ')}`);
  return menu;
}

/** Every URL the site structure points at: menu links (with the side navigation, when it's added), slide images and links, homepage tiles. */
function siteHrefs(site: SiteAnalysis, sideNav = false): string[] {
  const walk = (links: NavLink[]): string[] => links.flatMap((l) => [l.href, ...walk(l.children ?? [])]);
  return [
    ...Object.values(site.menus).flatMap(walk),
    ...(sideNav ? (site.sectionNav ?? []).flatMap((s) => [s.parent.href, ...walk(s.children)]) : []),
    ...site.home.slides.flatMap((s) => [s.image ?? '', s.link ?? '']),
    ...walk(site.home.buttons ?? []),
  ].filter(Boolean);
}

/** Entries of forms with sensitive fields are deleted after this many days. */
const SENSITIVE_RETENTION_DAYS = 30;

function skipReason(p: ExtractedPage, forms: FormRecord[] | undefined): string {
  if (forms?.some((f) => f.kind === 'subscription')) return 'Alerts sign-up: a subscription service, not rebuilt (needs a tool)';
  if (forms?.some((f) => f.kind === 'login')) return 'Staff login: never migrated';
  return NOT_MIGRATED[p.kind] ?? p.kind;
}

/** ACF field name for a source label: "Office Phone" → "office_phone". */
function fieldName(label: string): string {
  return wpSlug(label, 60).replace(/-/g, '_') || 'field';
}

/** "<alt-text-slug>.<ext>", else "<last path part>-<id>.<ext>". */
function fallbackName(key: string, alt: string | undefined, contentType: string): string {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp', 'application/pdf': 'pdf' }[contentType] ?? 'bin';
  const base = (alt && wpSlug(alt, 60)) || wpSlug(key.split('/').pop()!.replace(/\.\w+(?=\?|$)/, '').replace(/[?&=]/g, '-'), 60);
  return `${base}.${ext}`;
}

/** Root-relative URL of an object on the target, from its permalink. */
function targetPath(e: TargetEntity, base: string): string | null {
  if (!e.link) return null;
  try {
    return new URL(e.link, base).pathname;
  } catch {
    return null;
  }
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
