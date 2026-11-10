/**
 * Build-from-design spike B0.2 (docs/build/PLAN.md): the database half of the Newport dashboard.
 * The theme half (template-home.php, inc/newport-home.php) is the change set in dist/build/newport/B0.2/.
 *
 *   pnpm --filter @wm/executor exec tsx spikes/b02-newport-home.ts             write (snapshot first)
 *   pnpm --filter @wm/executor exec tsx spikes/b02-newport-home.ts --rollback  undo
 *
 * 1. Snapshot: the three field groups it changes, the home page's field values, the seed alerts' status.
 * 2. Fields: Homepage Details gets the dashboard's headings, "View all" links, slide text, Throwback
 *    Thursday and Follow Us; Alert Details gets a level (general, urgent, emergency); Person Details
 *    gets a start date and department.
 * 3. Post types (ACF, through the bridge): Training Updates, Classifieds, Employee Perks, each with a
 *    category taxonomy.
 * 4. Sample content from index.html, verbatim: 3 posts (Rabbit Reads), 3 events, 3 of each new type,
 *    4 people, 3 alerts, and the home page's fields (3 slides, 14 quick links, …). The seed's sample
 *    alerts are set to draft so the dashboard shows the mockup's.
 *
 * State (created ids) is in dist/build/newport/B0.2/state.json, so a re-run updates instead of duplicating.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WpClient } from '@wm/wp-client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
process.loadEnvFile(resolve(root, '.env'));
const MOCKUP = resolve(root, 'inputs/newport-beach/html/Newport-beach');
const OUT = resolve(root, 'dist/build/newport/B0.2');
const MEDIA = resolve(OUT, 'media'); // index.html's photos, resized (4096px PNGs → 1280–2184px JPEGs)
const SNAPSHOT = resolve(OUT, 'snapshot.json');
const STATE = resolve(OUT, 'state.json');
const HOME = 713;

const client = new WpClient({ baseUrl: need('NEWPORT_URL'), user: need('NEWPORT_USER'), appPassword: need('NEWPORT_APP_PASSWORD') });
const GROUPS = { home: 'group_5fbc714d1a113', alert: 'group_6308657f74032', person: 'group_5f35f63c1a6e1' } as const;
const TYPES = [
  { postType: 'training_update', label: 'Training Updates', singular: 'Training Update', slug: 'training-updates', taxonomy: 'training_category', taxLabel: 'Training Categories', taxSingular: 'Training Category' },
  { postType: 'classified', label: 'Classifieds', singular: 'Classified', slug: 'classifieds', taxonomy: 'classified_category', taxLabel: 'Classified Categories', taxSingular: 'Classified Category' },
  { postType: 'perk', label: 'Employee Perks', singular: 'Employee Perk', slug: 'employee-perks', taxonomy: 'perk_category', taxLabel: 'Perk Categories', taxSingular: 'Perk Category' },
] as const;

interface AcfField { key: string; name: string; type: string; sub_fields?: AcfField[]; [k: string]: unknown }
interface AcfGroup { key: string; title: string; fields: AcfField[]; [k: string]: unknown }
interface Snapshot { takenAt: string; groups: AcfGroup[]; homeFields: Record<string, unknown>; alerts: { id: number; status: string }[] }
interface State { media: Record<string, number>; terms: Record<string, number>; posts: Record<string, { type: string; id: number }>; draftedAlerts: number[] }

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}
const log = (m: string) => console.log(m);
const save = (f: string, d: unknown) => writeFileSync(f, JSON.stringify(d, null, 2) + '\n');
const load = <T>(f: string): T => JSON.parse(readFileSync(f, 'utf8')) as T;
const state: State = existsSync(STATE) ? load<State>(STATE) : { media: {}, terms: {}, posts: {}, draftedAlerts: [] };
const keep = () => save(STATE, state);

// ---------------------------------------------------------------------------
// Field groups

async function groups(): Promise<AcfGroup[]> {
  const schema = await client.get<{ acf: { field_groups: AcfGroup[] } }>('/website-mover/v1/schema');
  return Object.values(GROUPS).map((k) => {
    const g = schema.acf.field_groups.find((x) => x.key === k);
    if (!g) throw new Error(`Field group ${k} is missing`);
    return g;
  });
}

function clean<T extends AcfField | AcfGroup>(f: T): T {
  const out = { ...f } as Record<string, unknown>;
  for (const k of ['ID', 'id', 'class', 'prefix', 'value', '_name', '_valid', 'parent', 'parent_repeater', 'aria-label', 'menu_order', 'local', 'local_file', 'modified']) delete out[k];
  if ('fields' in f) out.fields = (f as AcfGroup).fields.map(clean);
  if ((f as AcfField).sub_fields) out.sub_fields = (f as AcfField).sub_fields!.map(clean);
  return out as T;
}

function add(fields: AcfField[], field: AcfField, after?: string): AcfField[] {
  if (fields.some((f) => f.key === field.key)) return fields;
  const i = after ? fields.findIndex((f) => f.name === after) + 1 : fields.length;
  return [...fields.slice(0, i || fields.length), field, ...fields.slice(i || fields.length)];
}

const k = (name: string) => `field_wm_nb_home_${name}`;
const text = (name: string, label: string, extra: Record<string, unknown> = {}): AcfField => ({ key: k(name), name, label, type: 'text', ...extra });
const link = (name: string, label: string): AcfField => ({ key: k(name), name, label, type: 'link', return_format: 'array', instructions: 'The "View all" link under the list. Its text is the link text.' });

function updated(gs: AcfGroup[]): AcfGroup[] {
  return gs.map((g0) => {
    const g = clean(g0);
    if (g.key === GROUPS.home) {
      g.fields = g.fields.map((f) =>
        f.name === 'banner' ? { ...f, sub_fields: add(f.sub_fields ?? [], { key: k('banner_text'), name: 'text', label: 'Text', type: 'textarea', rows: 2, new_lines: '' }, 'title') } : f,
      );
      g.fields = add(g.fields, text('quick_links_heading', 'Quick Links Heading'), 'banner_icon');
      const dashboard: AcfField[] = [
        { key: k('tab_dashboard'), name: '', label: 'Dashboard', type: 'tab', placement: 'top' },
        text('news_heading', 'News Heading', { instructions: 'Shows the 3 latest posts, or the ones picked under News.' }), link('news_more', 'News Link'),
        text('calendar_heading', 'Calendar Heading', { instructions: 'Shows the month and the next 3 events, or the ones picked under Events.' }), link('calendar_more', 'Calendar Link'),
        text('training_heading', 'Training Updates Heading'), link('training_more', 'Training Updates Link'),
        text('classifieds_heading', 'Classifieds Heading'), link('classifieds_more', 'Classifieds Link'),
        text('welcome_heading', 'Welcome Aboard Heading', { instructions: 'Shows the 4 people with the latest start date.' }), link('welcome_more', 'Welcome Aboard Link'),
        text('perks_heading', 'Employee Perks Heading'), link('perks_more', 'Employee Perks Link'),
        { key: k('tab_throwback'), name: '', label: 'Throwback Thursday', type: 'tab', placement: 'top' },
        text('throwback_heading', 'Heading'),
        { key: k('throwback_image'), name: 'throwback_image', label: 'Image', type: 'image', return_format: 'array', preview_size: 'medium' },
        text('throwback_title', 'Image Title'),
        { key: k('throwback_text'), name: 'throwback_text', label: 'Description', type: 'textarea', rows: 2, new_lines: '' },
        { key: k('tab_follow'), name: '', label: 'Follow Us', type: 'tab', placement: 'top' },
        text('follow_heading', 'Heading'),
        {
          key: k('follow_items'), name: 'follow_items', label: 'Images', type: 'repeater', layout: 'table', button_label: 'Add Image',
          sub_fields: [
            { key: k('follow_image'), name: 'image', label: 'Image', type: 'image', return_format: 'array', preview_size: 'thumbnail' },
            { key: k('follow_link'), name: 'link', label: 'Link', type: 'link', return_format: 'array' },
          ],
        },
      ];
      for (const f of dashboard) g.fields = add(g.fields, f);
    } else if (g.key === GROUPS.alert) {
      g.fields = add(g.fields, {
        key: 'field_wm_nb_alert_level', name: 'alert_level', label: 'Level', type: 'radio', layout: 'horizontal', return_format: 'value', default_value: 'general',
        choices: { general: 'General (green)', urgent: 'Urgent (orange)', emergency: 'Emergency (red)' },
      }, 'alert_text');
    } else {
      g.fields = add(g.fields, { key: 'field_wm_nb_person_start_date', name: 'start_date', label: 'Start Date', type: 'date_picker', display_format: 'F j, Y', return_format: 'Ymd', instructions: 'New hires with a start date are listed under Welcome Aboard on the dashboard.' }, 'title');
      g.fields = add(g.fields, { key: 'field_wm_nb_person_department', name: 'department', label: 'Department', type: 'text' }, 'start_date');
    }
    return g;
  });
}

// ---------------------------------------------------------------------------
// Helpers

async function media(file: string, dir: string, alt = ''): Promise<number> {
  if (state.media[file]) return state.media[file]!;
  const type = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const m = await client.upload<{ id: number }>(new Uint8Array(readFileSync(resolve(dir, file))), file, type);
  if (alt) await client.post(`/wp/v2/media/${m.id}`, { alt_text: alt });
  state.media[file] = m.id;
  keep();
  log(`Media: ${file} → #${m.id}`);
  return m.id;
}

async function term(rest: string, name: string): Promise<number> {
  const key = `${rest}:${name}`;
  if (state.terms[key]) return state.terms[key]!;
  const found = (await client.get<{ id: number; name: string }[]>(`/wp/v2/${rest}`, { search: name })).find((t) => t.name === name);
  const id = found ? found.id : (await client.post<{ id: number }>(`/wp/v2/${rest}`, { name })).id;
  if (!found) state.terms[key] = id; // only terms we created are removed on rollback
  keep();
  return id;
}

/** Creates or updates a post (by its key in state), then sets ACF fields through the bridge. */
async function post(key: string, type: string, rest: string, body: Record<string, unknown>, fields?: Record<string, unknown>): Promise<number> {
  const existing = state.posts[key];
  const res = existing
    ? await client.post<{ id: number }>(`/wp/v2/${rest}/${existing.id}`, body)
    : await client.post<{ id: number }>(`/wp/v2/${rest}`, { status: 'publish', ...body });
  state.posts[key] = { type: rest, id: res.id };
  keep();
  if (fields) await client.post(`/website-mover/v1/acf/posts/${res.id}/fields`, { values: fields });
  return res.id;
}

