/**
 * Builds the design plan from a proposal (propose.ts: the rules' draft, or the AI's refinement of
 * it). Every decision is checked here: parts and values must exist in the model, post types and
 * taxonomies must exist on the target or be declared new, and every new label must appear in the
 * mockups (page text, Figma text or layer names, class names). What fails falls back to the draft,
 * with a warning.
 */
import type { Collection, DesignModel, Leaf, MenuItem, Section } from './model.js';
import { normText } from './pages.js';
import { DesignPlan, type FieldType, type PageKind, type PlanBlock, type PlanEntry, type PlanField, type PlanFieldGroup, type PlanMenuItemT, type PlanPart, type PlanPostType, type PlanRelation, type PlanTaxonomy, type PlanTemplate } from './plan-schema.js';
import { humanize, partKey, type Proposal, type ProposalField, type ProposalPart } from './propose.js';
import { groupsFor, type AcfField, type TargetSchema } from './schema.js';

export interface Vocabulary {
  /** Page and Figma text, normalized. */
  texts: Set<string>;
  /** Figma layer and frame names, normalized. */
  layers: Set<string>;
  /** Every word in the above and in class names. */
  words: Set<string>;
}

export function vocabulary(input: { pageTexts: string[]; figmaTexts: string[]; layerNames: string[]; classNames: string[] }): Vocabulary {
  const texts = new Set([...input.pageTexts, ...input.figmaTexts].map(normText));
  const layers = new Set(input.layerNames.map(normText));
  const words = new Set<string>();
  const addWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).forEach((w) => w && words.add(w) && words.add(w.replace(/s$/, '')));
  [...texts, ...layers, ...input.classNames].forEach(addWords);
  return { texts, layers, words };
}

/** Where a label comes from in the mockups, or null when it doesn't (and may not be used). */
export function labelSource(label: string, v: Vocabulary): 'mockup-text' | 'figma' | 'class-name' | null {
  const n = normText(label);
  if (!n) return null;
  if (v.texts.has(n)) return 'mockup-text';
  if (v.layers.has(n)) return 'figma';
  const words = n.split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  return words.length && words.every((w) => v.words.has(w) || v.words.has(w.replace(/s$/, ''))) ? 'class-name' : null;
}

export interface PlanInput {
  jobId: string;
  version: number;
  model: DesignModel;
  schema: TargetSchema;
  proposal: Proposal;
  /** The rules' draft: the fallback for anything the proposal gets wrong. */
  draft: Proposal;
  vocabulary: Vocabulary;
  /** Theme files (paths from the theme root) that exist in the framework. */
  themeFiles: string[];
  inputs: DesignPlan['inputs'];
  ai: string | null;
  mediaBytes?: (src: string) => number | null;
  now?: Date;
}

const RESERVED_TYPES = new Set(['post', 'page', 'attachment', 'revision', 'nav_menu_item', 'action', 'author', 'order', 'theme', 'custom_css', 'customize_changeset', 'user_request', 'wp_block', 'wp_template']);
export const slugify = (s: string, max = 60) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '');
const snake = (s: string, max = 40) => slugify(s, max).replace(/-/g, '_');

/** Post type words used to find a framework page template ("template-news.php" for posts). */
const TEMPLATE_WORDS: Record<string, string[]> = { post: ['news', 'blog'], attachment: ['documents', 'document', 'resources'], tribe_events: ['events', 'calendar'], departments: ['department', 'departments'], people: ['people', 'staff', 'directory'] };

