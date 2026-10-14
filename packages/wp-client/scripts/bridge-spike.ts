/**
 * M0 spike: prove the bridge can set up the content model natively, and that a post with ACF
 * values can be written over the REST API with an Application Password.
 *
 * Targets the framework's own model: meetings are the `events` post type tagged with the
 * `meeting_event_type` term "meetings", using the field names the PlaneteriaWeb templates read
 * (single-events.php, functions.php meeting AJAX). Those definitions live in the seed's database,
 * not in git, so they are recreated here with the same slugs and field names.
 *
 * Run: pnpm exec tsx --env-file=.env packages/wp-client/scripts/bridge-spike.ts
 */
import { readFile } from 'node:fs/promises';
import { localSeedClient } from '../src/index.ts';

const wp = localSeedClient();
const log = (label: string, value: unknown) => console.log(`${label}:`, JSON.stringify(value));

const taxonomy = {
  key: 'taxonomy_wm_meeting_event_type',
  title: 'Event Types',
  taxonomy: 'meeting_event_type',
  object_type: ['events'],
  hierarchical: true,
  public: true,
  show_in_rest: true,
  labels: { name: 'Event Types', singular_name: 'Event Type' },
};

const postType = {
  key: 'post_type_wm_events',
  title: 'Events & Meetings',
  post_type: 'events',
  public: true,
  show_in_rest: true,
  has_archive: false,
  // TEC already uses /events/ for tribe_events, so the framework type gets its own slug.
  rewrite: { permalink_rewrite: 'custom_permalink', slug: 'meetings-events', with_front: true },
  supports: ['title', 'editor', 'thumbnail', 'excerpt', 'custom-fields'],
  taxonomies: ['meeting_event_type'],
  labels: { name: 'Events & Meetings', singular_name: 'Event' },
  menu_icon: { type: 'dashicons', value: 'dashicons-calendar-alt' },
};

const field = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
  key: `field_wm_meeting_${name}`,
  label: name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
  name,
  type,
  ...extra,
});

const fieldGroup = {
  key: 'group_wm_meeting_details',
  title: 'Meeting details',
  show_in_rest: 1,
  location: [[{ param: 'post_type', operator: '==', value: 'events' }]],
  fields: [
    field('meeting_date_and_start_time', 'date_time_picker', {
      display_format: 'F j, Y g:i a',
      return_format: 'Y-m-d H:i:s',
    }),
    field('meeting_end_time', 'time_picker', { display_format: 'g:i a', return_format: 'H:i:s' }),
    field('was_this_meeting_cancelled', 'true_false', { ui: 1 }),
    field('location_name', 'text'),
    // google_map: single-events.php reads ['street_number'], ['city'], ...
    field('location_address', 'google_map'),
    field('zoom_link', 'url'),
    field('summary_desc', 'wysiwyg'),
    field('agenda_link', 'link', { return_format: 'array' }),
    field('agenda_packet', 'file', { return_format: 'array', library: 'all' }),
    field('meeting_minutes', 'file', { return_format: 'array', library: 'all' }),
    field('meeting_video_link', 'url'),
    field('supplemental_downloads', 'repeater', {
      layout: 'table',
      sub_fields: [
        field('link_label', 'text'),
        field('file', 'file', { return_format: 'array' }),
        field('file_link', 'link', { return_format: 'array' }),
      ],
    }),
  ],
};

type Upsert = { key: string; id: number; created: boolean };
type Term = { id: number; slug: string };
type Media = { id: number; source_url: string };
type Post = { id: number; link: string; acf: Record<string, unknown>; meeting_event_type: number[] };

