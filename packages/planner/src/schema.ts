import { z } from 'zod';

/** A source page that becomes a WordPress page or post. */
export const PlanItem = z.object({
  sourceKey: z.string(),
  sourceUrl: z.string(),
  type: z.enum(['page', 'post']),
  title: z.string(),
  slug: z.string(),
  /** Root-relative URL it will have on the target (permalinks /%postname%/). */
  targetPath: z.string(),
  date: z.string().nullable(),
  categories: z.array(z.string()),
  /** Section parent on the source; pages stay flat, so this feeds menus/breadcrumbs later. */
  parentKey: z.string().nullable(),
  /** Source URLs (path + query) that must 301 here because the URL changes. */
  redirectFrom: z.array(z.string()),
  /** Forms (FormRecord keys) rebuilt in the forms plugin and placed where the source form was. */
  forms: z.array(z.string()).default([]),
  warnings: z.array(z.string()),
});
export type PlanItem = z.infer<typeof PlanItem>;

/** A source file that goes into the media library. */
export const PlanMedia = z.object({
  sourceKey: z.string(),
  sourceUrl: z.string(),
  type: z.enum(['document', 'image']),
  filename: z.string(),
  contentType: z.string(),
  bytes: z.number(),
  sha256: z.string(),
  /** Snapshot path of the file body, relative to the job directory. */
  path: z.string(),
  usedBy: z.array(z.string()),
  /** Values for the seed's "Media Library" field group. */
  fields: z.object({
    index_for_library: z.boolean(),
    publication_date: z.string().nullable(),
    /** The seed's library_select choice. */
    library_select: z.string().nullable().default(null),
  }),
  /** resource_type term (Document Directory). */
  documentType: z.string().nullable().default(null),
  redirectFrom: z.array(z.string()),
});
export type PlanMedia = z.infer<typeof PlanMedia>;

/** A meeting or event: an Events Calendar event (M2). */
export const PlanEvent = z.object({
  /** MeetingRecord key; also the event's `_wm_source_key`. */
  key: z.string(),
  title: z.string(),
  slug: z.string(),
  targetPath: z.string(),
  date: z.string(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  category: z.string(),
  kind: z.string(),
  location: z.string().nullable(),
  cancelled: z.boolean(),
  /** Merged source pages (first = primary); all redirect here. */
  sourceKeys: z.array(z.string()),
  newsKeys: z.array(z.string()),
  documents: z.array(z.object({ url: z.string(), text: z.string(), role: z.string() })),
  recordings: z.array(z.string()),
  redirectFrom: z.array(z.string()),
  confidence: z.enum(['high', 'low']),
  warnings: z.array(z.string()),
});
export type PlanEvent = z.infer<typeof PlanEvent>;

/** A person (board member, staff): the seed's `people` type. */
export const PlanPerson = z.object({
  key: z.string(),
  pageKey: z.string(),
  group: z.enum(['board', 'staff']),
  name: z.string(),
  slug: z.string(),
  role: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /** Source URL of the photo (a planned media entry). */
  photo: z.string().nullable(),
  bio: z.string().nullable(),
  order: z.number(),
});
export type PlanPerson = z.infer<typeof PlanPerson>;

/** A web form rebuilt in the forms plugin (or flagged). */
export const PlanForm = z.object({
  key: z.string(),
  pageKey: z.string(),
  action: z.enum(['rebuild', 'flag']),
  title: z.string(),
  description: z.string().nullable(),
  fields: z.array(z.record(z.string(), z.unknown())),
  sensitive: z.array(z.string()),
  /** Entries deleted after this many days (forms with sensitive fields). */
  retentionDays: z.number().nullable(),
  uploads: z.boolean(),
  /** Add the forms plugin's CAPTCHA (the source form had one). */
  captcha: z.boolean().default(false),
  reason: z.string(),
});
export type PlanForm = z.infer<typeof PlanForm>;

/** An entry of a custom type the tool creates (M2: communities). */
export const PlanRecord = z.object({
  sourceKey: z.string(),
  sourceUrl: z.string(),
  postType: z.string(),
  title: z.string(),
  slug: z.string(),
  targetPath: z.string(),
  /** ACF values, keyed by field name. */
  fields: z.record(z.string(), z.string()),
  term: z.string().nullable(),
  photo: z.string().nullable(),
  redirectFrom: z.array(z.string()),
});
export type PlanRecord = z.infer<typeof PlanRecord>;

/** A custom post type + taxonomy + field group the bridge creates through ACF. */
export const PlanContentType = z.object({
  postType: z.string(),
  label: z.string(),
  singular: z.string(),
  rewriteSlug: z.string(),
  taxonomy: z.object({ name: z.string(), label: z.string(), singular: z.string() }).nullable(),
  /** field name → label (verbatim source label). */
  fields: z.record(z.string(), z.string()),
  /** Listing page for the type (title, slug, path) and the source URLs redirected to it. */
  listing: z.object({ title: z.string(), slug: z.string(), targetPath: z.string(), redirectFrom: z.array(z.string()) }),
});
export type PlanContentType = z.infer<typeof PlanContentType>;

/** A page holding a table assembled from many source pages. */
export const PlanTable = z.object({
  key: z.string(),
  title: z.string(),
  slug: z.string(),
  targetPath: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  notes: z.array(z.string()),
  sourceKeys: z.array(z.string()),
  redirectFrom: z.array(z.string()),
});
export type PlanTable = z.infer<typeof PlanTable>;

/** A menu item. `key` is the planned entry it points at (so the menu links to the object, not a URL); else `url`. */
export const PlanMenuItem = z.object({
  title: z.string(),
  sourceUrl: z.string(),
  key: z.string().nullable(),
  url: z.string(),
  /** Index of the parent item in the same menu. */
  parent: z.number().nullable(),
});
export type PlanMenuItem = z.infer<typeof PlanMenuItem>;

/** Site-wide structure (M3): named menus, theme options, homepage fields, site title. */
export const PlanSite = z.object({
  title: z.string().nullable(),
  /** The framework's named menus ("Main Menu", "Top Menu", ...), replaced as a whole. */
  menus: z.array(z.object({ name: z.string(), items: z.array(PlanMenuItem) })),
  /** Theme option fields (ACF options pages) → value. Empty string clears a placeholder. */
  options: z.record(z.string(), z.string()),
  /** Homepage template fields. */
  home: z.object({
    banner: z.array(z.object({ title: z.string(), image: z.string().nullable(), linkUrl: z.string().nullable(), linkKey: z.string().nullable(), linkTitle: z.string().nullable() })),
    /** Link tiles under the slideshow (the homepage template's `banner_icon`). */
    quickLinks: z.array(z.object({ title: z.string(), url: z.string(), key: z.string().nullable() })).default([]),
    /** Clear the homepage template's other fields (the seed's demo placeholders). */
    clearOthers: z.boolean().default(false),
  }),
});
export type PlanSite = z.infer<typeof PlanSite>;

/** A site setting the plan changes (shown with its current value for review). */
export const PlanSetting = z.object({ key: z.string(), from: z.string(), to: z.string(), reason: z.string() });
export type PlanSetting = z.infer<typeof PlanSetting>;

/** Source content this plan leaves out, and why. */
export const PlanSkip = z.object({
  sourceKey: z.string(),
  sourceUrl: z.string(),
  what: z.string(),
  title: z.string(),
  reason: z.string(),
});
export type PlanSkip = z.infer<typeof PlanSkip>;

/** Existing target content that execution moves to the trash. */
export const PlanCleanup = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string(),
  link: z.string(),
  /** Why it goes (default: seed demo content). */
  reason: z.string().optional(),
});
export type PlanCleanup = z.infer<typeof PlanCleanup>;