export function buildDesignPlan(input: PlanInput): DesignPlan {
  const { model, schema, vocabulary: vocab } = input;
  const warnings: string[] = [];
  const { proposal } = checkProposal(input, warnings);

  const sectionAt = new Map(model.pages.flatMap((p) => p.sections.map((s) => [`${p.file}#${s.path}`, s] as const)));
  const pageModel = new Map(model.pages.map((p) => [p.file, p]));
  const pageOf = new Map(proposal.pages.map((p) => [p.page, p]));
  const componentFw = new Map(model.components.map((c) => [c.id, c.framework]));
  const themeFiles = new Set(input.themeFiles);

  // ── Post types and taxonomies ─────────────────────────────────────────────
  const postTypes = new Map<string, PlanPostType>();
  const useType = (name: string, from: string) => {
    if (name === 'page') return;
    const existing = schema.post_types[name];
    const declared = proposal.postTypes.find((t) => t.name === name);
    const pt = postTypes.get(name) ?? {
      name,
      label: existing?.label ?? declared?.label ?? humanize(name),
      singular: declared?.singular ?? existing?.label ?? humanize(name),
      action: existing ? ('reuse' as const) : ('create' as const),
      hasArchive: Boolean(existing?.has_archive),
      taxonomies: existing ? [...existing.taxonomies] : [],
      from: [],
    };
    if (!pt.from.includes(from)) pt.from.push(from);
    postTypes.set(name, pt);
  };
  for (const p of proposal.pages) if (p.postType) useType(p.postType, p.page);
  for (const part of proposal.parts) if (part.postType && (part.binding === 'query' || part.binding === 'filter')) useType(part.postType, `${part.page} ${part.component}`);

  const taxonomies = new Map<string, PlanTaxonomy>();
  for (const part of proposal.parts.filter((x) => x.binding === 'filter' && x.taxonomy)) {
    const name = part.taxonomy!;
    const existing = schema.taxonomies[name];
    const declared = proposal.taxonomies.find((t) => t.name === name);
    const tax = taxonomies.get(name) ?? { name, label: existing?.label ?? declared?.label ?? 'Category', postTypes: existing?.object_type ?? declared?.postTypes ?? (part.postType ? [part.postType] : []), action: existing ? ('reuse' as const) : ('create' as const), terms: [], from: [] };
    const coll = sectionAt.get(`${part.page}#${part.path}`)?.collections.find((c) => c.path === part.collection);
    for (const row of coll?.samples ?? []) {
      const term = Object.entries(row).find(([k]) => !k.includes('@'))?.[1];
      if (term && !/^(all|view all|show all)$/i.test(term) && !tax.terms.includes(term)) tax.terms.push(term);
    }
    tax.from.push(`${part.page} ${part.component}`);
    for (const t of tax.postTypes) {
      const pt = postTypes.get(t);
      if (pt && !pt.taxonomies.includes(name)) pt.taxonomies.push(name);
    }
    taxonomies.set(name, tax);
  }

  // ── Templates (file per page) ─────────────────────────────────────────────
  const templateFile = (p: Proposal['pages'][number], hasFields: boolean): { kind: PageKind; file: string | null; action: PlanTemplate['action'] } => {
    const exists = (f: string) => (themeFiles.has(f) ? 'update' : 'create') as PlanTemplate['action'];
    const pageTemplate = (type: string | null) => {
      const words = type ? [...(TEMPLATE_WORDS[type] ?? []), type, slugify(schema.post_types[type]?.label ?? '')] : [];
      const found = words.map((w) => `template-${w}.php`).find((f) => themeFiles.has(f));
      return found ?? `template-${slugify(p.title, 40) || slugify(p.page.replace(/\.html?$/, ''))}.php`;
    };
    switch (p.kind) {
      case 'front-page':
        return { kind: p.kind, file: 'template-home.php', action: exists('template-home.php') };
      case '404':
      case '403':
        return { kind: p.kind, file: `${p.kind}.php`, action: exists(`${p.kind}.php`) };
      case 'search':
        return { kind: p.kind, file: 'search.php', action: exists('search.php') };
      case 'single':
        return { kind: p.kind, file: `single-${p.postType}.php`, action: exists(`single-${p.postType}.php`) };
      case 'archive':
        if (p.postType === 'tribe_events') return { kind: p.kind, file: null, action: 'plugin' };
        return { kind: 'page-template', file: pageTemplate(p.postType), action: exists(pageTemplate(p.postType)) };
      case 'page-template':
        return { kind: p.kind, file: pageTemplate(p.postType), action: exists(pageTemplate(p.postType)) };
      case 'page':
        return hasFields ? { kind: 'page-template', file: pageTemplate(null), action: exists(pageTemplate(null)) } : { kind: 'page', file: 'page.php', action: exists('page.php') };
    }
  };

  // ── Field groups ──────────────────────────────────────────────────────────
  const groups = new Map<string, PlanFieldGroup>();
  const groupAt = (param0: string, value0: string, title: string): PlanFieldGroup => {
    // ACF puts media fields on "attachment == all", not on a post type.
    const [param, value] = param0 === 'post_type' && value0 === 'attachment' ? ['attachment', 'all'] : [param0, value0];
    const id = `${param}==${value}`;
    if (groups.has(id)) return groups.get(id)!;
    const alt = param === 'page_template' ? 'post_template' : param === 'post_template' ? 'page_template' : param;
    const candidates = [...groupsFor(schema, { param, value }), ...groupsFor(schema, { param: alt, value })];
    // Of several groups on one post type, only one whose title names it is extended (not "Facilities
    // Fields" on posts); otherwise the build makes its own group.
    const words = new Set(normText(`${title} ${value}`).split(/[^a-z0-9]+/).map((w) => w.replace(/s$/, '')).filter((w) => w.length > 2));
    const existing = candidates.length === 1 ? candidates[0] : candidates.find((g) => normText(g.title).split(/[^a-z0-9]+/).some((w) => words.has(w.replace(/s$/, ''))));
    const g: PlanFieldGroup = existing
      ? { key: existing.key, title: existing.title, action: 'reuse', location: { param, value }, fields: [] }
      : { key: `group_wm_${snake(`${param === 'block' ? 'block_' : ''}${value.replace(/^acf\//, '').replace(/\.php$/, '')}`)}`, title, action: 'create', location: { param, value }, fields: [] };
    groups.set(id, g);
    return g;
  };
  const existingFields = (g: PlanFieldGroup): AcfField[] => (schema.acf?.field_groups.find((x) => x.key === g.key)?.fields ?? []).filter((f) => f.type !== 'tab');
  const sameField = (f: AcfField, name: string, label: string) => f.name === name || normText(f.label) === normText(label) || f.name.replace(/_/g, '') === name.replace(/_/g, '');

  /** Adds (or reuses) a field in a group and returns its key. */
  const addField = (g: PlanFieldGroup, f: { name: string; label: string; type: FieldType; source: PlanField['source']; sample: string | null; subFields?: PlanField[] }): PlanField => {
    const already = g.fields.find((x) => x.name === f.name);
    if (already) {
      for (const sf of f.subFields ?? []) if (!already.subFields.some((x) => x.name === sf.name)) already.subFields.push(sf);
      return already;
    }
    const match = existingFields(g).find((x) => sameField(x, f.name, f.label));
    const field: PlanField = match
      ? { key: match.key, name: match.name, label: match.label, type: (match.type as FieldType) ?? f.type, action: 'reuse', labelFrom: 'existing', source: f.source, sample: f.sample, subFields: reuseSubFields(match, f.subFields ?? []) }
      : { key: `field_wm_${g.key.replace(/^group_(wm_)?/, '')}_${f.name}`.slice(0, 64), name: f.name, label: f.label, type: f.type, action: 'add', labelFrom: labelSource(f.label, vocab) ?? 'class-name', source: f.source, sample: f.sample, subFields: (f.subFields ?? []).map((sf) => ({ ...sf, key: `field_wm_${g.key.replace(/^group_(wm_)?/, '')}_${f.name}_${sf.name}`.slice(0, 64) })) };
    g.fields.push(field);
    if (field.action === 'add' && g.action === 'reuse') g.action = 'extend';
    return field;
  };
  const reuseSubFields = (parent: AcfField, subs: PlanField[]): PlanField[] =>
    subs.map((sf) => {
      const m = (parent.sub_fields ?? []).find((x) => sameField(x, sf.name, sf.label));
      return m ? { ...sf, key: m.key, name: m.name, label: m.label, action: 'reuse' as const, labelFrom: 'existing' as const } : { ...sf, key: `${parent.key}_${sf.name}`.slice(0, 64) };
    });

  // ── Parts, templates, blocks, entries ─────────────────────────────────────
  const templates: PlanTemplate[] = [];
  const blocks = new Map<string, PlanBlock>();
  const entries: PlanEntry[] = [];
  const entryKeys = new Set<string>();
  const media = new Map<string, Set<string>>();
  const useMedia = (src: string | undefined, by: string) => {
    if (!src) return;
    media.set(src, (media.get(src) ?? new Set()).add(by));
  };

  for (const p of proposal.pages) {
    const pm = pageModel.get(p.page)!;
    const parts = proposal.parts.filter((x) => x.page === p.page);
    const hasFields = parts.some((x) => x.binding === 'fields' || x.binding === 'repeater');
    const t = templateFile(p, hasFields);
    // Where the page's own fields live: the entry's post type on a single, else the page's template.
    const ownGroup = () => (t.kind === 'single' && p.postType ? groupAt('post_type', p.postType, `${postTypes.get(p.postType)?.singular ?? humanize(p.postType)} Details`) : groupAt('page_template', t.file ?? 'page.php', `${p.title} Details`));

    const pageEntry: PlanEntry | null =
      t.kind === 'search' || t.kind === '404' || t.kind === '403' || (t.kind === 'archive' && t.action === 'plugin')
        ? null
        : { postType: t.kind === 'single' ? p.postType! : 'page', title: p.title, slug: t.kind === 'front-page' ? '' : slugify(p.title), template: t.kind === 'page-template' || t.kind === 'front-page' ? t.file : null, frontPage: t.kind === 'front-page', source: { page: p.page, component: null, index: null }, core: {}, fields: {}, blocks: [] };

    const planParts: PlanPart[] = [];
    for (const part of parts) {
      const section = sectionAt.get(`${p.page}#${part.path}`)!;
      const coll = part.collection !== null ? section.collections.find((c) => c.path === part.collection) ?? null : null;
      const scopeLeaves = coll ? coll.leaves : section.leaves;
      const source = (f: ProposalField) => ({ page: p.page, component: part.component, path: f.path });
      const sampleOf = (f: ProposalField) => scopeLeaves.find((l) => l.path === f.path)?.sample || null;
      const keys: string[] = [];
      const values: { field: string; path: string }[] = [];
      const bind = (field: string, f: ProposalField) => values.push({ field, path: f.path });
      /** Sub-field keys of a list field, in the proposal's order (reused sub-fields keep their names). */
      const bindSubs = (list: PlanField, fields: ProposalField[]) => {
        for (const f of fields.filter((x) => !x.core)) {
          const sub = list.subFields.find((x) => x.name === f.name) ?? list.subFields.find((x) => x.label === f.label) ?? list.subFields.find((x) => sameField(x as unknown as AcfField, f.name, f.label));
          if (sub) bind(sub.key, f);
        }
      };
      let fieldGroup: string | null = null;

      if (part.binding === 'core' || part.binding === 'theme' || part.binding === 'menu') {
        for (const f of part.fields) {
          keys.push(`core:${f.core ?? f.name}`);
          bind(`core:${f.core ?? f.name}`, f);
        }
        if (pageEntry && part.binding === 'core') {
          for (const f of part.fields) {
            // An entry's title is its heading; a page keeps the title the proposal gave it.
            if (f.core === 'title' && pageEntry.postType !== 'page') pageEntry.title = (sampleOf(f) ?? pageEntry.title).replace(/\s+/g, ' ');
            if (f.core === 'content') pageEntry.core.content = contentHtml(section);
          }
        }
      } else if (part.binding === 'fields' || part.binding === 'repeater') {
        const g = ownGroup();
        fieldGroup = g.key;
        if (part.binding === 'fields') {
          for (const f of part.fields) {
            if (f.core) {
              keys.push(`core:${f.core}`);
              bind(`core:${f.core}`, f);
              if (pageEntry) setCore(pageEntry, f.core, valueOf(f.type, f.path, leafRecord(scopeLeaves)), useMedia);
              continue;
            }
            const field = addField(g, { name: f.name, label: f.label, type: f.type, source: source(f), sample: sampleOf(f) });
            keys.push(field.key);
            bind(field.key, f);
            if (pageEntry) pageEntry.fields[field.key] = valueOf(field.type, f.path, leafRecord(scopeLeaves), (src) => useMedia(src, `${p.page} ${part.component}`));
          }
        } else {
          const name = snake(part.component);
          const label = section.heading && labelSource(section.heading, vocab) ? section.heading : humanize(name);
          const subFields = part.fields.filter((f) => !f.core).map((f) => subField(f, source(f), sampleOf(f)));
          const field = addField(g, { name, label, type: 'repeater', source: { page: p.page, component: part.component, path: part.collection ?? '' }, sample: null, subFields });
          keys.push(field.key);
          bindSubs(field, part.fields);
          if (pageEntry && coll) pageEntry.fields[field.key] = rows(coll, part.fields, field, (src) => useMedia(src, `${p.page} ${part.component}`));
        }
      } else if (part.binding === 'query' && part.postType) {
        const g = groupAt('post_type', part.postType, `${postTypes.get(part.postType)?.singular ?? humanize(part.postType)} Details`);
        fieldGroup = g.key;
        const fieldKeys = new Map<ProposalField, string>();
        for (const f of part.fields) {
          if (f.core) {
            keys.push(`core:${f.core}`);
            bind(`core:${f.core}`, f);
          } else {
            const field = addField(g, { name: f.name, label: f.label, type: f.type, source: source(f), sample: sampleOf(f) });
            keys.push(field.key);
            bind(field.key, f);
            fieldKeys.set(f, field.key);
          }
        }
        // Each item in the mockup list becomes a sample entry of that type.
        coll?.samples.forEach((row, i) => {
          const title = part.fields.find((f) => f.core === 'title') ?? part.fields.find((f) => f.type === 'link' || f.type === 'text');
          const name = title ? row[title.path] : undefined;
          // Titles are the mockup's words; an item without one isn't a sample entry.
          if (!name) return;
          const e: PlanEntry = { postType: part.postType!, title: name, slug: '', template: null, frontPage: false, source: { page: p.page, component: part.component, index: i }, core: {}, fields: {}, blocks: [] };
          for (const f of part.fields) {
            if (f.core) setCore(e, f.core, valueOf(f.type, f.path, row), useMedia);
            else e.fields[fieldKeys.get(f)!] = valueOf(f.type, f.path, row, (src) => useMedia(src, `${part.postType} sample`));
          }
          const dedupe = `${e.postType}|${e.title}|${JSON.stringify(e.core)}|${JSON.stringify(e.fields)}`;
          if (!entryKeys.has(dedupe)) {
            entryKeys.add(dedupe);
            entries.push(e);
          }
        });
      } else if (part.binding === 'block' && part.block) {
        const fw = componentFw.get(part.component);
        const existingBlock = fw?.block ? fw.block.replace(/_/g, '-') === part.block : false;
        const g = groupAt('block', `acf/${part.block}`, `${section.heading && labelSource(section.heading, vocab) ? section.heading : humanize(part.block.replace(/^wm-/, '').replace(/-/g, '_'))} Block`);
        fieldGroup = g.key;
        const b = blocks.get(part.block) ?? { name: part.block, title: g.title.replace(/ Block$/, ''), action: existingBlock ? ('update' as const) : ('create' as const), template: existingBlock && fw ? fw.file : `template-parts/blocks/newport/${part.block.replace(/-/g, '_')}.php`, fieldGroup: g.key, from: { page: p.page, component: part.component } };
        blocks.set(part.block, b);
        const data: Record<string, unknown> = {};
        if (coll) {
          const name = snake(coll.item.split('.')[1] ?? part.component);
          const subFields = part.fields.filter((f) => !f.core).map((f) => subField(f, source(f), sampleOf(f)));
          const field = addField(g, { name: `${name}_items`.replace(/(_items)+$/, '_items'), label: humanize(name), type: 'repeater', source: { page: p.page, component: part.component, path: part.collection ?? '' }, sample: null, subFields });
          keys.push(field.key);
          bindSubs(field, part.fields);
          data[field.key] = rows(coll, part.fields, field, (src) => useMedia(src, `${p.page} ${part.block}`));
        } else {
          for (const f of part.fields.filter((x) => !x.core)) {
            const field = addField(g, { name: f.name, label: f.label, type: f.type, source: source(f), sample: sampleOf(f) });
            keys.push(field.key);
            bind(field.key, f);
            data[field.key] = valueOf(field.type, f.path, leafRecord(scopeLeaves), (src) => useMedia(src, `${p.page} ${part.block}`));
          }
        }
        if (pageEntry) {
          // One block per section: a list in the same section joins the block's data.
          const last = pageEntry.blocks[pageEntry.blocks.length - 1];
          if (last && last.block === part.block && planParts[planParts.length - 1]?.path === part.path) Object.assign(last.fields, data);
          else pageEntry.blocks.push({ block: part.block, fields: data });
        }
      }
      planParts.push({ component: part.component, path: part.path, collection: part.collection, heading: section.heading, binding: part.binding, postType: part.postType, taxonomy: part.taxonomy, block: part.block, fieldGroup, fields: keys, framework: componentFw.get(part.component) ? { file: componentFw.get(part.component)!.file, share: componentFw.get(part.component)!.share } : null, note: null, values });
    }
    templates.push({ page: p.page, frames: pm.frames, kind: t.kind, postType: p.postType, file: t.file, action: t.action, parts: planParts });
    if (pageEntry) {
      if (t.kind === 'single') pageEntry.slug = slugify(pageEntry.title);
      entries.unshift(pageEntry);
    }
  }

  // Unique slugs per post type.
  const slugs = new Map<string, number>();
  for (const e of entries) {
    if (e.frontPage) continue;
    e.slug ||= slugify(e.title) || e.postType;
    const k = `${e.postType}/${e.slug}`;
    const n = (slugs.get(k) ?? 0) + 1;
    slugs.set(k, n);
    if (n > 1) e.slug = `${e.slug}-${n}`;
  }

  // ── Relations: "Filter by Department" drop-downs ──────────────────────────
  const relations: PlanRelation[] = [];
  const singularWord = (w: string) => normText(w).replace(/ies$/, 'y').replace(/s$/, '');
  for (const t of templates) {
    const listType = t.postType;
    if (!listType || t.kind === 'single') continue;
    for (const sel of pageModel.get(t.page)?.selects ?? []) {
      const word = (/\bby\s+(.+)$/i.exec(sel.label)?.[1] ?? sel.name ?? '').trim();
      if (!word) continue;
      const target = Object.entries(schema.post_types).find(([n, pt]) => n !== listType && n !== 'page' && [n, pt.label].some((x) => singularWord(x) === singularWord(word)))?.[0];
      if (!target) continue;
      const name = snake(singularWord(word));
      const label = humanize(name);
      let rel = relations.find((r) => r.name === name && r.relatesTo === target);
      if (!rel) relations.push((rel = { name, label, relatesTo: target, param: sel.name ?? name, on: [], filters: [] }));
      if (!rel.on.some((o) => o.postType === listType)) {
        useType(listType, t.page);
        // Its own group ("Department") on each type, not whatever group the type already has.
        const [param, value] = listType === 'attachment' ? ['attachment', 'all'] : ['post_type', listType];
        const id = `${param}==${value}#${name}`;
        const g = groups.get(id) ?? { key: `group_wm_${name}_${snake(listType)}`, title: label, action: 'create' as const, location: { param, value }, fields: [] };
        groups.set(id, g);
        const f = addField(g, { name, label, type: 'post_object', source: { page: t.page, component: 'select', path: sel.id ? `select#${sel.id}` : 'select' }, sample: sel.options[0] ?? null });
        f.relatesTo = target;
        rel.on.push({ postType: listType, field: f.key });
      }
      rel.filters.push({ page: t.page, id: sel.id, name: sel.name, label: sel.label, postType: listType, themed: t.action !== 'plugin' });
      if (t.action === 'plugin') warnings.push(`${t.page}: "${sel.label}" is in ${listType}'s own views, which the theme doesn't render; entries get the ${label} field, but this drop-down needs the plugin's own filters`);
    }
  }

  // Sample entries listed on a related entry's own page (a department's news) belong to it; the
  // build links them ({ entry: <mockup page> } is that page's sample entry).
  for (const rel of relations) {
    for (const e of entries) {
      const on = rel.on.find((o) => o.postType === e.postType);
      const host = templates.find((x) => x.page === e.source.page);
      if (on && e.source.component !== null && host?.kind === 'single' && host.postType === rel.relatesTo) e.fields[on.field] = { entry: e.source.page };
    }
  }

  // Entries made from a list have only what the list shows (a department's name and phone). Each
  // gets the values its detail mockup shows for the sample entry, where it has none of its own, so
  // the detail template shows them filled (still the mockup's own sample text).
  for (const t of templates.filter((x) => x.kind === 'single' && x.postType)) {
    const sample = entries.find((e) => e.source.page === t.page && e.source.component === null && e.postType === t.postType);
    if (!sample || templates.find((x) => x.kind === 'single' && x.postType === t.postType) !== t) continue;
    const fromLists = entries.filter((e) => e !== sample && e.postType === t.postType && e.source.component !== null);
    for (const e of fromLists) {
      for (const [k, v] of Object.entries(sample.fields)) if (!(k in e.fields) && !(v && typeof v === 'object' && 'entry' in (v as object))) e.fields[k] = structuredClone(v);
      for (const k of ['content', 'excerpt', 'featured_image'] as const) if (sample.core[k] !== undefined && e.core[k] === undefined) e.core[k] = structuredClone(sample.core[k]);
    }
    if (fromLists.length) warnings.push(`${fromLists.length} ${t.postType} entries from lists get the sample values of ${t.page} they don't show in the list (the mockup's sample text): replace them in WordPress`);
  }

  // ── Menus ─────────────────────────────────────────────────────────────────
  const targetFor = (href: string): string | null => {
    const file = href.split(/[?#]/)[0]!.split('/').pop() ?? '';
    const t = templates.find((x) => x.page === file);
    if (!t) return null;
    if (t.kind === 'front-page') return 'front';
    if (t.kind === 'single') return `entry:${file}`;
    if (t.action === 'plugin' && t.postType) return `archive:${t.postType}`;
    if (t.kind === 'search' || t.kind === '404' || t.kind === '403') return null;
    return `page:${file}`;
  };
  // A label names what the item opens when the mockup's link doesn't ("#"): a page, a post type, or
  // an entry with that title. A link to a single entry's mockup page goes to the entry the label names.
  const norm = (s: string) => s.toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9&]+/g, ' ').trim();
  const sameName = (a: string, b: string) => {
    const x = norm(a);
    const y = norm(b);
    return x === y || x.replace(/s$/, '') === y.replace(/s$/, '') || x === y.replace(/ department$/, '') || y === x.replace(/ department$/, '');
  };
  const byLabel = (label: string, type: string | null = null): string | null => {
    if (!type) {
      const page = entries.find((e) => e.postType === 'page' && e.source.component === null && sameName(e.title, label));
      if (page) return page.frontPage ? 'front' : `page:${page.source.page}`;
      for (const [name, pt] of Object.entries(schema.post_types)) if (pt.has_archive && (sameName(pt.label, label) || sameName(name, label))) return `archive:${name}`;
    }
    const entry = entries.find((e) => e.postType !== 'page' && (!type || e.postType === type) && sameName(e.title, label));
    return entry ? `title:${entry.postType}:${entry.title}` : null;
  };
  const isHome = (href: string) => /^(index|home\d*)\.html$/i.test(href.split(/[?#]/)[0]!.split('/').pop() ?? '');
  const menuTargetFor = (label: string, href: string): string | null => {
    const t = targetFor(href) ?? (isHome(href) && templates.some((x) => x.kind === 'front-page') ? 'front' : null);
    if (t?.startsWith('entry:')) {
      const type = templates.find((x) => x.page === t.slice(6))?.postType ?? null;
      const named = byLabel(label, type);
      if (!named) warnings.push(`Menu item "${label}" goes to the sample ${type ?? 'entry'} of ${t.slice(6)}: the mockups have no entry by that name; point it at the right one in WordPress`);
      return named ?? t;
    }
    return t ?? byLabel(label);
  };
  const menuItems = (items: MenuItem[], menu: string): PlanMenuItemT[] =>
    items.map((i) => {
      const target = menuTargetFor(i.label, i.href);
      if (!target && !/^(https?:|mailto:|tel:)/i.test(i.href) && !i.children.length) warnings.push(`${menu}: "${i.label}" links to nothing in the mockups (${i.href || 'no link'}); set its link on review or in WordPress`);
      return { label: i.label, href: i.href, target, children: menuItems(i.children, menu) };
    });
  const MENU_NAMES: Record<string, string> = { aside: 'Main Menu', footer: 'Footer Menu', header: 'Header Menu' };
  const menus = model.shell.menus.map((m) => ({ name: MENU_NAMES[m.location] ?? `${humanize(m.location)} Menu`, source: m.signature, items: menuItems(m.items, MENU_NAMES[m.location] ?? `${humanize(m.location)} Menu`) }));

  // ── Checks ────────────────────────────────────────────────────────────────
  for (const g of groups.values()) {
    for (const f of [...g.fields, ...g.fields.flatMap((x) => x.subFields)]) {
      if (f.action === 'add' && !labelSource(f.label, vocab)) warnings.push(`Field "${f.label}" (${g.title}): its label isn't in the mockups; rename it on review`);
    }
  }
  for (const pt of postTypes.values()) if (pt.action === 'create' && (pt.name.length > 20 || RESERVED_TYPES.has(pt.name))) warnings.push(`Post type "${pt.name}" can't be created: names are 1–20 characters and not reserved`);
  for (const t of templates) if (t.kind === 'single' && t.postType && !postTypes.has(t.postType)) warnings.push(`${t.page}: single of unknown post type ${t.postType}`);

  // A group the plan neither changes nor needs (every value went to WordPress's own fields) is left out.
  const fieldGroups = [...groups.values()].filter((g) => g.fields.length > 0);
  const allFields = fieldGroups.flatMap((g) => g.fields);
  const plan: DesignPlan = {
    schema: 'website-mover/design-plan@1',
    jobId: input.jobId,
    version: input.version,
    createdAt: (input.now ?? new Date()).toISOString(),
    inputs: input.inputs,
    proposedBy: { rules: true, ai: input.ai },
    templates,
    postTypes: [...postTypes.values()],
    taxonomies: [...taxonomies.values()],
    fieldGroups,
    blocks: [...blocks.values()],
    menus,
    entries,
    relations,
    media: [...media].map(([src, by]) => ({ src, bytes: input.mediaBytes?.(src) ?? null, usedBy: [...by].sort() })).sort((a, b) => a.src.localeCompare(b.src)),
    expected: {
      templates: { update: templates.filter((t) => t.action === 'update').length, create: templates.filter((t) => t.action === 'create').length },
      postTypes: [...postTypes.values()].filter((t) => t.action === 'create').length,
      taxonomies: [...taxonomies.values()].filter((t) => t.action === 'create').length,
      fieldGroups: { extend: fieldGroups.filter((g) => g.action === 'extend').length, create: fieldGroups.filter((g) => g.action === 'create').length },
      fields: allFields.filter((f) => f.action === 'add').length + allFields.flatMap((f) => f.subFields).filter((f) => f.action === 'add').length,
      blocks: { update: [...blocks.values()].filter((b) => b.action === 'update').length, create: [...blocks.values()].filter((b) => b.action === 'create').length },
      entries: entries.length,
      media: media.size,
    },
    warnings,
  };
  return DesignPlan.parse(plan);
}

function subField(f: ProposalField, source: PlanField['source'], sample: string | null): PlanField {
  return { key: '', name: f.name, label: f.label, type: f.type, action: 'add', labelFrom: 'class-name', source, sample, subFields: [] };
}

/** A section's own values as a sample row: text by path, plus "@src" and "@href". */
function leafRecord(leaves: Leaf[]): Record<string, string> {
  const r: Record<string, string> = {};
  for (const l of leaves) {
    if (l.sample) r[l.path] = l.sample;
    if (l.src) r[`${l.path}@src`] = l.src;
    if (l.href) r[`${l.path}@href`] = l.href;
  }
  return r;
}

/** A field's sample value: images as the mockup path, links as { title, url }. */
function valueOf(type: FieldType, path: string, row: Record<string, string>, onMedia?: (src: string) => void): unknown {
  if (type === 'image' || type === 'file') {
    const src = row[`${path}@src`];
    if (src) onMedia?.(src);
    return src ?? null;
  }
  if (type === 'link') return row[`${path}@href`] !== undefined || row[path] ? { title: row[path] ?? '', url: row[`${path}@href`] ?? '#' } : null;
  return row[path] ?? null;
}

function setCore(e: PlanEntry, core: string, value: unknown, useMedia: (src: string | undefined, by: string) => void) {
  if (core === 'permalink' || core === 'derived' || value === null || value === undefined) return;
  if (core === 'title') {
    // A title taken from a link is the link's text.
    e.title = typeof value === 'object' && value && 'title' in value ? String((value as { title: string }).title) : String(value);
    return;
  }
  if (core === 'term') {
    e.core.terms = [...((e.core.terms as string[]) ?? []), String(value)];
    return;
  }
  if (core === 'featured_image') useMedia(String(value), `${e.postType} sample`);
  e.core[core] = typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function rows(coll: Collection, fields: ProposalField[], repeater: PlanField, onMedia: (src: string) => void): Record<string, unknown>[] {
  return coll.samples.map((row) => {
    const out: Record<string, unknown> = {};
    for (const f of fields.filter((x) => !x.core)) {
      const sf = repeater.subFields.find((s) => s.name === f.name);
      if (sf) out[sf.key] = valueOf(sf.type, f.path, row, onMedia);
    }
    return out;
  });
}

/** A typographic section's content as simple HTML from its values (the executor converts it to blocks). */
function contentHtml(section: Section): string {
  return section.leaves
    .filter((l) => l.kind !== 'icon')
    .map((l) => {
      const tag = /h([1-6])$/.exec(l.path)?.[0] ?? (l.kind === 'heading' ? 'h2' : 'p');
      if (l.kind === 'image') return `<img src="${l.src}" alt="${l.sample}">`;
      if (l.kind === 'link') return `<p><a href="${l.href ?? '#'}">${l.sample}</a></p>`;
      return `<${tag}>${l.sample}</${tag}>`;
    })
    .join('\n');
}

/**
 * Keeps the proposal's decisions that hold up, and takes the draft's for the rest: parts must match
 * the model; post types and taxonomies must exist or be declared new; values must exist; new labels
 * must be in the mockups.
 */
export function checkProposal(input: Pick<PlanInput, 'model' | 'schema' | 'proposal' | 'draft' | 'vocabulary'>, warnings: string[]): { proposal: Proposal } {
  const { model, schema, proposal, draft, vocabulary: vocab } = input;
  if (proposal === draft) return { proposal: draft };
  const sections = new Map(model.pages.flatMap((p) => p.sections.map((s) => [`${p.file}#${s.path}`, s] as const)));
  const newTypes = new Set(proposal.postTypes.filter((t) => /^[a-z][a-z0-9_]{0,19}$/.test(t.name) && !RESERVED_TYPES.has(t.name) && labelSource(t.label, vocab)).map((t) => t.name));
  for (const t of proposal.postTypes) if (!newTypes.has(t.name)) warnings.push(`AI: post type "${t.name}" (${t.label}) refused: invalid name or a label not in the mockups`);
  const newTaxes = new Set(proposal.taxonomies.filter((t) => /^[a-z][a-z0-9_]{0,31}$/.test(t.name) && labelSource(t.label, vocab)).map((t) => t.name));
  const typeOk = (t: string | null) => t === null || t === 'page' || Boolean(schema.post_types[t]) || newTypes.has(t);
  const taxOk = (t: string | null) => t === null || Boolean(schema.taxonomies[t]) || newTaxes.has(t) || draft.taxonomies.some((x) => x.name === t);

  const draftParts = new Map(draft.parts.map((p) => [partKey(p), p]));
  const checked: ProposalPart[] = [];
  for (const d of draft.parts) {
    const p = proposal.parts.find((x) => partKey(x) === partKey(d));
    if (!p) {
      checked.push(d);
      continue;
    }
    const s = sections.get(`${p.page}#${p.path}`)!;
    const scope: Leaf[] = p.collection === null ? s.leaves : (s.collections.find((c) => c.path === p.collection)?.leaves ?? []);
    const paths = new Set(['', ...scope.map((l) => l.path)]);
    const problems: string[] = [];
    if (!typeOk(p.postType)) problems.push(`unknown post type ${p.postType}`);
    if (!taxOk(p.taxonomy)) problems.push(`unknown taxonomy ${p.taxonomy}`);
    if (p.binding === 'query' && !p.postType) problems.push('a list without a post type');
    if (p.binding === 'block' && !p.block) problems.push('a block without a name');
    const fields = p.fields.filter((f) => {
      if (!paths.has(f.path)) return problems.push(`no value at ${f.path}`), false;
      f.name = snake(f.name) || 'value';
      const asDrafted = d.fields.some((x) => x.path === f.path && x.label === f.label);
      if (!f.core && !asDrafted && !labelSource(f.label, vocab)) {
        warnings.push(`AI: label "${f.label}" (${p.page} ${p.component}) isn't in the mockups; using "${humanize(f.name)}"`);
        f.label = humanize(f.name);
      }
      return true;
    });
    // A value the rules mapped to WordPress's own field (an event's date, the title, the image) stays
    // there unless the AI maps that field to another value: as an ACF field the entry would lose it
    // (an event with no date, a post with no featured image).
    for (const df of d.fields.filter((x) => x.core)) {
      if (fields.some((x) => x.core === df.core)) continue;
      const at = fields.findIndex((x) => x.path === df.path);
      if (at >= 0) fields[at] = df;
      else fields.push(df);
      warnings.push(`AI: ${p.page} ${p.component}${p.collection ? ` list ${p.collection}` : ''}: kept ${df.path} as WordPress's ${df.core}`);
    }
    if (problems.length) {
      warnings.push(`AI: ${p.page} ${p.component}${p.collection ? ` list ${p.collection}` : ''} kept as the rules had it (${problems.join('; ')})`);
      checked.push(d);
    } else checked.push({ ...p, fields });
  }
  for (const p of proposal.parts) if (!draftParts.has(partKey(p))) warnings.push(`AI: ignored a part the model doesn't have (${p.page} ${p.path} ${p.collection ?? ''})`);

  const pages = draft.pages.map((d) => {
    const p = proposal.pages.find((x) => x.page === d.page);
    if (!p) return d;
    if (!typeOk(p.postType) || (p.kind === 'single' && !p.postType)) {
      warnings.push(`AI: ${p.page} kept as ${d.kind} (post type ${p.postType} unknown)`);
      return d;
    }
    if (!labelSource(p.title, vocab)) return { ...p, title: d.title };
    return p;
  });
  return { proposal: { pages, postTypes: proposal.postTypes.filter((t) => newTypes.has(t.name)), taxonomies: [...draft.taxonomies, ...proposal.taxonomies.filter((t) => newTaxes.has(t.name) && !draft.taxonomies.some((x) => x.name === t.name))], parts: checked } };
}
