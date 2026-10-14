import type { ExtractedPage, FormAnalysis, FormRecord, MeetingAnalysis, RecordAnalysis, SnapshotFile, SnapshotPage } from '@wm/core';
import { sourceKey } from '@wm/core';
import {
  Plan,
  type PlanCleanup,
  type PlanContentType,
  type PlanEvent,
  type PlanForm,
  type PlanItem,
  type PlanMedia,
  type PlanPerson,
  type PlanRecord,
  type PlanSetting,
  type PlanSkip,
  type PlanTable,
  type TargetInfo,
} from './schema.js';
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
  analysis?: { meetings?: MeetingAnalysis; forms?: FormAnalysis; records?: RecordAnalysis };
  /** Site timezone the target should have (IANA name). */
  timezone?: string;
}

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

/** WordPress paths a page slug must not take. */
const WP_RESERVED = [
  'wp-admin', 'wp-content', 'wp-includes', 'wp-json', 'wp-login', 'wp-sitemap', 'feed', 'embed',
  'page', 'comments', 'attachment', 'search', 'author', 'category', 'tag', 'trackback', 'robots', 'sitemap',
];

export function buildPlan(input: BuildPlanInput): Plan {
  const { pages, target, existing } = input;
  const meetings = input.analysis?.meetings;
  const forms = input.analysis?.forms;
  const records = input.analysis?.records;
  const warnings: string[] = [];
  const pageByKey = new Map(pages.map((p) => [p.sourceKey, p]));

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

  // Custom types this plan creates (their URL bases are ours, not reserved by something else).
  const communities = (records?.communities ?? []).filter((c) => pageByKey.has(c.sourceKey));
  const contentTypes: PlanContentType[] = [];
  const ownBases = new Set(communities.length ? ['communities'] : []);

  const keptSlugs = existing.filter((e) => keep.some((k) => k.id === e.id)).map((e) => e.slug);
  // Old single-segment URLs that will redirect somewhere else (meeting pages merged into events,
  // community pages, table sources) must not be handed out as new slugs: the redirect would win.
  const movedAway = new Set([
    ...(meetings?.meetings ?? []).flatMap((m) => m.sourceKeys),
    ...communities.map((c) => c.sourceKey),
    ...(records?.tables ?? []).flatMap((t) => t.sourceKeys),
  ]);
  const movedAwaySlugs = [...movedAway]
    .map((k) => pageByKey.get(k))
    .map((p) => (p && !new URL(p.url).search ? new URL(p.url).pathname.toLowerCase().replace(/^\/|\/$/g, '') : ''))
    .filter((s) => s && !s.includes('/'));
  const slugs = new SlugRegistry([...WP_RESERVED, ...target.reservedSlugs.filter((s) => !ownBases.has(s)), ...keptSlugs, ...movedAwaySlugs]);
  const claim = (key: string, preferred: string, registry = slugs) => registry.claim(ours.get(key)?.slug || preferred);

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
    p.kind === 'page' ||
    p.kind === 'post' ||
    (p.kind === 'meeting' && (indexPages.has(p.sourceKey) || unresolvedMeetings.has(p.sourceKey))) ||
    (p.kind === 'utility' && rebuiltForms(p.sourceKey).length > 0);

  // Pages with a source slug first, so they keep their URL; then id-only pages; then posts.
  const migrated = pages.filter(asItem);
  const order = (p: ExtractedPage) => (p.kind === 'post' ? 2 : p.slug ? 0 : 1);
  migrated.sort((a, b) => order(a) - order(b) || a.sourceKey.localeCompare(b.sourceKey));

  const items: PlanItem[] = [];
  for (const page of migrated) {
    const slug = claim(page.sourceKey, wpSlug(page.slug ?? page.title));
    const targetPath = `/${slug}/`;
    const itemWarnings = [...page.warnings];
    if (page.kind === 'post' && page.date && new Date(`${page.date}T00:00:00`) > new Date()) {
      itemWarnings.push(`future-date: source date ${page.date} is in the future; published with the migration date`);
    }
    if (unresolvedMeetings.has(page.sourceKey)) itemWarnings.push('needs-review: meeting page the rules could not place; migrated as a page');
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
      redirectFrom: redirectsFor(page.sourceKey, targetPath),
      forms: rebuiltForms(page.sourceKey).map((f) => f.key),
      warnings: itemWarnings,
    });
  }

  // Events: one per meeting (The Events Calendar, single URLs under /event/).
  const eventSlugs = new SlugRegistry([]);
  const events: PlanEvent[] = (meetings?.meetings ?? []).map((m) => {
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
  const people: PlanPerson[] = (records?.people ?? []).map((p) => ({
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
  const tables: PlanTable[] = (records?.tables ?? []).map((t) => {
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
  for (const [key, e] of ours) {
    if (e.job_id === input.jobId && e.type !== 'attachment' && !plannedKeys.has(key)) {
      cleanup.push({ id: e.id, type: e.type, title: e.title, link: e.link, reason: 'created by an earlier run of this job; no longer in the plan' });
    }
  }

  const notMigrated: PlanSkip[] = pages
    .filter((p) => !included.has(p.sourceKey) && !tablePages.has(p.sourceKey))
    .map((p) => ({ sourceKey: p.sourceKey, sourceUrl: p.url, what: p.kind, title: p.title, reason: skipReason(p, formsByPage.get(p.sourceKey)) }));

  // Files: only those used by migrated content; identical files (same hash) become one upload.
  // Image files often have no name (BJM serves them from a script), so name them after their alt text.
  const alts = new Map<string, string>();
  for (const p of pages) if (included.has(p.sourceKey)) for (const img of p.images) if (img.alt) alts.set(safeKey(img.src), img.alt);
  const docInfo = new Map((records?.documents ?? []).map((d) => [safeKey(d.url), d]));
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
        reason: f.referencedBy.length ? 'File: only used by content not migrated' : 'File: not linked from any page',
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
  if (input.timezone && target.timezone !== input.timezone) {
    settings.push({ key: 'timezone', from: target.timezone || '(UTC offset)', to: input.timezone, reason: 'Event and meeting times are in the organization\'s local time' });
  }

  const categories = [...new Set(items.flatMap((i) => i.categories))].sort();
  const eventCategories = [...new Set(events.map((e) => e.category))].sort();
  const documentTypes = [...new Set(media.map((m) => m.documentType).filter((t): t is string => !!t))].sort();
  const redirectSources = [...items, ...media, ...events, ...recordsPlan, ...tables, ...contentTypes.map((c) => c.listing)];
  const redirects = redirectSources.reduce((n, i) => n + i.redirectFrom.length, 0);

  const deferredLinks = items.filter((i) => i.warnings.some((w) => /not migrated/i.test(w))).length;
  if (deferredLinks) warnings.push(`${deferredLinks} migrated pages mention content that isn't migrated.`);
  const low = events.filter((e) => e.confidence === 'low').length;
  if (low) warnings.push(`${low} meetings were placed with low confidence: check their dates and kinds.`);
  if (unresolvedMeetings.size) warnings.push(`${unresolvedMeetings.size} meeting pages could not be placed and are migrated as pages: review them.`);
  for (const f of planForms) if (f.sensitive.length || f.action === 'flag') warnings.push(`Form "${f.title}": ${f.reason}`);
  if (!target.redirection) warnings.push('Redirection is not active on the target: redirects are written to redirects.csv only.');

  return Plan.parse({
    schema: 'website-mover/plan@1',
    jobId: input.jobId,
    version: input.version,
    createdAt: new Date().toISOString(),
    source: input.source,
    inputs: input.inputs,
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