export const TargetInfo = z.object({
  name: z.enum(['local', 'seed']),
  url: z.string(),
  wordpress: z.string(),
  theme: z.string(),
  permalinks: z.string(),
  disabledBlocks: z.array(z.string()),
  reservedSlugs: z.array(z.string()),
  redirection: z.boolean(),
  timezone: z.string().default(''),
});
export type TargetInfo = z.infer<typeof TargetInfo>;

export const Plan = z.object({
  schema: z.literal('website-mover/plan@1'),
  jobId: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  source: z.object({ origin: z.string(), profile: z.string() }),
  /** sha256 of extract/pages.jsonl: execution refuses content other than what was planned and approved. */
  inputs: z.object({ extractSha256: z.string(), analysisSha256: z.record(z.string(), z.string()).default({}) }),
  target: TargetInfo,
  items: z.array(PlanItem),
  media: z.array(PlanMedia),
  categories: z.array(z.string()),
  events: z.array(PlanEvent).default([]),
  eventCategories: z.array(z.string()).default([]),
  people: z.array(PlanPerson).default([]),
  forms: z.array(PlanForm).default([]),
  contentTypes: z.array(PlanContentType).default([]),
  records: z.array(PlanRecord).default([]),
  tables: z.array(PlanTable).default([]),
  documentTypes: z.array(z.string()).default([]),
  settings: z.array(PlanSetting).default([]),
  site: PlanSite.nullable().default(null),
  cleanup: z.array(PlanCleanup),
  /** Existing target content that is kept (framework pages the migration reuses). */
  keep: z.array(PlanCleanup.extend({ reason: z.string() })),
  notMigrated: z.array(PlanSkip),
  expected: z.object({
    pages: z.number(),
    posts: z.number(),
    documents: z.number(),
    images: z.number(),
    categories: z.number(),
    redirects: z.number(),
    cleanup: z.number(),
    events: z.number().default(0),
    people: z.number().default(0),
    forms: z.number().default(0),
    records: z.number().default(0),
    tables: z.number().default(0),
  }),
  warnings: z.array(z.string()),
});
export type Plan = z.infer<typeof Plan>;

export const Approval = z.object({
  jobId: z.string(),
  planVersion: z.number(),
  planSha256: z.string(),
  approvedBy: z.string(),
  approvedAt: z.string(),
});
export type Approval = z.infer<typeof Approval>;
