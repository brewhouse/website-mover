/**
 * M0 spike: prove the bridge and the REST API can set up and fill the JHA seed's content model,
 * using the seed's real definitions (local copy with the seed database imported).
 *
 * 1. A new type through ACF (stored natively): `community`, for JHA's 29 community pages.
 * 2. The seed's own `people` type (board members): its "Person Details" field group is switched to
 *    "Show in REST", then a person is written with ACF values over core REST.
 * 3. A board meeting as an Events Calendar event in the seed's "Board Meetings" category.
 * 4. A Gravity Forms form, placed on a page with its block.
 *
 * Run: pnpm exec tsx --env-file=.env packages/wp-client/scripts/bridge-spike.ts
 */
import { readFile } from 'node:fs/promises';
import { localSeedClient } from '../src/index.ts';

const wp = localSeedClient();
const log = (label: string, value: unknown) => console.log(`${label}:`, JSON.stringify(value));

type Upsert = { key: string; id: number; created: boolean };
type Term = { id: number; slug: string; name: string };
type Media = { id: number; source_url: string };
type Post = { id: number; link: string; acf: Record<string, unknown> };
type Schema = {
  post_types: Record<string, { rest_base: string }>;
  acf: { field_groups: { key: string; title: string; location: { param: string; value: string }[][] }[] };
};

const field = (prefix: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
  key: `field_wm_${prefix}_${name}`,
  label: name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
  name,
  type,
  ...extra,
});

