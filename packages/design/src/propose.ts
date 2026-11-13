/**
 * The proposal: the decisions a plan is built from (page kinds, how each part of a page gets its
 * content, field names and types, new post types and taxonomies). The rules here write a draft;
 * the AI (ai.ts) returns the same shape, refined. Either way, plan.ts checks every decision against
 * the model and the target before it becomes part of a plan.
 */
import { z } from 'zod';
import type { Collection, DesignModel, Leaf, Section } from './model.js';
import { Binding, CoreField, FieldType, PageKind } from './plan-schema.js';
import type { TargetSchema } from './schema.js';
import { derivedValue } from './theme/markup.js';

export const ProposalField = z.object({
  /** Value path from the part's root (the section, or one list item). */
  path: z.string(),
  name: z.string(),
  label: z.string(),
  type: FieldType,
  /** A WordPress field instead of an ACF one; null for ACF. */
  core: CoreField.nullable(),
});
export type ProposalField = z.infer<typeof ProposalField>;

export const ProposalPart = z.object({
  page: z.string(),
  component: z.string(),
  path: z.string(),
  collection: z.string().nullable(),
  binding: Binding,
  postType: z.string().nullable(),
  taxonomy: z.string().nullable(),
  block: z.string().nullable(),
  fields: z.array(ProposalField),
});
export type ProposalPart = z.infer<typeof ProposalPart>;

export const Proposal = z.object({
  pages: z.array(z.object({ page: z.string(), kind: PageKind, postType: z.string().nullable(), title: z.string() })),
  /** New post types only (existing ones are reused by name). */
  postTypes: z.array(z.object({ name: z.string(), label: z.string(), singular: z.string() })),
  /** New taxonomies only. */
  taxonomies: z.array(z.object({ name: z.string(), label: z.string(), postTypes: z.array(z.string()) })),
  parts: z.array(ProposalPart),
});
export type Proposal = z.infer<typeof Proposal>;

export const partKey = (p: Pick<ProposalPart, 'page' | 'path' | 'collection'>) => `${p.page}#${p.path}#${p.collection ?? ''}`;

/** "View all", "Read more": the template's own words, not content. */
const MORE_LINK = /^(view|see|read|show)\b|\bmore\b|\ball\b.*→?$/i;

const TYPE_FOR: Record<Leaf['kind'], z.infer<typeof FieldType> | null> = {
  heading: 'text',
  text: 'text',
  richtext: 'wysiwyg',
  image: 'image',
  icon: null,
  link: 'link',
  button: 'link',
  date: 'date_picker',
  email: 'email',
  phone: 'text',
  initials: null,
};

const TAGS = /_(h\d|p|a|img|span|div|li|time|strong|b|em|small|label|figcaption)$/;
const GENERIC_NAME = new Set(['p', 'a', 'span', 'div', 'li', 'body', 'info', 'inner', 'wrap', 'text', 'content', 'item', 'col', 'row', 'box', 'block', 'detail', 'descr', 'card', 'link', 'img', 'image', 'h1', 'h2', 'h3', 'h4']);

/** A field name from a value's class-derived label: "staff_card__name_h3" → "name". */
export function fieldName(leaf: Leaf): string {
  if (leaf.kind === 'email' || leaf.kind === 'phone' || leaf.kind === 'date') return leaf.kind;
  let label = leaf.label.toLowerCase().replace(/-/g, '_');
  while (TAGS.test(label)) label = label.replace(TAGS, '');
  const parts = label.split(/__|(?<=[a-z0-9])_(?=[a-z])/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const w = parts[i]!.replace(/[^a-z0-9_]/g, '');
    if (w && !GENERIC_NAME.has(w)) return w.slice(0, 40);
  }
  return { heading: 'heading', text: 'text', richtext: 'text', image: 'image', link: 'link', button: 'button', icon: 'icon', initials: 'initials' }[leaf.kind] ?? 'value';
}

export const humanize = (name: string) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function uniqueNames<T extends { name: string; label: string }>(fields: T[]): T[] {
  const seen = new Map<string, number>();
  return fields.map((f) => {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    return n === 1 ? f : { ...f, name: `${f.name}_${n}`, label: `${f.label} ${n}` };
  });
}

