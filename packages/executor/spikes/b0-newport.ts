/**
 * Build-from-design spike B0 (docs/build/PLAN.md): the database half of B0 on the Newport Beach
 * intranet target. The theme half is the change set in dist/build/newport/B0/.
 *
 *   pnpm --filter @wm/executor exec tsx spikes/b0-newport.ts            write (snapshot first)
 *   pnpm --filter @wm/executor exec tsx spikes/b0-newport.ts --dry      build and check the page only
 *   pnpm --filter @wm/executor exec tsx spikes/b0-newport.ts --rollback restore the snapshot
 *
 * It does what B4's executor will do for these parts, by hand:
 *  1. Snapshots everything it changes to dist/build/newport/B0/snapshot.json (only on the first run).
 *  2. Adds the fields the new block markup needs to two existing ACF field groups (through the
 *     bridge, so they stay normal ACF groups): a section heading on Clickable Images and Image +
 *     Text Card, a description on each clickable image, a link on each card.
 *  3. Uploads the mockup images the page uses.
 *  4. Creates the "Page Builder Blocks" page from page-builder1.html: the typography section as core
 *     blocks (via htmlToBlocks), then the two ACF blocks filled with the mockup's text.
 *  5. Replaces the items of "Main Menu" (the sidebar) and "Footer Menu" with the mockup's links.
 *  6. Sets the site title and tagline to the mockup's ("City of Newport Beach", "Employee Portal").
 *
 * All text is taken verbatim from the mockup. Links the mockup leaves as "#" (pages that don't
 * exist yet) stay "#".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acfBlock, group, htmlToBlocks, loadWordPress, serializeBlocks, validateSerialized } from '@wm/blocks';
import { WpClient } from '@wm/wp-client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.loadEnvFile(resolve(root, '.env'));
const MOCKUP = resolve(root, 'inputs/newport-beach/html/Newport-beach');
const OUT = resolve(root, 'dist/build/newport/B0');
const SNAPSHOT = resolve(OUT, 'snapshot.json');
const STATE = resolve(OUT, 'state.json');

const client = new WpClient({ baseUrl: need('NEWPORT_URL'), user: need('NEWPORT_USER'), appPassword: need('NEWPORT_APP_PASSWORD') });

const GROUPS = { clickable: 'group_5d9ba31e4841f', cards: 'group_5da4c468e63c3' } as const;
const PAGE_SLUG = 'page-builder-blocks';
const PAGE_TITLE = 'Page Builder Blocks'; // the Figma frame's name (the HTML's <h1> is a copy-paste "Classifieds")
const MENUS = { sidebar: 'Main Menu', footer: 'Footer Menu' } as const;
const DRY = process.argv.includes('--dry');

interface AcfField {
  key: string;
  name: string;
  type: string;
  sub_fields?: AcfField[];
  [k: string]: unknown;
}
interface AcfGroup {
  key: string;
  title: string;
  fields: AcfField[];
  [k: string]: unknown;
}
interface Schema {
  acf: { field_groups: AcfGroup[] };
}
interface Menu {
  id: number;
  name: string;
}
interface MenuItem {
  id: number;
  title: { rendered: string };
  url: string;
  parent: number;
  menu_order: number;
  type: string;
  object: string;
  object_id: number;
  target: string;
}
interface Snapshot {
  takenAt: string;
  groups: AcfGroup[];
  menus: { name: string; id: number; items: MenuItem[] }[];
  settings: { title: string; description: string };
}
interface State {
  media: Record<string, { id: number; url: string }>;
  pageId?: number;
  menuItems: Record<string, number[]>;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

const log = (msg: string) => console.log(msg);
const save = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const load = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

// ---------------------------------------------------------------------------
// Snapshot

async function fieldGroups(): Promise<AcfGroup[]> {
  const schema = await client.get<Schema>('/website-mover/v1/schema');
  return Object.values(GROUPS).map((key) => {
    const g = schema.acf.field_groups.find((x) => x.key === key);
    if (!g) throw new Error(`Field group ${key} is missing on the target`);
    return g;
  });
}

async function menu(name: string): Promise<Menu> {
  const menus = await client.get<Menu[]>('/wp/v2/menus', { per_page: 100 });
  const m = menus.find((x) => x.name === name);
  if (!m) throw new Error(`Menu "${name}" is missing on the target`);
  return m;
}

const menuItems = (id: number) => client.get<MenuItem[]>('/wp/v2/menu-items', { menus: id, per_page: 100 });

async function snapshot(): Promise<Snapshot> {
  if (existsSync(SNAPSHOT)) {
    log(`Snapshot: keeping the first one (${SNAPSHOT})`);
    return load<Snapshot>(SNAPSHOT);
  }
  const settings = await client.get<{ title: string; description: string }>('/wp/v2/settings');
  const snap: Snapshot = {
    takenAt: new Date().toISOString(),
    groups: await fieldGroups(),
    menus: await Promise.all(Object.values(MENUS).map(async (name) => {
      const m = await menu(name);
      return { name, id: m.id, items: await menuItems(m.id) };
    })),
    settings: { title: settings.title, description: settings.description },
  };
  save(SNAPSHOT, snap);
  log(`Snapshot: ${SNAPSHOT}`);
  return snap;
}

// ---------------------------------------------------------------------------
// Field groups

/** A field as ACF's import expects it: the schema read adds runtime keys (ID, value, prefix…). */
function clean(f: AcfField): AcfField {
  const out: AcfField = { ...f };
  for (const k of ['ID', 'id', 'class', 'prefix', 'value', '_name', '_valid', 'parent', 'parent_repeater', 'aria-label', 'menu_order']) delete out[k];
  if (f.sub_fields) out.sub_fields = f.sub_fields.map(clean);
  return out;
}