async function main() {
  const schema = await wp.get<Schema>('/website-mover/v1/schema');

  // 1. New type through ACF ------------------------------------------------------------------
  log('taxonomy', await wp.post<Upsert>('/website-mover/v1/acf/taxonomies', {
    key: 'taxonomy_wm_community_type',
    title: 'Community Types',
    taxonomy: 'community_type',
    object_type: ['community'],
    hierarchical: true,
    public: true,
    show_in_rest: true,
    labels: { name: 'Community Types', singular_name: 'Community Type' },
  }));
  log('post type', await wp.post<Upsert>('/website-mover/v1/acf/post-types', {
    key: 'post_type_wm_community',
    title: 'Communities',
    post_type: 'community',
    public: true,
    show_in_rest: true,
    has_archive: false,
    rewrite: { permalink_rewrite: 'custom_permalink', slug: 'communities', with_front: true },
    supports: ['title', 'editor', 'thumbnail', 'excerpt'],
    taxonomies: ['community_type'],
    labels: { name: 'Communities', singular_name: 'Community' },
    menu_icon: { type: 'dashicons', value: 'dashicons-admin-multisite' },
  }));
  const c = (name: string, type: string, extra?: Record<string, unknown>) => field('community', name, type, extra);
  log('field group', await wp.post<Upsert>('/website-mover/v1/acf/field-groups', {
    key: 'group_wm_community_details',
    title: 'Community details',
    show_in_rest: 1,
    location: [[{ param: 'post_type', operator: '==', value: 'community' }]],
    fields: [
      c('address', 'text'),
      c('city', 'text'),
      c('state', 'text'),
      c('zip', 'text'),
      c('county', 'text'),
      c('office_phone', 'text'),
      c('fax', 'text'),
      c('bedrooms', 'text'),
      c('activities', 'wysiwyg'),
      c('map', 'google_map'),
    ],
  }));

  const types = await wp.get<Record<string, unknown>>('/wp/v2/types');
  if (!types.community) throw new Error('community post type is not registered');
  const termRows = await wp.get<Term[]>('/wp/v2/community_type', { slug: 'rental' });
  const rental = termRows[0] ?? (await wp.post<Term>('/wp/v2/community_type', { name: 'Rental', slug: 'rental' }));
  const communityAcf = {
    address: '1300 Broad Street',
    city: 'Jacksonville',
    state: 'FL',
    zip: '32202',
    county: 'Duval',
    office_phone: '(904) 555-0100',
    fax: '(904) 555-0101',
    bedrooms: '1, 2, 3',
    activities: '<p>Monthly resident meeting.</p>',
  };
  const community = await upsert('community', 'wm-spike-community', {
    title: 'Sample Community (spike)',
    content: para('Written by the M0 bridge spike.'),
    community_type: [rental.id],
    acf: communityAcf,
  });
  await checkAcf('community', community.id, communityAcf);

  // 2. The seed's own `people` type ---------------------------------------------------------
  if (!schema.post_types.people) throw new Error('the seed has no people post type');
  const personGroup = schema.acf.field_groups.find((g) =>
    g.location.some((rules) => rules.some((r) => r.param === 'post_type' && r.value === 'people')),
  );
  if (!personGroup) throw new Error('no field group on people');
  log('show in rest', await wp.post(`/website-mover/v1/acf/field-groups/${personGroup.key}/show-in-rest`, {}));

  const photo = await uploadFixture('wm-spike-portrait.pdf', 'application/pdf');
  const personAcf = {
    title: 'Chair',
    phone: [{ phone_label: 'Office', phone_number: '(904) 555-0102' }],
    email: [{ email_label: 'Work', email: 'commissioner@example.test' }],
    biography: '<p>Sample biography.</p>',
  };
  const person = await upsert('people', 'wm-spike-commissioner', {
    title: 'Sample Commissioner (spike)',
    acf: personAcf,
  });
  await checkAcf('people', person.id, personAcf);

  // 3. A board meeting in The Events Calendar ------------------------------------------------
  type TecEvent = { id: number; url: string; categories: { name: string }[]; start_date: string; venue?: { venue: string } };
  const boardCat = (await wp.get<Term[]>('/wp/v2/tribe_events_cat', { search: 'Board Meetings' }))[0];
  if (!boardCat) throw new Error('the seed has no "Board Meetings" event category');
  const meetingBody = {
    title: 'Board of Commissioners Regular Meeting (spike)',
    slug: 'wm-spike-board-meeting',
    status: 'publish',
    start_date: '2026-10-21 17:30:00',
    end_date: '2026-10-21 19:00:00',
    categories: [boardCat.id],
    venue: { venue: 'JHA Central Office (spike)', address: '1300 Broad Street', city: 'Jacksonville', state: 'FL', zip: '32202' },
    // Meeting documents live in the content: tribe_events has no ACF fields in the seed.
    description: [
      para('Regular monthly meeting of the Board of Commissioners.'),
      para(`<a href="${photo.source_url}">Agenda (PDF)</a>`),
    ].join('\n\n'),
  };
  const [existingEvent] = await wp.get<{ id: number }[]>('/wp/v2/tribe_events', { slug: meetingBody.slug, status: 'any' });
  const event = existingEvent
    ? await wp.post<TecEvent>(`/tribe/events/v1/events/${existingEvent.id}`, meetingBody)
    : await wp.post<TecEvent>('/tribe/events/v1/events', meetingBody);
  log('meeting (TEC)', {
    id: event.id,
    url: event.url,
    created: !existingEvent,
    start: event.start_date,
    categories: event.categories.map((cat) => cat.name),
    venue: event.venue?.venue,
  });
  const eventHtml = await (await fetch(event.url)).text();
  log('TEC single renders', {
    title: eventHtml.includes('Board of Commissioners Regular Meeting (spike)'),
    agendaLink: eventHtml.includes(photo.source_url),
    frameworkHeader: eventHtml.includes('class="main_header"'),
  });

  // 4. Gravity Forms --------------------------------------------------------------------------
  const form = await wp.post<{ id: number; created: boolean; block: { name: string; attrs: { formId: string } } }>(
    '/website-mover/v1/forms',
    {
      source_key: 'jaxha.org/help-center#form-1',
      title: 'Help Center (spike)',
      fields: [
        { label: 'Name', type: 'name', required: true },
        { label: 'Email', type: 'email', required: true },
        { label: 'Phone', type: 'phone' },
        { label: 'Topic', type: 'select', choices: ['Public Record Request', 'Report Fraud', 'Other'] },
        { label: 'Preferred contact', type: 'checkbox', choices: ['Email', 'Phone'] },
        { label: 'Message', type: 'textarea', required: true },
      ],
    },
  );
  log('form', form);
  const page = await upsert('pages', 'wm-spike-help-center', {
    title: 'Help Center (spike)',
    content: `<!-- wp:${form.block.name} ${JSON.stringify(form.block.attrs)} /-->`,
  });
  const pageHtml = await (await fetch(page.link)).text();
  log('form renders', {
    page: page.link,
    gformWrapper: pageHtml.includes(`gform_wrapper_${form.id}`),
    fields: (pageHtml.match(/class="gfield /g) ?? []).length,
  });
}

function para(html: string): string {
  return `<!-- wp:paragraph -->\n<p>${html}</p>\n<!-- /wp:paragraph -->`;
}

/** Create or update a post (by slug) through core REST. */
async function upsert(restBase: string, slug: string, body: Record<string, unknown>): Promise<Post> {
  const [existing] = await wp.get<Post[]>(`/wp/v2/${restBase}`, { slug, status: 'any' });
  const full = { slug, status: 'publish', ...body };
  const post = existing
    ? await wp.post<Post>(`/wp/v2/${restBase}/${existing.id}`, full)
    : await wp.post<Post>(`/wp/v2/${restBase}`, full);
  log(restBase, { id: post.id, link: post.link, created: !existing });
  return post;
}

async function checkAcf(restBase: string, id: number, expected: Record<string, unknown>) {
  const saved = await wp.get<Post>(`/wp/v2/${restBase}/${id}`, { context: 'edit' });
  const mismatches = Object.entries(expected).filter(([k, v]) => !sameValue(saved.acf?.[k], v));
  if (mismatches.length) throw new Error(`${restBase} ACF values differ: ${JSON.stringify(mismatches)}`);
  console.log(`${restBase} ACF round trip: OK (${Object.keys(expected).length} fields)`);
}

async function uploadFixture(filename: string, contentType: string): Promise<Media> {
  const found = await wp.get<Media[]>('/wp/v2/media', { search: filename.replace(/\.\w+$/, '') });
  if (found[0]) return found[0];
  const data = await readFile(new URL('./fixtures/sample.pdf', import.meta.url));
  return wp.upload<Media>(data, filename, contentType);
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
