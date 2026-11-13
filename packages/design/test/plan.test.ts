import { describe, expect, it } from 'vitest';
import { applyDecisions, buildDesignPlan, buildModel, DesignDecisions, draftProposal, labelSource, parsePage, partKey, vocabulary, type Proposal, type TargetSchema } from '../src/index.js';
import { framework, pages, schema as baseSchema } from './fixture.js';

// The target already has a Person Details group with an email field.
const schema: TargetSchema = {
  ...baseSchema,
  taxonomies: { category: { label: 'Categories', object_type: ['post'], rest_base: 'categories', hierarchical: true } },
  acf: {
    post_types: [],
    taxonomies: [],
    field_groups: [{ key: 'group_people', title: 'Person Details', location: [[{ param: 'post_type', operator: '==', value: 'people' }]], fields: [{ key: 'field_people_email', name: 'email', label: 'Email', type: 'email' }] }],
  },
};
const model = buildModel({ pages, framework, schema });
const vocab = vocabulary({ pageTexts: pages.flatMap((p) => parsePage(p.html, p.file).texts), figmaTexts: [], layerNames: ['Department Detail'], classNames: pages.flatMap((p) => parsePage(p.html, p.file).classes) });
const draft = draftProposal(model, schema, { '1:1': 'Department Detail' });
const inputs = { modelSha256: 'm', inventorySha256: 'i', schemaReadAt: '2026-11-10T00:00:00Z', targetUrl: 'https://example.test', theme: 'planeteriaweb' };
const plan = (proposal: Proposal = draft) => buildDesignPlan({ jobId: 'test', version: 1, model, schema, proposal, draft, vocabulary: vocab, themeFiles: ['page.php', 'single-departments.php', 'search.php'], inputs, ai: null, now: new Date('2026-11-10T00:00:00Z') });

describe('draft proposal', () => {
  it('sets page kinds from names and the target', () => {
    expect(draft.pages.map((p) => [p.page, p.kind, p.postType])).toEqual([
      ['dept.html', 'single', 'departments'],
      ['news.html', 'archive', 'post'],
      ['result.html', 'search', null],
    ]);
  });

  it('binds lists to post types and filters to taxonomies, and maps entry values to WordPress fields', () => {
    const staff = draft.parts.find((p) => p.component === 'staff' && p.collection !== null)!;
    expect(staff).toMatchObject({ binding: 'query', postType: 'people' });
    expect(staff.fields.map((f) => f.core ?? f.name)).toEqual(['derived', 'title', 'name', 'email']);
    const filter = draft.parts.find((p) => p.binding === 'filter')!;
    expect(filter).toMatchObject({ postType: 'post', taxonomy: 'category' });
    const cards = draft.parts.find((p) => p.component === 'news_cards' && p.collection !== null)!;
    expect(cards.fields.map((f) => f.core)).toEqual(['permalink', 'featured_image', 'term', 'title', 'date']);
    // Search pages are the template's own.
    expect(draft.parts.filter((p) => p.page === 'result.html').every((p) => p.binding === 'theme' || p.binding === 'core')).toBe(true);
  });
});

describe('design plan', () => {
  const p = plan();

  it('chooses template files and whether they restyle the framework', () => {
    expect(p.templates.map((t) => [t.page, t.kind, t.file, t.action])).toEqual([
      ['dept.html', 'single', 'single-departments.php', 'update'],
      ['news.html', 'page-template', 'template-news.php', 'create'],
      ['result.html', 'search', 'search.php', 'update'],
    ]);
  });

  it('reuses existing fields and adds new ones with mockup labels', () => {
    const people = p.fieldGroups.find((g) => g.key === 'group_people')!;
    expect(people.action).toBe('extend');
    expect(people.fields.map((f) => [f.name, f.action])).toEqual([
      ['name', 'add'],
      ['email', 'reuse'],
    ]);
    expect(people.fields.find((f) => f.name === 'email')!.key).toBe('field_people_email');
    expect(p.warnings.filter((w) => !/links to nothing in the mockups|goes to the sample/.test(w))).toEqual([]);
  });

  it('reuses taxonomies with the mockup filter terms', () => {
    expect(p.taxonomies).toEqual([expect.objectContaining({ name: 'category', action: 'reuse', terms: ['HR', 'IT'] })]);
  });

  it('fills sample entries with the mockup text, once each', () => {
    const posts = p.entries.filter((e) => e.postType === 'post');
    expect(posts.map((e) => e.title)).toEqual(['Card Title 1', 'Card Title 2', 'Card Title 3']);
    expect(posts[0]!.core).toMatchObject({ featured_image: 'img/p1.jpg', date: 'June 22, 2026', terms: ['Category'] });
    // Nine identical staff cards are one sample person.
    expect(p.entries.filter((e) => e.postType === 'people')).toHaveLength(1);
    const dept = p.entries.find((e) => e.postType === 'departments')!;
    expect(dept).toMatchObject({ title: 'Department Name', slug: 'department-name' });
    expect(p.media.map((m) => m.src)).toEqual(['img/p1.jpg', 'img/p2.jpg', 'img/p3.jpg']);
  });

  it('turns the shell menus into WordPress menus pointing at the built pages', () => {
    const main = p.menus.find((m) => m.name === 'Main Menu')!;
    expect(main.items.map((i) => [i.label, i.target])).toEqual([
      ['Dashboard', null],
      ['Departments', 'archive:departments'],
      ['News', 'page:news.html'],
    ]);
    // "#" links: named like nothing the mockups have, so they're left for review.
    expect(p.warnings).toContain('Footer Menu: "Privacy" links to nothing in the mockups (#); set its link on review or in WordPress');
    expect(main.items[1]!.children[0]).toMatchObject({ label: 'Finance', target: 'entry:dept.html' });
  });
});

describe('checking a proposal', () => {
  it('keeps what holds up and falls back to the draft for the rest', () => {
    const staffKey = partKey(draft.parts.find((x) => x.component === 'staff' && x.collection !== null)!);
    const ai: Proposal = structuredClone(draft);
    const staff = ai.parts.find((x) => partKey(x) === staffKey)!;
    staff.postType = 'employees'; // not on the target, not declared
    const cards = ai.parts.find((x) => x.component === 'news_cards' && x.collection !== null)!;
    cards.fields.push({ path: 'a > span.category', name: 'Section Label!', label: 'Invented Wording', type: 'text', core: null });
    const result = plan(ai);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/staff.*kept as the rules had it \(unknown post type employees\)/), expect.stringMatching(/label "Invented Wording".*isn't in the mockups/)]));
    expect(result.templates[0]!.parts.find((x) => x.component === 'staff' && x.collection !== null)!.postType).toBe('people');
    const added = result.fieldGroups.flatMap((g) => g.fields).find((f) => f.name === 'section_label');
    expect(added?.label).toBe('Section label');
  });

  it('checks labels against the mockup vocabulary', () => {
    expect(labelSource('Card Title 1', vocab)).toBe('mockup-text');
    expect(labelSource('Department Detail', vocab)).toBe('figma');
    expect(labelSource('Staff card', vocab)).toBe('class-name');
    expect(labelSource('Job Title', vocab)).toBeNull();
  });

  it('applies reviewer decisions on top', () => {
    const decided = applyDecisions(draft, DesignDecisions.parse({ pages: { 'news.html': { title: 'Department News' } } }));
    expect(decided.pages.find((x) => x.page === 'news.html')!.title).toBe('Department News');
    expect(plan(decided).entries.find((e) => e.source.page === 'news.html' && e.postType === 'page')!.title).toBe('Department News');
  });
});