/** A sample the entry works out ("JUL", "6", "2:00 PM - 3:00 PM", "24 Images"); bare capitals may be an acronym. */
const isDerived = (sample: string) => {
  const v = derivedValue(sample);
  return v !== null && v !== 'wmd_initials( get_the_title() )';
};

/** Values a list's entries show, mapped to WordPress fields where they obviously belong. */
function entryFields(leaves: Leaf[]): ProposalField[] {
  const used = new Set<string>();
  // The entry's title: its heading, else a value named title or name, else its first link text.
  const titlePath = (leaves.find((l) => l.kind === 'heading') ?? leaves.find((l) => l.kind === 'text' && /title|name/i.test(l.label)) ?? leaves.find((l) => (l.kind === 'link' || l.kind === 'text') && l.sample && !MORE_LINK.test(l.sample)))?.path;
  const take = (core: z.infer<typeof CoreField>) => (used.has(core) ? null : (used.add(core), core));
  return uniqueNames(
    leaves
      .filter((l) => TYPE_FOR[l.kind] !== null || l.kind === 'initials')
      .map((l): ProposalField | null => {
        let core: z.infer<typeof CoreField> | null = null;
        // Worked out from the entry (initials, a date's month or day, an event's time, an image count).
        if (l.kind === 'initials' || (l.kind === 'text' && isDerived(l.sample))) core = 'derived';
        else if (l.kind === 'link' && !l.sample) core = take('permalink');
        else if (l.path === titlePath) core = take('title');
        else if (l.kind === 'image') core = take('featured_image');
        else if (l.kind === 'date') core = take('date');
        else if (/categor|tag\b/i.test(l.label)) core = take('term');
        else if (l.kind === 'richtext') core = take('excerpt');
        if (core === null && (l.kind === 'link' || l.kind === 'button') && /view|more|read/i.test(l.sample)) return null;
        const name = core ? core : fieldName(l);
        return { path: l.path, name, label: humanize(name), type: TYPE_FOR[l.kind] ?? 'text', core };
      })
      .filter((f): f is ProposalField => f !== null),
  );
}

/** A section's (or a repeater row's) own values as ACF fields, prefixed when they belong to a shared object. */
/** Kind words for values whose class name says nothing ("throwback_card_h3" → heading). */
const KIND_WORD: Record<Leaf['kind'], string> = { heading: 'heading', text: 'text', richtext: 'text', image: 'image', icon: 'icon', link: 'link', button: 'link', date: 'date', email: 'email', phone: 'phone', initials: 'initials' };
const VAGUE = new Set(['head', 'meta', 'caption', 'btn', 'cont', 'descr', 'panel', 'title', 'label', 'subtitle', 'heading', 'alert', 'banner', 'search', 'links', 'us']);
const PREFIX_DROP = new Set(['card', 'panel', 'widget', 'section', 'block', 'wrap', 'box', 'info', 'main', 'list', 'home', 'dp', 'top']);

/**
 * "Label: value" pairs: a small heading (h3–h6, or a <strong>/<label>) next to a value in the same
 * parent names that value ("Address:" → address). Returns label text by value path.
 */
export function pairedLabels(leaves: Leaf[]): Map<string, string> {
  const parent = (p: string) => p.split(' > ').slice(0, -1).join(' > ');
  const out = new Map<string, string>();
  for (const h of leaves.filter((l) => /(?:^|> )(h[3-6]|strong|label|dt)(\[\d+\])?$/.test(l.path) && l.sample.length <= 40)) {
    const value = leaves.find((l) => l !== h && parent(l.path) === parent(h.path) && !/(?:^|> )(h[1-6]|strong|label|dt)(\[\d+\])?$/.test(l.path) && !out.has(l.path));
    if (value) out.set(value.path, h.sample.replace(/[:：]\s*$/, ''));
  }
  return out;
}

