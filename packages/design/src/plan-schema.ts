/**
 * The design plan (docs/build/PLAN.md "Flow" 4): what the build will create on the target and in the
 * theme, for a person to approve. Versioned and hashed like the migration plan; execution follows
 * only an approved plan.
 */
import { z } from 'zod';

/** ACF field types the build writes. */
export const FieldType = z.enum(['text', 'textarea', 'wysiwyg', 'image', 'file', 'link', 'url', 'email', 'date_picker', 'date_time_picker', 'number', 'true_false', 'select', 'repeater', 'gallery', 'post_object', 'relationship', 'taxonomy']);
export type FieldType = z.infer<typeof FieldType>;

/** Where a value lives when it isn't an ACF field: WordPress's own fields. */
export const CoreField = z.enum(['title', 'content', 'excerpt', 'featured_image', 'date', 'author', 'term', 'permalink', 'derived']);
export type CoreField = z.infer<typeof CoreField>;

/**
 * How a part of a page gets its content:
 *   theme     markup in the template, nothing to edit (search box, pagination)
 *   core      WordPress's own fields (title, content, breadcrumb from the page tree)
 *   fields    ACF fields on the page's object (the page, or the entry on a single template)
 *   repeater  an ACF repeater on the page's object
 *   query     entries of a post type (newest first, or picked on the page)
 *   filter    terms of a taxonomy, as filter links
 *   block     an ACF block (the page-builder pages)
 *   menu      a WordPress menu
 */
export const Binding = z.enum(['theme', 'core', 'fields', 'repeater', 'query', 'filter', 'block', 'menu']);
export type Binding = z.infer<typeof Binding>;

export const PageKind = z.enum(['front-page', 'page', 'page-template', 'single', 'archive', 'search', '404', '403']);
export type PageKind = z.infer<typeof PageKind>;

/** Where a label came from: every label must be in the mockups or already on the target. */
export const LabelSource = z.enum(['mockup-text', 'figma', 'class-name', 'existing']);

const fieldBase = {
  key: z.string(),
  name: z.string(),
  label: z.string(),
  type: FieldType,
  /** reuse: already on the target with this key; add: new. */
  action: z.enum(['reuse', 'add']),
  labelFrom: LabelSource,
  /** Where the mockup shows it: page, component and value path. */
  source: z.object({ page: z.string(), component: z.string(), path: z.string() }).nullable(),
  sample: z.string().nullable(),
};
export const PlanSubField = z.object(fieldBase);
export const PlanField = z.object({ ...fieldBase, subFields: z.array(PlanSubField).default([]) });
export type PlanField = z.infer<typeof PlanField>;

export const PlanFieldGroup = z.object({
  key: z.string(),
  title: z.string(),
  /** reuse: unchanged; extend: existing group with fields added; create: new group. */
  action: z.enum(['reuse', 'extend', 'create']),
  /** ACF location rule, e.g. post_type == departments, page_template == template-home.php, block == acf/staff. */
  location: z.object({ param: z.string(), value: z.string() }),
  fields: z.array(PlanField),
});
export type PlanFieldGroup = z.infer<typeof PlanFieldGroup>;

export const PlanPostType = z.object({
  name: z.string(),
  label: z.string(),
  singular: z.string(),
  action: z.enum(['reuse', 'create']),
  hasArchive: z.boolean(),
  taxonomies: z.array(z.string()),
  /** Mockup pages and components that show it. */
  from: z.array(z.string()),
});
export type PlanPostType = z.infer<typeof PlanPostType>;

export const PlanTaxonomy = z.object({
  name: z.string(),
  label: z.string(),
  postTypes: z.array(z.string()),
  action: z.enum(['reuse', 'create']),
  /** Terms shown in the mockups' filter lists, word for word. */
  terms: z.array(z.string()),
  from: z.array(z.string()),
});
export type PlanTaxonomy = z.infer<typeof PlanTaxonomy>;

export const PlanBlock = z.object({
  /** ACF block name without the "acf/" prefix, e.g. "angled-clickable-image". */
  name: z.string(),
  title: z.string(),
  /** reuse: as it is; update: the template is restyled (and fields may be added); create: new block. */
  action: z.enum(['reuse', 'update', 'create']),
  template: z.string(),
  fieldGroup: z.string(),
  from: z.object({ page: z.string(), component: z.string() }),
});
export type PlanBlock = z.infer<typeof PlanBlock>;