function cleanGroup(g: AcfGroup): AcfGroup {
  const out: AcfGroup = { ...g, fields: g.fields.map(clean) };
  for (const k of ['ID', 'local', 'local_file', '_valid', 'modified']) delete out[k];
  return out;
}

const heading = (key: string): AcfField => ({
  key,
  label: 'Section Heading',
  name: 'section_heading',
  type: 'text',
  instructions: 'Optional heading above the block.',
});

/** Inserts `field` after the field named `after` (or first), unless a field with its key exists. */
function withField(fields: AcfField[], field: AcfField, after?: string): AcfField[] {
  if (fields.some((f) => f.key === field.key)) return fields;
  const i = after ? fields.findIndex((f) => f.name === after) + 1 : 0;
  return [...fields.slice(0, i), field, ...fields.slice(i)];
}

function updatedGroups(groups: AcfGroup[]): AcfGroup[] {
  return groups.map((g0) => {
    const g = cleanGroup(g0);
    if (g.key === GROUPS.clickable) {
      g.fields = withField(g.fields, heading('field_wm_nb_ci_section_heading'));
      g.fields = g.fields.map((f) =>
        f.name === 'angled_clickable_images'
          ? {
              ...f,
              sub_fields: withField(
                f.sub_fields ?? [],
                { key: 'field_wm_nb_ci_description', label: 'Description', name: 'description', type: 'textarea', rows: 2, new_lines: '', instructions: 'Optional short text under the title.' },
                'link',
              ),
            }
          : f,
      );
    } else {
      g.fields = withField(g.fields, heading('field_wm_nb_itc_section_heading'));
      g.fields = g.fields.map((f) =>
        f.name === 'cards'
          ? {
              ...f,
              sub_fields: withField(
                f.sub_fields ?? [],
                { key: 'field_wm_nb_itc_card_link', label: 'Card Link', name: 'card_link', type: 'link', return_format: 'array', instructions: "Makes the whole card a link. A card with a link doesn't show its call to action." },
                'paragraph',
              ),
            }
          : f,
      );
    }
    return g;
  });
}

/** Field key by name path, e.g. key(g, 'cards', 'title'). */
function key(g: AcfGroup, ...path: string[]): string {
  let fields = g.fields;
  let found: AcfField | undefined;
  for (const name of path) {
    found = fields.find((f) => f.name === name);
    if (!found) throw new Error(`No field ${path.join('.')} in ${g.title}`);
    fields = found.sub_fields ?? [];
  }
  return found!.key;
}