async function main() {
  const status = await wp.get<{ wordpress: string; acf: unknown; forms: unknown; theme: unknown }>(
    '/website-mover/v1/status',
  );
  log('status', { wordpress: status.wordpress, acf: status.acf, forms: status.forms, theme: status.theme });

  // 1. Content model through ACF (stored as ACF items, not code).
  log('taxonomy', await wp.post<Upsert>('/website-mover/v1/acf/taxonomies', taxonomy));
  log('post type', await wp.post<Upsert>('/website-mover/v1/acf/post-types', postType));
  log('field group', await wp.post<Upsert>('/website-mover/v1/acf/field-groups', fieldGroup));

  // ACF registers post types on init, so routes exist from the next request on.
  const types = await wp.get<Record<string, { rest_base: string }>>('/wp/v2/types');
  if (!types.events) throw new Error('events post type is not registered');

  // 2. A term, a document and a meeting with ACF values, all over core REST.
  const terms = await wp.get<Term[]>('/wp/v2/meeting_event_type', { slug: 'meetings' });
  const term = terms[0] ?? (await wp.post<Term>('/wp/v2/meeting_event_type', { name: 'Meetings', slug: 'meetings' }));

  const agenda = await uploadPdf('wm-spike-agenda.pdf');
  const minutes = await uploadPdf('wm-spike-minutes.pdf');

  const acf = {
    meeting_date_and_start_time: '2026-10-21 17:30:00',
    meeting_end_time: '19:00:00',
    was_this_meeting_cancelled: false,
    location_name: 'JHA Central Office',
    location_address: {
      address: '1300 Broad Street, Jacksonville, FL 32202',
      lat: 30.3393,
      lng: -81.6646,
      street_number: '1300',
      street_name: 'Broad Street',
      city: 'Jacksonville',
      state_short: 'FL',
      post_code: '32202',
    },
    zoom_link: 'https://example.com/zoom-spike',
    summary_desc: '<p>Regular monthly meeting of the Board of Commissioners.</p>',
    agenda_link: { title: 'Online agenda', url: 'https://example.com/agenda', target: '_blank' },
    agenda_packet: agenda.id,
    meeting_minutes: minutes.id,
    meeting_video_link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    supplemental_downloads: [{ link_label: 'Budget presentation', file: agenda.id, file_link: null }],
  };

  const existing = await wp.get<Post[]>('/wp/v2/events', { slug: 'wm-spike-board-meeting', status: 'any' });
  const body = {
    title: 'Board of Commissioners Regular Meeting (spike)',
    slug: 'wm-spike-board-meeting',
    status: 'publish',
    content: '<!-- wp:paragraph -->\n<p>Written by the M0 bridge spike.</p>\n<!-- /wp:paragraph -->',
    meeting_event_type: [term.id],
    meta: {},
    acf,
  };
  const post = existing[0]
    ? await wp.post<Post>(`/wp/v2/events/${existing[0].id}`, body)
    : await wp.post<Post>('/wp/v2/events', body);
  log('meeting', { id: post.id, link: post.link, created: !existing[0] });

  // 3. Read back and compare.
  const saved = await wp.get<Post>(`/wp/v2/events/${post.id}`, { context: 'edit' });
  const mismatches = Object.entries(acf).filter(([k, v]) => !sameValue(saved.acf[k], v));
  log('acf read back', saved.acf);
  if (mismatches.length) throw new Error(`ACF values differ: ${JSON.stringify(mismatches)}`);
  console.log('ACF round trip: OK');

  // 4. The framework's own template renders the values.
  const html = await (await fetch(post.link)).text();
  const rendered = {
    location: html.includes('JHA Central Office'),
    agendaLink: html.includes('https://example.com/agenda'),
    agendaPacket: html.includes(agenda.source_url),
    minutes: html.includes(minutes.source_url),
  };
  log('single-events.php renders', rendered);

  // 5. A form in Gravity Forms, placed on a page via its block.
  const form = await wp.post<{ id: number; created: boolean; block: { name: string; attrs: { formId: string } } }>(
    '/website-mover/v1/forms',
    {
      source_key: 'jaxha.org/contact-us#form-1',
      title: 'Contact Us (spike)',
      fields: [
        { label: 'Name', type: 'name', required: true },
        { label: 'Email', type: 'email', required: true },
        { label: 'Phone', type: 'phone' },
        { label: 'Topic', type: 'select', choices: ['Public Housing', 'Housing Choice Voucher', 'Other'] },
        { label: 'Preferred contact', type: 'checkbox', choices: ['Email', 'Phone'] },
        { label: 'Message', type: 'textarea', required: true },
      ],
    },
  );
  log('form', form);

  const pages = await wp.get<Post[]>('/wp/v2/pages', { slug: 'wm-spike-contact', status: 'any' });
  const pageBody = {
    title: 'Contact (spike)',
    slug: 'wm-spike-contact',
    status: 'publish',
    content: `<!-- wp:${form.block.name} ${JSON.stringify(form.block.attrs)} /-->`,
  };
  const page = pages[0]
    ? await wp.post<Post>(`/wp/v2/pages/${pages[0].id}`, pageBody)
    : await wp.post<Post>('/wp/v2/pages', pageBody);
  const pageHtml = await (await fetch(page.link)).text();
  log('form renders', {
    page: page.link,
    gformWrapper: pageHtml.includes(`gform_wrapper_${form.id}`),
    fields: (pageHtml.match(/class="gfield /g) ?? []).length,
  });
}

async function uploadPdf(filename: string): Promise<Media> {
  const found = await wp.get<Media[]>('/wp/v2/media', { search: filename.replace('.pdf', '') });
  if (found[0]) return found[0];
  const pdf = await readFile(new URL('./fixtures/sample.pdf', import.meta.url));
  return wp.upload<Media>(pdf, filename, 'application/pdf');
}

/** ACF returns files as IDs or arrays depending on context; compare on what we wrote. */
function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number' && actual && typeof actual === 'object' && 'ID' in actual) {
    return (actual as { ID: number }).ID === expected;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return expected.length === actual.length && expected.every((e, i) => sameValue(actual[i], e));
  }
  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    return Object.entries(expected).every(([k, v]) => sameValue((actual as Record<string, unknown>)[k], v));
  }
  if (expected === null) return actual === null || actual === '' || actual === false;
  // ACF's REST output turns numeric strings inside google_map values ("1300") into numbers.
  if (typeof expected === 'string' && typeof actual === 'number') return String(actual) === expected;
  return actual === expected;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