/** Events go through The Events Calendar's API (it keeps its own date tables). */
async function event(key: string, body: Record<string, unknown>): Promise<number> {
  const existing = state.posts[key];
  const res = existing
    ? await client.post<{ id: number }>(`/tribe/events/v1/events/${existing.id}`, body)
    : await client.post<{ id: number }>('/tribe/events/v1/events', { status: 'publish', ...body });
  state.posts[key] = { type: 'tribe_events', id: res.id };
  keep();
  return res.id;
}

const link_ = (title: string, url = '#') => ({ title, url, target: '' });

// ---------------------------------------------------------------------------

async function run() {
  mkdirSync(OUT, { recursive: true });
  const gs = await groups();
  if (!existsSync(SNAPSHOT)) {
    const home = gs[0]!;
    const names = home.fields.filter((f) => f.name).map((f) => f.key).join(',');
    const alerts = await client.get<{ id: number; status: string }[]>('/wp/v2/alert', { per_page: 100, status: 'publish,draft,private', _fields: 'id,status' });
    const snap: Snapshot = {
      takenAt: new Date().toISOString(),
      groups: gs,
      homeFields: await client.get(`/website-mover/v1/acf/posts/${HOME}/fields`, { names }),
      alerts,
    };
    save(SNAPSHOT, snap);
    log(`Snapshot: ${SNAPSHOT}`);
  }
  const snap = load<Snapshot>(SNAPSHOT);

  // 2. Fields
  for (const g of updated(snap.groups)) {
    await client.post('/website-mover/v1/acf/field-groups', g);
    log(`Field group: ${g.title}`);
  }

  // 3. Post types and taxonomies
  for (const t of TYPES) {
    await client.post('/website-mover/v1/acf/taxonomies', {
      key: `taxonomy_wm_${t.taxonomy}`, title: t.taxLabel, taxonomy: t.taxonomy, object_type: [t.postType],
      hierarchical: true, public: true, show_in_rest: true, labels: { name: t.taxLabel, singular_name: t.taxSingular },
    });
    await client.post('/website-mover/v1/acf/post-types', {
      key: `post_type_wm_${t.postType}`, title: t.label, post_type: t.postType, public: true, show_in_rest: true, has_archive: false,
      rewrite: { permalink_rewrite: 'custom_permalink', slug: t.slug, with_front: true },
      supports: ['title', 'editor', 'thumbnail', 'excerpt', 'author', 'custom-fields'], taxonomies: [t.taxonomy],
      labels: { name: t.label, singular_name: t.singular },
    });
    log(`Post type: ${t.label} (${t.postType}, ${t.taxonomy})`);
  }
  await client.post('/website-mover/v1/acf/field-groups', {
    key: 'group_wm_nb_perk_details', title: 'Employee Perk details', show_in_rest: 1,
    location: [[{ param: 'post_type', operator: '==', value: 'perk' }]],
    fields: [{ key: 'field_wm_nb_perk_department', name: 'department', label: 'Department', type: 'text' }],
  });
  // The new post types' REST routes exist from the next request on (ACF registers them on init).

  // 4. Sample content (index.html, verbatim)
  const photo = (f: string, alt: string) => media(f, MEDIA, alt);
  const hero = await photo('hero-home.jpg', 'Newport Beach coastline');
  const news = [
    await photo('news-card-1.jpg', 'Staff gathered at a city event'),
    await photo('news-card-2.jpg', 'Newport Beach harbor'),
    await photo('news-card-3.jpg', 'City team collaborating in a meeting'),
  ];
  const throwback = await photo('throwback.jpg', 'Historic photo of Newport Beach');
  const icon = (f: string) => media(f, resolve(MOCKUP, 'img'));

  const preview = '[preview text] Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam euismod, nisi vel consectetur interdum, nisl nunc egestas nunc, vitae tincidunt nisl nunc euismod nunc.';
  const cat = await term('categories', 'Category');
  const posts: number[] = [];
  for (const [i, title] of ['Rabbit Reads Two Line Title', 'Rabbit Reads Title', 'Rabbit Reads Title'].entries()) {
    posts.push(await post(`post:${i}`, 'post', 'posts', {
      title, excerpt: preview, content: `<!-- wp:paragraph -->\n<p>${preview}</p>\n<!-- /wp:paragraph -->`,
      categories: [cat], featured_media: news[i], date: '2026-06-22T09:00:00',
    }));
  }
  log(`Posts: ${posts.join(', ')}`);

  const evCat = await term('tribe_events_cat', 'Category');
  const events: number[] = [];
  for (const day of [6, 10, 15]) {
    const d = `2026-07-${String(day).padStart(2, '0')}`;
    events.push(await event(`event:${day}`, { title: 'Meeting/Event Title', start_date: `${d} 14:00:00`, end_date: `${d} 15:00:00`, categories: [evCat] }));
  }
  log(`Events: ${events.join(', ')}`);

  const lists: Record<string, [string, Record<string, unknown>?][]> = {
    training_update: [['Workplace Safety'], ['Workplace Safety'], ['Title of Training Material that might need more than one line to display']],
    classified: [['Item for Sale'], ['Item for Sale'], ['Item for Sale that might need more than one line to display']],
    perk: [['Employee Perk Title', { department: 'Department' }], ['Employee Perk Title that might need more than one line', { department: 'Department' }], ['Employee Perk Title', { department: 'Department' }]],
  };
  for (const t of TYPES) {
    const termId = await term(t.taxonomy, 'Category');
    // Created in reverse, so the newest (listed first) is the mockup's first item.
    const items = [...lists[t.postType]!.entries()].reverse();
    for (const [i, [title, fields]] of items) {
      const date = `2026-06-22T09:${String(10 - i).padStart(2, '0')}:00`; // the mockup's first item is the newest
      await post(`${t.postType}:${i}`, t.postType, t.postType, { title, date, [t.taxonomy]: [termId] }, fields);
    }
    log(`${t.label}: 3`);
  }

  for (let i = 0; i < 4; i++) {
    await post(`person:${i}`, 'people', 'people', { title: 'Employee Name' }, { start_date: '20260612', department: 'Department' });
  }
  log('People: 4 (Welcome Aboard)');

  const alerts = [
    ['general', 'Green for general announcements'],
    ['urgent', 'Orange for urgent matters, not emergencies. Alert banner can be more than one line long if needed. the text can wrap as neeeded'],
    ['emergency', 'For Emergencies ONLY'],
  ] as const;
  // Newest first within the same level doesn't matter here: one alert per level, ordered by level.
  for (const [level, tail] of alerts) {
    await post(`alert:${level}`, 'alert', 'alert', { title: `Optional Alert Banner (${level})` }, {
      alert_text: `<p>Optional Alert Banner. Optional <a href="#">hyperlink for more details</a>. ${tail}</p>`,
      alert_level: level,
      display_location: { template_location: 'Top Bar', location: 'Every Page' },
    });
  }
  const ours = new Set(Object.values(state.posts).map((p) => p.id));
  for (const a of snap.alerts.filter((a) => a.status === 'publish' && !ours.has(a.id))) {
    await client.post(`/wp/v2/alert/${a.id}`, { status: 'draft' });
    if (!state.draftedAlerts.includes(a.id)) state.draftedAlerts.push(a.id);
  }
  keep();
  log(`Alerts: 3 (seed alerts set to draft: ${state.draftedAlerts.join(', ') || 'none'})`);

  // Home page fields
  const slide = { select_image: hero, title: 'Content Headline for Hero slider content', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nam sit amet porttitor purus.', select_logo: '', link: link_('More About This') };
  const quick: [string, string][] = [
    ['icon-ql-newsletter.svg', 'City Manager\nNewsletter'], ['icon-ql-download.svg', 'Comp Cash Out\nRequest'], ['icon-ql-laptop.svg', 'Computer\nApplications'],
    ['icon-ql-user.svg', 'Contractor/Temp\nTermination Form'], ['icon-ql-files.svg', 'Documents\n& Forms'], ['icon-ql-download.svg', 'Employee\nDirectory'],
    ['icon-ql-download.svg', 'Employee\nWork Requests'], ['icon-ql-files.svg', 'ESS\n(Time Sheets)'], ['icon-ql-download.svg', 'GIS/Maps'],
    ['icon-ql-download.svg', 'IT Access Form'], ['icon-ql-download.svg', 'Performance\nPro Evaluations'], ['icon-ql-download.svg', 'Plan Document\nSearch'],
    ['icon-ql-download.svg', 'Recruitment\nRequest'], ['icon-ql-download.svg', 'Technology\nRequest Form'],
  ];
  const quickRows = [];
  for (const [file, title] of quick) quickRows.push({ banner_icon: await icon(file), icon_link: link_(title) });
  const values: Record<string, unknown> = {
    field_63e9f4feea081: [slide, slide, slide], // banner
    field_63e9fcde14de5: quickRows, // banner_icon (Quick Links)
    field_65f22687462f9: posts, // news_list
    field_65f227a5945e6: events, // events_list
    [k('quick_links_heading')]: 'Quick Links',
    [k('news_heading')]: 'Rabbit Reads', [k('news_more')]: link_('View All Rabbit Reads'),
    [k('calendar_heading')]: 'Calendar', [k('calendar_more')]: link_('View Full Calendar'),
    [k('training_heading')]: 'Training Updates', [k('training_more')]: link_('View All Training Updates'),
    [k('classifieds_heading')]: 'Classifieds', [k('classifieds_more')]: link_('View All Classifieds'),
    [k('welcome_heading')]: 'Welcome Aboard', [k('welcome_more')]: link_('View More'),
    [k('perks_heading')]: 'Employee Perks', [k('perks_more')]: link_('View All Employee Perks'),
    [k('throwback_heading')]: 'Throwback Thursday', [k('throwback_image')]: throwback, [k('throwback_title')]: 'Image Title',
    [k('throwback_text')]: 'Optional Additional Text Field for short description.',
    [k('follow_heading')]: 'Follow Us',
    [k('follow_items')]: news.map((id) => ({ image: id, link: link_('') })),
  };
  const res = await client.post<Record<string, string>>(`/website-mover/v1/acf/posts/${HOME}/fields`, { values });
  const bad = Object.entries(res).filter(([, v]) => v === 'unknown field');
  if (bad.length) throw new Error(`Unknown fields: ${bad.map(([n]) => n).join(', ')}`);
  log(`Home page fields: ${Object.keys(values).length}`);
  log(`Done. ${client.baseUrl}/`);
}

async function rollback() {
  const snap = load<Snapshot>(SNAPSHOT);
  await client.post(`/website-mover/v1/acf/posts/${HOME}/fields`, { values: snap.homeFields });
  log('Home page fields restored');
  for (const g of snap.groups) await client.post('/website-mover/v1/acf/field-groups', clean(g));
  log('Field groups restored');
  for (const [key, p] of Object.entries(state.posts)) {
    if (p.type === 'tribe_events') await client.delete(`/tribe/events/v1/events/${p.id}`, { force: 'true' });
    else await client.delete(`/wp/v2/${p.type}/${p.id}`, { force: 'true' });
    log(`Deleted ${key} #${p.id}`);
  }
  for (const [key, id] of Object.entries(state.terms)) await client.delete(`/wp/v2/${key.split(':')[0]}/${id}`, { force: 'true' });
  for (const id of state.draftedAlerts) await client.post(`/wp/v2/alert/${id}`, { status: 'publish' });
  for (const [file, id] of Object.entries(state.media)) await client.delete(`/wp/v2/media/${id}`, { force: 'true' });
  await client.post('/website-mover/v1/acf/trash', { type: 'acf-field-group', keys: ['group_wm_nb_perk_details'] });
  await client.post('/website-mover/v1/acf/trash', { type: 'acf-post-type', keys: TYPES.map((t) => `post_type_wm_${t.postType}`) });
  await client.post('/website-mover/v1/acf/trash', { type: 'acf-taxonomy', keys: TYPES.map((t) => `taxonomy_wm_${t.taxonomy}`) });
  save(STATE, { media: {}, terms: {}, posts: {}, draftedAlerts: [] });
  log('Rolled back');
}

(process.argv.includes('--rollback') ? rollback() : run()).catch((err) => {
  console.error(err);
  process.exit(1);
});