/** A section's (or a repeater row's) own values as ACF fields, named after the component when vague. */
function ownFields(leaves: Leaf[], component: string, samples: Record<string, string>[] = []): ProposalField[] {
  const prefix = component
    .split('_')
    .filter((w) => w && !PREFIX_DROP.has(w))
    .join('_');
  const words = new Set(component.split('_'));
  // A heading that differs between a list's items ("Training Updates", "Classifieds") is a value, not
  // the label of the link under it.
  const varies = (path: string) => new Set(samples.map((r) => r[path] ?? '')).size > 1;
  const pairs = new Map([...pairedLabels(leaves)].filter(([p, label]) => !varies(leaves.find((h) => h.path !== p && label === h.sample.replace(/[:：]\s*$/, ''))?.path ?? '')));
  const labelPaths = new Set([...pairs.keys()].map((p) => leaves.find((h) => h.path !== p && pairs.get(p) === h.sample.replace(/[:：]\s*$/, ''))?.path));
  return uniqueNames(
    leaves
      .filter((l) => TYPE_FOR[l.kind] !== null && !labelPaths.has(l.path))
      .map((l) => {
        const paired = pairs.get(l.path);
        if (paired) {
          const name = paired.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || fieldName(l);
          return { path: l.path, name, label: paired, type: TYPE_FOR[l.kind]!, core: null };
        }
        let base = fieldName(l);
        if (VAGUE.has(base) || words.has(base) || /^(text|heading|link|image)$/.test(base)) base = KIND_WORD[l.kind];
        const name = prefix ? `${prefix}_${base}` : base;
        return { path: l.path, name, label: humanize(name), type: TYPE_FOR[l.kind]!, core: null };
      }),
  );
}

const firstTaxonomy = (schema: TargetSchema, type: string | null) => (type ? (schema.post_types[type]?.taxonomies.find((t) => !['post_tag', 'post_format'].includes(t)) ?? null) : null);

/** Pages whose parts are all the template's own: nothing to edit there. */
const TEMPLATE_ONLY = new Set(['404', '403', 'search']);

