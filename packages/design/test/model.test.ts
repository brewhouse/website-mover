import { describe, expect, it } from 'vitest';
import { blockRegistry, buildModel, phpClasses } from '../src/index.js';
import { framework, pages, schema } from './fixture.js';

describe('model', () => {
  const m = buildModel({ pages, framework, schema });
  const sections = (file: string) => m.pages.find((p) => p.file === file)!.sections;

  it('finds the shell, its menus and the shared content root', () => {
    expect(m.shell.contentRoot).toBe('div.page_main');
    expect(m.shell.landmarks.map((l) => l.signature).sort()).toEqual(['aside.page_sidebar', 'footer.main_footer', 'header.main_header']);
    const side = m.shell.menus.find((x) => x.location === 'aside')!;
    expect(side.items.map((i) => i.label)).toEqual(['Dashboard', 'Departments', 'News']);
    expect(side.items[1]!.children.map((i) => i.label)).toEqual(['Finance', 'Police']);
    expect(m.shell.menus.find((x) => x.location === 'footer')!.items.map((i) => i.label)).toEqual(['Privacy', 'Contact HR']);
  });

  it('splits a title block that wraps the page, and containers of sections', () => {
    expect(sections('dept.html').map((s) => s.component)).toEqual(['page_intro', 'overview_info', 'staff']);
    expect(sections('dept.html')[0]!.heading).toBe('Department Name');
    const overview = sections('dept.html')[1]!;
    expect(overview.leaves.map((l) => l.kind)).toEqual(['heading', 'richtext']);
  });

  it('reads lists and their fields', () => {
    const staff = sections('dept.html')[2]!;
    expect(staff.collections).toHaveLength(1);
    expect(staff.collections[0]).toMatchObject({ role: 'items', count: 3, item: 'article.staff_card' });
    expect(staff.collections[0]!.leaves.map((l) => l.kind)).toEqual(['initials', 'heading', 'text', 'email']);
    expect(staff.leaves.map((l) => l.kind)).toEqual(['heading']);

    const news = sections('news.html').find((s) => s.component === 'news_cards')!;
    expect(news.collections[0]!.count).toBe(3);
    expect(news.collections[0]!.leaves.map((l) => l.kind)).toEqual(['link', 'image', 'text', 'heading', 'date']);
    // The arrow in "View All" is an icon, and the title bar keeps the section whole.
    expect(news.leaves.filter((l) => l.kind !== 'icon').map((l) => l.kind)).toEqual(['heading', 'link']);
  });

  it('leaves out pagination, marks filter lists, and groups loose repeated siblings', () => {
    const comps = sections('news.html').map((s) => s.component);
    expect(comps).toContain('listing_pagination');
    expect(sections('news.html').find((s) => s.component === 'listing_pagination')!.collections).toEqual([]);
    // The filter bar (a drop-down beside the tags, as on Newport) holds the filter list.
    expect(sections('news.html').find((s) => s.component === 'listing_filter')!.collections[0]!.role).toBe('filters');
    expect(m.pages.find((p) => p.file === 'news.html')!.selects).toEqual([{ id: 'newsDept', name: 'department', label: 'Filter by Department', options: ['HR', 'IT'] }]);
    const results = sections('result.html').filter((s) => s.component !== 'page_intro');
    expect(results).toHaveLength(1);
    expect(results[0]!.collections[0]).toMatchObject({ count: 4, item: 'div.result_row' });
  });

  it('matches components to framework files and existing post types', () => {
    expect(m.components.find((c) => c.id === 'staff')!.framework).toMatchObject({ file: 'template-parts/blocks/staff.php', block: 'staff_block' });
    expect(m.components.find((c) => c.id === 'page_intro')!.framework?.file).toBe('page.php');
    expect(m.schema.pages).toEqual(expect.arrayContaining([{ file: 'dept.html', postType: 'departments', label: 'Departments', as: 'single' }, { file: 'news.html', postType: 'post', label: 'Posts', as: 'archive' }]));
    expect(m.schema.collections).toEqual(expect.arrayContaining([expect.objectContaining({ component: 'staff', postType: 'people' }), expect.objectContaining({ component: 'news_cards', postType: 'post' })]));
  });
});

describe('framework index', () => {
  it('reads classes from PHP templates and block registrations', () => {
    expect(phpClasses(`<div class="card <?php echo $x ? 'is-big' : ''; ?> row"><span class='title'>`)).toEqual(['card', 'title']);
    const reg = blockRegistry(`acf_register_block_type(array(\n 'name' => 'how_to',\n 'title' => 'How To',\n 'render_template' => 'template-parts/blocks/how_to.php',\n));`);
    expect([...reg]).toEqual([['template-parts/blocks/how_to.php', 'how_to']]);
  });
});
