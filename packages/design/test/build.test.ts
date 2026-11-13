import { describe, expect, it } from 'vitest';
import { blockData, groupDefinition, parseWhen } from '../src/build.js';
import type { PlanFieldGroup } from '../src/plan-schema.js';

const field = (key: string, name: string, type: string, extra: object = {}) => ({ key, name, label: name, type, action: 'add', labelFrom: 'mockup-text', source: null, sample: null, subFields: [], ...extra }) as never;

describe('build: plan → ACF', () => {
  it('keeps every field of an existing group and adds the plan’s (the bridge replaces whole groups)', () => {
    const g: PlanFieldGroup = { key: 'group_x', title: 'Person Details', action: 'extend', location: { param: 'post_type', value: 'people' }, fields: [field('field_old', 'email', 'email', { action: 'reuse' }), field('field_new', 'contact', 'text')] };
    const current = { key: 'group_x', title: 'Person Details', ID: 7, location: [], fields: [{ key: 'field_old', name: 'email', type: 'email' }, { key: 'field_other', name: 'office', type: 'text' }] };
    const def = groupDefinition(g, current as never) as unknown as { fields: { key: string }[]; ID: number };
    expect(def.fields.map((f) => f.key)).toEqual(['field_old', 'field_other', 'field_new']);
    expect(def.ID).toBe(7);
  });

  it('drops what an earlier build added that the plan no longer has, never the group\u2019s own or an editor\u2019s fields', () => {
    const g: PlanFieldGroup = { key: 'group_h', title: 'Homepage Details', action: 'reuse', location: { param: 'page_template', value: 'template-home.php' }, fields: [field('field_wm_h_quick_links', 'quick_links', 'repeater', { action: 'reuse', subFields: [field('field_wm_h_quick_links_link', 'link', 'link', { action: 'reuse' })] })] };
    const original = { key: 'group_h', title: 'Homepage Details', fields: [{ key: 'field_seed', name: 'intro', type: 'text' }] };
    const current = {
      ...original,
      fields: [
        { key: 'field_seed', name: 'intro', type: 'text' },
        { key: 'field_editor', name: 'notes', type: 'text' },
        { key: 'field_wm_h_old', name: 'old', type: 'text' },
        { key: 'field_wm_h_quick_links', name: 'quick_links', type: 'repeater', sub_fields: [{ key: 'field_wm_h_quick_links_link', name: 'link', type: 'link' }, { key: 'field_wm_h_quick_links_quick_links', name: 'quick_links', type: 'repeater' }, { key: 'quick_links', name: 'bad', type: 'text' }] },
      ],
    };
    const def = groupDefinition(g, current as never, original as never) as unknown as { fields: { key: string; sub_fields?: { key: string }[] }[] };
    expect(def.fields.map((f) => f.key)).toEqual(['field_seed', 'field_editor', 'field_wm_h_quick_links']);
    expect(def.fields[2]!.sub_fields!.map((f) => f.key)).toEqual(['field_wm_h_quick_links_link']);
    // Without the snapshot nothing is dropped.
    expect((groupDefinition(g, current as never) as unknown as { fields: unknown[] }).fields).toHaveLength(4);
  });

  it('makes new groups with their location, and post-object fields that point at their post type', () => {
    const g: PlanFieldGroup = { key: 'group_wm_department_post', title: 'Department', action: 'create', location: { param: 'post_type', value: 'post' }, fields: [field('field_d', 'department', 'post_object', { relatesTo: 'departments' })] };
    const def = groupDefinition(g, undefined) as unknown as { location: unknown; fields: Record<string, unknown>[] };
    expect(def.location).toEqual([[{ param: 'post_type', operator: '==', value: 'post' }]]);
    expect(def.fields[0]).toMatchObject({ type: 'post_object', post_type: ['departments'], return_format: 'id' });
  });

  it('stores block data as ACF does, repeaters flattened', () => {
    const fields = new Map([
      ['field_h', { name: 'heading', type: 'text' as const, subs: new Map() }],
      ['field_r', { name: 'items', type: 'repeater' as const, subs: new Map([['field_r_t', 'title']]) }],
    ]);
    expect(blockData({ field_h: 'Hi', field_r: [{ field_r_t: 'A' }, { field_r_t: 'B' }] }, (k) => fields.get(k))).toEqual({
      heading: 'Hi',
      _heading: 'field_h',
      items: 2,
      _items: 'field_r',
      items_0_title: 'A',
      _items_0_title: 'field_r_t',
      items_1_title: 'B',
      _items_1_title: 'field_r_t',
    });
  });

  it('reads the mockups’ dates and event times', () => {
    expect(parseWhen('June 22, 2026')).toEqual({ start: '2026-06-22T09:00:00', end: null });
    expect(parseWhen('July 2, 2026 @ 6:00 pm – 9:00 pm')).toEqual({ start: '2026-07-02T18:00:00', end: '2026-07-02T21:00:00' });
    expect(parseWhen('Date/Timestamp')).toBeNull();
  });
});

describe('menu targets', () => {
  it('links an item to the entry its label names, else the page or archive', async () => {
    const { menuTarget } = await import('../src/build.js');
    const item = (target: string | null, href = '#') => ({ label: 'x', href, target, children: [] });
    const titled = (pt: string, title: string) => (pt === 'departments' && title === 'Finance' ? { id: 7, postType: pt } : null);
    const byPage = (page: string) => (page === 'news.html' ? { id: 3, postType: 'page' } : null);
    expect(menuTarget(item('title:departments:Finance'), byPage, titled, 'https://x.test')).toEqual({ type: 'post_type', object: 'departments', object_id: 7 });
    expect(menuTarget(item('page:news.html'), byPage, titled, 'https://x.test')).toEqual({ type: 'post_type', object: 'page', object_id: 3 });
    expect(menuTarget(item('archive:tribe_events'), byPage, titled, 'https://x.test')).toEqual({ type: 'post_type_archive', object: 'tribe_events' });
    expect(menuTarget(item('title:departments:Gone'), byPage, titled, 'https://x.test')).toEqual({ type: 'custom', url: '#' });
  });
});

describe('sample events and front page fields', () => {
  it('moves a past sample event on by 52-week steps, keeping its weekday and time', async () => {
    const { upcoming } = await import('../src/build.js');
    const when = { start: '2026-07-02T18:00:00', end: '2026-07-02T21:00:00' };
    const next = upcoming(when, new Date('2026-11-13T00:00:00Z'));
    expect(next).toEqual({ start: '2027-07-01T18:00:00', end: '2027-07-01T21:00:00' });
    expect(new Date(`${next.start}Z`).getUTCDay()).toBe(new Date(`${when.start}Z`).getUTCDay());
    expect(upcoming(when, new Date('2026-01-01T00:00:00Z'))).toBe(when);
  });

  it('counts a field as empty when it has no text, no rows and no link', async () => {
    const { hasValue } = await import('../src/build.js');
    for (const v of [null, '', ' ', false, [], { title: '', url: '#' }, [{ a: '' }], '<p></p>']) expect(hasValue(v), JSON.stringify(v)).toBe(false);
    for (const v of ['Quick Links', 12, { title: 'View all', url: '#' }, [{ a: 'x' }], '<img src="a.png">']) expect(hasValue(v), JSON.stringify(v)).toBe(true);
  });
});
