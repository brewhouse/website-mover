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
  fields: z.object({ index_for_library: z.boolean(), publication_date: z.string().nullable() }),
  redirectFrom: z.array(z.string()),
});
export type PlanMedia = z.infer<typeof PlanMedia>;

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
});
export type TargetInfo = z.infer<typeof TargetInfo>;

export const Plan = z.object({
  schema: z.literal('website-mover/plan@1'),
  jobId: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  source: z.object({ origin: z.string(), profile: z.string() }),
  /** sha256 of extract/pages.jsonl: execution refuses content other than what was planned and approved. */
  inputs: z.object({ extractSha256: z.string() }),
  target: TargetInfo,
  items: z.array(PlanItem),
  media: z.array(PlanMedia),
  categories: z.array(z.string()),
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