// ---------------------------------------------------------------------------
// Media

async function uploadImage(state: State, file: string): Promise<{ id: number; url: string }> {
  if (state.media[file]) return state.media[file]!;
  const data = new Uint8Array(readFileSync(resolve(MOCKUP, 'img', file)));
  const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg';
  const media = await client.upload<{ id: number; source_url: string }>(data, file, type);
  state.media[file] = { id: media.id, url: media.source_url };
  save(STATE, state);
  log(`Media: ${file} → #${media.id}`);
  return state.media[file]!;
}

// ---------------------------------------------------------------------------
// Page content

function mockupDocument(): Document {
  loadWordPress(); // sets up the DOM globals
  return new DOMParser().parseFromString(readFileSync(resolve(MOCKUP, 'page-builder1.html'), 'utf8'), 'text/html');
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The typography section (.generic_middle_block) as core blocks, in a group with the same class. */
function typographyBlocks(doc: Document, image: { id: number; url: string }) {
  const section = doc.querySelector('.generic_middle_block')!.cloneNode(true) as Element;
  // Not in B0: the date style sample and the document links (the Resource List block, a later milestone).
  section.querySelectorAll('span.date, .document_era').forEach((el) => el.remove());
  // The mockup marks its quote up as a div; the quote block's own markup is a blockquote.
  section.querySelectorAll('div.wp-block-quote').forEach((div) => {
    const bq = doc.createElement('blockquote');
    bq.className = 'wp-block-quote';
    bq.innerHTML = div.innerHTML;
    div.replaceWith(bq);
  });
  section.querySelectorAll('img').forEach((img) => img.setAttribute('src', image.url));
  const warnings: string[] = [];
  const inner = htmlToBlocks(section.innerHTML, {
    onWarning: (m) => warnings.push(m),
    resolveImage: () => image,
  });
  for (const w of warnings) log(`  convert warning: ${w}`);
  return group(inner, { className: 'generic_middle_block', layout: { type: 'default' } });
}

function clickableImages(doc: Document, g: AcfGroup, image: { id: number }) {
  const section = doc.querySelector('section.img_buttons')!;
  const items = [...section.querySelectorAll('.img_btn_col')];
  const data: Record<string, unknown> = {
    how_many_across: String(items.length),
    _how_many_across: key(g, 'how_many_across'),
    align_text: 'Left',
    _align_text: key(g, 'align_text'),
    section_heading: text(section.querySelector('.topTitle h2')),
    _section_heading: key(g, 'section_heading'),
    angled_clickable_images: items.length,
    _angled_clickable_images: key(g, 'angled_clickable_images'),
  };
  items.forEach((col, i) => {
    const p = `angled_clickable_images_${i}_`;
    Object.assign(data, {
      [`${p}image`]: image.id,
      [`_${p}image`]: key(g, 'angled_clickable_images', 'image'),
      [`${p}link`]: { title: text(col.querySelector('h3')), url: col.querySelector('a')?.getAttribute('href')?.trim() || '#', target: '' },
      [`_${p}link`]: key(g, 'angled_clickable_images', 'link'),
      [`${p}description`]: text(col.querySelector('.img_block_title p')),
      [`_${p}description`]: key(g, 'angled_clickable_images', 'description'),
    });
  });
  return acfBlock('acf/angled-clickable-image', data);
}

/** "June 22, 2026" → "20260622" (ACF stores date pickers as Ymd). */
function ymd(s: string): string {
  const d = new Date(`${s} 12:00 UTC`);
  if (Number.isNaN(d.getTime())) throw new Error(`Not a date: ${s}`);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function imageTextCards(doc: Document, g: AcfGroup, image: { id: number }) {
  const section = doc.querySelector('section.img_text_card')!;
  const cards = [...section.querySelectorAll('.img_text_card_col')];
  const data: Record<string, unknown> = {
    how_many_across: String(cards.length),
    _how_many_across: key(g, 'how_many_across'),
    align_text: 'Left',
    _align_text: key(g, 'align_text'),
    text_card_background: 'Visible',
    _text_card_background: key(g, 'text_card_background'),
    section_heading: text(section.querySelector('.topTitle h2')),
    _section_heading: key(g, 'section_heading'),
    cards: cards.length,
    _cards: key(g, 'cards'),
  };
  cards.forEach((col, i) => {
    const p = `cards_${i}_`;
    const sub = (name: string) => key(g, 'cards', name);
    Object.assign(data, {
      [`${p}category_name`]: text(col.querySelector('.category')),
      [`_${p}category_name`]: sub('category_name'),
      [`${p}select_date`]: ymd(text(col.querySelector('.date'))),
      [`_${p}select_date`]: sub('select_date'),
      [`${p}image`]: image.id,
      [`_${p}image`]: sub('image'),
      [`${p}title`]: text(col.querySelector('h3')),
      [`_${p}title`]: sub('title'),
      [`${p}paragraph`]: text(col.querySelector('.text_card_block p')),
      [`_${p}paragraph`]: sub('paragraph'),
      [`${p}card_link`]: { title: '', url: col.querySelector('a')?.getAttribute('href')?.trim() || '#', target: '' },
      [`_${p}card_link`]: sub('card_link'),
    });
  });
  return acfBlock('acf/image-text-card', data);
}

// ---------------------------------------------------------------------------
// Menus

interface LinkSpec {
  title: string;
  url: string;
  children?: LinkSpec[];
}

/** The mockup's sidebar and footer links. Its .html links become the site URL or "#". */
function mockupMenus(doc: Document, home: string): Record<keyof typeof MENUS, LinkSpec[]> {
  const url = (a: Element) => {
    const href = a.getAttribute('href') ?? '#';
    return /^(index|home1)\.html$/.test(href) ? home : '#'; // other mockup pages don't exist on the site yet
  };
  const items = (ul: Element | null): LinkSpec[] =>
    [...(ul?.children ?? [])].map((li) => {
      const a = li.querySelector(':scope > a')!;
      const sub = li.querySelector(':scope > ul');
      return { title: text(a), url: url(a), ...(sub ? { children: items(sub) } : {}) };
    });
  return {
    sidebar: items(doc.querySelector('.page_sidebar__nav > ul')),
    footer: items(doc.querySelector('.footer_nav > ul')),
  };
}

async function replaceMenu(state: State, name: string, links: LinkSpec[]) {
  const m = await menu(name);
  for (const item of await menuItems(m.id)) await client.delete(`/wp/v2/menu-items/${item.id}`, { force: 'true' });
  const ids: number[] = [];
  let order = 1;
  const add = async (link: LinkSpec, parent: number) => {
    const item = await client.post<{ id: number }>('/wp/v2/menu-items', {
      title: link.title, url: link.url, type: 'custom', status: 'publish', menus: m.id, parent, menu_order: order++,
    });
    ids.push(item.id);
    for (const child of link.children ?? []) await add(child, item.id);
  };
  for (const link of links) await add(link, 0);
  state.menuItems[name] = ids;
  save(STATE, state);
  log(`Menu: "${name}" → ${ids.length} links`);
}

// ---------------------------------------------------------------------------
// Rollback

async function rollback() {
  if (!existsSync(SNAPSHOT)) throw new Error(`No snapshot at ${SNAPSHOT}`);
  const snap = load<Snapshot>(SNAPSHOT);
  const state: State = existsSync(STATE) ? load<State>(STATE) : { media: {}, menuItems: {} };
  for (const g of snap.groups) {
    await client.post('/website-mover/v1/acf/field-groups', cleanGroup(g));
    log(`Field group restored: ${g.title}`);
  }
  for (const m of snap.menus) {
    for (const item of await menuItems(m.id)) await client.delete(`/wp/v2/menu-items/${item.id}`, { force: 'true' });
    const idMap = new Map<number, number>();
    for (const item of [...m.items].sort((a, b) => a.menu_order - b.menu_order)) {
      const created = await client.post<{ id: number }>('/wp/v2/menu-items', {
        title: item.title.rendered, url: item.url, type: item.type, object: item.object, object_id: item.object_id,
        target: item.target, status: 'publish', menus: m.id, parent: idMap.get(item.parent) ?? 0, menu_order: item.menu_order,
      });
      idMap.set(item.id, created.id);
    }
    log(`Menu restored: "${m.name}" (${m.items.length} links)`);
  }
  await client.post('/wp/v2/settings', snap.settings);
  log('Settings restored');
  if (state.pageId) {
    await client.delete(`/wp/v2/pages/${state.pageId}`, { force: 'true' });
    log(`Page deleted: #${state.pageId}`);
  }
  for (const [file, m] of Object.entries(state.media)) {
    await client.delete(`/wp/v2/media/${m.id}`, { force: 'true' });
    log(`Media deleted: ${file} #${m.id}`);
  }
  save(STATE, { media: {}, menuItems: {} });
}

// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--rollback')) return rollback();

  const snap = DRY ? ({ groups: await fieldGroups() } as Snapshot) : await snapshot();
  const state: State = existsSync(STATE) ? load<State>(STATE) : { media: {}, menuItems: {} };

  // 2. Field groups
  const groups = updatedGroups(snap.groups);
  for (const g of DRY ? [] : groups) {
    await client.post('/website-mover/v1/acf/field-groups', g);
    log(`Field group: ${g.title} (section heading, ${g.key === GROUPS.clickable ? 'image description' : 'card link'})`);
  }
  const [clickableGroup, cardsGroup] = groups as [AcfGroup, AcfGroup];

  // 3. Media
  const upload = (file: string) => (DRY ? Promise.resolve({ id: 1, url: `https://example.org/${file}` }) : uploadImage(state, file));
  const click = await upload('click1.png');
  const card = await upload('card1.png');
  const placeholder = await upload('image-placeholder.png');

  // 4. Page
  const doc = mockupDocument();
  const blocks = [typographyBlocks(doc, placeholder), clickableImages(doc, clickableGroup, click), imageTextCards(doc, cardsGroup, card)];
  const content = serializeBlocks(blocks);
  const report = validateSerialized(content);
  log(`Blocks: ${report.blockCount} (${[...new Set(report.names)].join(', ')}), valid: ${report.ok}`);
  for (const issue of [...report.errors, ...report.warnings]) log(`  ${JSON.stringify(issue)}`);
  writeFileSync(resolve(OUT, 'page-builder-blocks.html'), content);
  if (!report.ok) throw new Error('The page content is not valid block markup');
  if (DRY) return log(`Dry run: content in ${resolve(OUT, 'page-builder-blocks.html')}`);
  const body = { title: PAGE_TITLE, slug: PAGE_SLUG, status: 'publish', content, template: '' };
  const existing = state.pageId ?? (await client.get<{ id: number }[]>('/wp/v2/pages', { slug: PAGE_SLUG, status: 'publish,draft' }))[0]?.id;
  const page = existing
    ? await client.post<{ id: number; link: string }>(`/wp/v2/pages/${existing}`, body)
    : await client.post<{ id: number; link: string }>('/wp/v2/pages', body);
  state.pageId = page.id;
  save(STATE, state);
  log(`Page: ${PAGE_TITLE} #${page.id} ${page.link}`);

  // 5. Menus
  const links = mockupMenus(doc, `${client.baseUrl}/`);
  await replaceMenu(state, MENUS.sidebar, links.sidebar);
  await replaceMenu(state, MENUS.footer, links.footer);

  // 6. Site title and tagline (the mockup's header and footer)
  const brand = doc.querySelector('.navbar-brand span')!;
  const tagline = text(brand.querySelector('small'));
  const title = text(brand).replace(tagline, '').trim();
  await client.post('/wp/v2/settings', { title, description: tagline });
  log(`Settings: title "${title}", tagline "${tagline}"`);

  log(`Done. State: ${STATE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