export const PlanPart = z.object({
  component: z.string(),
  /** Section path from the content root. */
  path: z.string(),
  /** A list inside the section (path from the section), or null for the section's own values. */
  collection: z.string().nullable(),
  heading: z.string().nullable(),
  binding: Binding,
  postType: z.string().nullable(),
  taxonomy: z.string().nullable(),
  block: z.string().nullable(),
  fieldGroup: z.string().nullable(),
  /** Field keys (or core fields as "core:title") this part shows, in order. */
  fields: z.array(z.string()),
  /** Framework file this part restyles, when one matched. */
  framework: z.object({ file: z.string(), share: z.number() }).nullable(),
  note: z.string().nullable(),
});
export type PlanPart = z.infer<typeof PlanPart>;

export const PlanTemplate = z.object({
  page: z.string(),
  frames: z.array(z.string()),
  kind: PageKind,
  postType: z.string().nullable(),
  /** Theme file that renders it (null when a plugin's own views render it, e.g. The Events Calendar). */
  file: z.string().nullable(),
  /** update: an existing framework file is rewritten; create: a new file. */
  action: z.enum(['update', 'create', 'plugin']),
  parts: z.array(PlanPart),
});
export type PlanTemplate = z.infer<typeof PlanTemplate>;

export const PlanMenuItem: z.ZodType<{ label: string; href: string; target: string | null; children: PlanMenuItemT[] }> = z.lazy(() =>
  z.object({
    label: z.string(),
    /** The mockup's link, as written. */
    href: z.string(),
    /** What it links to on the built site: "page:<file>", "archive:<post type>", "front", or null (a custom link). */
    target: z.string().nullable(),
    children: z.array(PlanMenuItem),
  }),
);
export type PlanMenuItemT = { label: string; href: string; target: string | null; children: PlanMenuItemT[] };

export const PlanMenu = z.object({ name: z.string(), source: z.string(), items: z.array(PlanMenuItem) });

/** A sample page or entry, filled with the mockup's own text and images. */
export const PlanEntry = z.object({
  /** "page" for pages; otherwise the post type. */
  postType: z.string(),
  title: z.string(),
  slug: z.string(),
  /** Page template file, for pages that use one. */
  template: z.string().nullable(),
  frontPage: z.boolean(),
  source: z.object({ page: z.string(), component: z.string().nullable(), index: z.number().nullable() }),
  /** Core values: content, excerpt, featured_image (image src), date, terms. */
  core: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  /** ACF values by field key. Repeaters are arrays of rows (sub-field key → value); images and files are mockup paths. */
  fields: z.record(z.string(), z.unknown()),
  /** ACF blocks on the page, in order (page-builder pages). */
  blocks: z.array(z.object({ block: z.string(), fields: z.record(z.string(), z.unknown()) })),
});
export type PlanEntry = z.infer<typeof PlanEntry>;

export const PlanMedia = z.object({ src: z.string(), bytes: z.number().nullable(), usedBy: z.array(z.string()) });

export const DesignPlan = z.object({
  schema: z.literal('website-mover/design-plan@1'),
  jobId: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  /** Hashes of what the plan was made from: execution refuses other inputs. */
  inputs: z.object({ modelSha256: z.string(), inventorySha256: z.string(), schemaReadAt: z.string(), targetUrl: z.string(), theme: z.string() }),
  /** Who proposed the structure: rules only, or rules refined by the AI (model name). */
  proposedBy: z.object({ rules: z.literal(true), ai: z.string().nullable() }),
  templates: z.array(PlanTemplate),
  postTypes: z.array(PlanPostType),
  taxonomies: z.array(PlanTaxonomy),
  fieldGroups: z.array(PlanFieldGroup),
  blocks: z.array(PlanBlock),
  menus: z.array(PlanMenu),
  entries: z.array(PlanEntry),
  media: z.array(PlanMedia),
  expected: z.object({
    templates: z.object({ update: z.number(), create: z.number() }),
    postTypes: z.number(),
    taxonomies: z.number(),
    fieldGroups: z.object({ extend: z.number(), create: z.number() }),
    fields: z.number(),
    blocks: z.object({ update: z.number(), create: z.number() }),
    entries: z.number(),
    media: z.number(),
  }),
  warnings: z.array(z.string()),
});
export type DesignPlan = z.infer<typeof DesignPlan>;