const fileHrefs = (c: Collection) => c.samples.flatMap((r) => Object.entries(r).filter(([k]) => k.endsWith('@href')).map(([, v]) => v.split(/[?#]/)[0]!.split('/').pop()!));

export function draftProposal(model: DesignModel, schema: TargetSchema, frameNames: Record<string, string>): Proposal {
  const fits = new Map(model.schema.pages.map((p) => [p.file, p]));
  const listFits = new Map(model.schema.collections.map((c) => [`${c.component}#${c.path}`, c.postType]));
  const sharedBy = new Map(model.components.map((c) => [c.id, c.pages.length / model.pages.length]));
  const blockOf = new Map(model.components.map((c) => [c.id, c.framework?.block ?? null]));
  const files = new Set(model.pages.map((p) => p.file));

  // A detail page with no post type on the target ("album_detail.html") is a new post type, and a
  // list on another page that links to it is that type's archive.
  const newTypes: Proposal['postTypes'] = [];
  const detailType = new Map<string, string>();
  for (const p of model.pages) {
    if (fits.has(p.file)) continue;
    const m = /^(.+?)[-_]?(detail|single|profile)s?\d*\.html?$/i.exec(p.file);
    if (!m) continue;
    const name = m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);
    if (!name || schema.post_types[name]) continue;
    detailType.set(p.file, name);
    const word = humanize(name);
    if (!newTypes.some((t) => t.name === name)) newTypes.push({ name, label: `${word}s`, singular: word });
  }
  const linksTo = (c: Collection) => fileHrefs(c).map((f) => detailType.get(f)).find(Boolean) ?? null;

  const pages: Proposal['pages'] = model.pages.map((p) => {
    const fit = fits.get(p.file);
    const name = p.file.replace(/\.html?$/i, '');
    const desktop = p.frames.map((f) => frameNames[f]).find(Boolean);
    const h1 = p.sections.flatMap((s) => s.leaves).find((l) => l.kind === 'heading' && /h1$/.test(l.path))?.sample;
    const title = (desktop ?? h1 ?? name).replace(/\s+v\d+$/i, '');
    if (name === 'index' || /^home$/i.test(name)) return { page: p.file, kind: 'front-page', postType: null, title };
    if (/^404$/.test(name)) return { page: p.file, kind: '404', postType: null, title };
    if (/^403$/.test(name)) return { page: p.file, kind: '403', postType: null, title };
    if (/result|search/i.test(name)) return { page: p.file, kind: 'search', postType: null, title };
    if (detailType.has(p.file)) return { page: p.file, kind: 'single', postType: detailType.get(p.file)!, title };
    if (fit) return { page: p.file, kind: fit.as === 'single' ? 'single' : 'archive', postType: fit.postType, title };
    const archiveOf = p.sections.flatMap((s) => s.collections).map(linksTo).find(Boolean);
    if (archiveOf) return { page: p.file, kind: 'archive', postType: archiveOf, title };
    return { page: p.file, kind: 'page', postType: null, title };
  });
  const kindOf = new Map(pages.map((p) => [p.page, p]));

  const parts: ProposalPart[] = [];
  const newTaxonomies: Proposal['taxonomies'] = [];
  for (const p of model.pages) {
    const page = kindOf.get(p.file)!;
    const builder = page.kind === 'page';
    const templateOnly = TEMPLATE_ONLY.has(page.kind) || (page.kind === 'archive' && page.postType === 'tribe_events');
    const listTypes = new Set<string>();
    for (const s of p.sections) for (const c of s.collections) if (listFits.get(`${s.component}#${c.path}`)) listTypes.add(listFits.get(`${s.component}#${c.path}`)!);
    // On an archive, its largest list shows the archive's own entries.
    const mainList = page.kind === 'archive' ? p.sections.flatMap((s) => s.collections.filter((c) => c.role === 'items').map((c) => ({ s, c }))).sort((a, b) => b.c.count - a.c.count)[0] : undefined;

    for (const s of p.sections) {
      const leaves = s.leaves.filter((l) => l.kind !== 'icon');
      const base = { page: p.file, component: s.component, path: s.path };
      const block = blockOf.get(s.component) ?? null;
      const blockName = builder ? (block ? block.replace(/_/g, '-') : `wm-${s.component.replace(/_/g, '-')}`) : null;
      // Running text (headings, paragraphs, text lists) is the page's content, lists and all.
      // (Inline images, dates and download links are still running content.)
      const CONTENT = ['heading', 'text', 'richtext', 'link', 'icon', 'image', 'date', 'email', 'phone'];
      const textLists = s.collections.every((c) => c.leaves.every((l) => CONTENT.includes(l.kind)));
      const typographic = builder && leaves.length >= 6 && leaves.filter((l) => l.kind === 'heading' || l.kind === 'richtext').length >= 3 && leaves.every((l) => CONTENT.includes(l.kind)) && textLists;

      if (leaves.length || !s.collections.length || typographic) {
        let binding: z.infer<typeof Binding>;
        let fields: ProposalField[] = [];
        const shared = (sharedBy.get(s.component) ?? 0) >= 0.4;
        if (templateOnly || /search|pagination|breadcrumb/i.test(s.component) || (!leaves.length && !s.collections.length)) binding = 'theme';
        else if (shared || /intro|page_heading/i.test(s.component)) {
          binding = 'core';
          fields = leaves.filter((l) => l.kind === 'heading').slice(0, 1).map((l) => ({ path: l.path, name: 'title', label: 'Title', type: 'text', core: 'title' }));
        } else if (typographic) {
          binding = 'core';
          fields = [{ path: '', name: 'content', label: 'Content', type: 'wysiwyg', core: 'content' }];
        } else if (builder) {
          binding = 'block';
          fields = ownFields(leaves, '');
        } else if (page.kind === 'single' || page.kind === 'archive') {
          // On an entry's page, the first heading is its title and the first long text its content.
          // Section headings ("Overview", "Staff") and "View all" links are the template's words.
          let titled = false;
          let bodied = false;
          const pairs = pairedLabels(leaves);
          const pairHeads = new Set(leaves.filter((h) => [...pairs.values()].includes(h.sample.replace(/[:：]\s*$/, ''))).map((h) => h.path));
          fields = uniqueNames(
            leaves
              .filter((l) => TYPE_FOR[l.kind] !== null && !pairHeads.has(l.path) && !(l.kind === 'heading' && !/h1$/.test(l.path)) && !MORE_LINK.test(l.sample) && !(l.kind === 'text' && s.leaves.some((x) => x.kind === 'link' && MORE_LINK.test(x.sample) && l.path.startsWith(x.path))))
              .map((l): ProposalField | null => {
                if (l.kind === 'heading' && !titled) return (titled = true), { path: l.path, name: 'title', label: 'Title', type: 'text', core: 'title' };
                if (l.kind === 'richtext' && !bodied && /overview|about|intro|description/i.test(s.component + (s.heading ?? ''))) return (bodied = true), { path: l.path, name: 'content', label: 'Content', type: 'wysiwyg', core: 'content' };
                if (page.kind === 'archive') return null;
                const paired = pairs.get(l.path);
                if (paired) return { path: l.path, name: paired.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40), label: paired, type: TYPE_FOR[l.kind]!, core: null };
                const name = fieldName(l);
                return { path: l.path, name, label: humanize(name), type: TYPE_FOR[l.kind]!, core: null };
              })
              .filter((f): f is ProposalField => f !== null),
          );
          binding = fields.some((f) => !f.core) ? 'fields' : fields.length ? 'core' : 'theme';
        } else {
          binding = 'fields';
          fields = ownFields(leaves.filter((l) => !MORE_LINK.test(l.sample) || l.kind !== 'text'), s.component);
        }
        parts.push({ ...base, collection: null, binding, postType: null, taxonomy: null, block: binding === 'block' ? blockName : null, fields });
      }
      if (typographic) {
        // Its lists are part of the content.
        for (const c of s.collections) parts.push({ ...base, collection: c.path, binding: 'core', postType: null, taxonomy: null, block: null, fields: [] });
        continue;
      }
      for (const c of s.collections) {
        // A list whose items hold lists of their own is a row of widgets, not entries.
        const widgets = c.collections.some((x) => x.role === 'items');
        const fit = widgets ? null : (listFits.get(`${s.component}#${c.path}`) ?? linksTo(c) ?? (mainList && mainList.c === c && page.postType ? page.postType : null));
        parts.push(templateOnly && !fit ? { ...base, collection: c.path, binding: 'theme', postType: null, taxonomy: null, block: null, fields: [] } : listPart(p.file, s, c, page, builder ? blockName : null, fit, listTypes, schema, newTaxonomies));
      }
    }
  }
  return { pages, postTypes: newTypes, taxonomies: newTaxonomies, parts };
}

function listPart(file: string, s: Section, c: Collection, page: Proposal['pages'][number], block: string | null, fit: string | null, listTypes: Set<string>, schema: TargetSchema, newTaxonomies: Proposal['taxonomies']): ProposalPart {
  const base = { page: file, component: s.component, path: s.path, collection: c.path };
  if (c.role === 'filters') {
    // Filter choices are terms of the page's own type, or of the type its lists show.
    const type = page.postType ?? [...listTypes][0] ?? null;
    let taxonomy = firstTaxonomy(schema, type);
    if (!taxonomy && type && type !== 'attachment') {
      taxonomy = `${type}_category`.slice(0, 32);
      if (!newTaxonomies.some((t) => t.name === taxonomy)) newTaxonomies.push({ name: taxonomy, label: 'Category', postTypes: [type] });
    }
    return { ...base, binding: 'filter', postType: type, taxonomy, block: null, fields: [] };
  }
  if (fit) return { ...base, binding: 'query', postType: fit, taxonomy: null, block: null, fields: entryFields(c.leaves.filter((l) => l.kind !== 'icon')) };
  const fields = ownFields(c.leaves.filter((l) => l.kind !== 'icon'), '', c.samples);
  return { ...base, binding: block ? 'block' : 'repeater', postType: null, taxonomy: null, block, fields };
}
