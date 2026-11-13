import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDesignPlan, buildModel, draftProposal, generateTheme, parsePage, readZip, vocabulary, writeZip, type TargetSchema } from '../src/index.js';
import { derivedValue } from '../src/theme/markup.js';
import { helperLibrary } from '../src/theme/php-lib.js';
import { framework, pages, schema as baseSchema } from './fixture.js';

const schema: TargetSchema = {
  ...baseSchema,
  taxonomies: { category: { label: 'Categories', object_type: ['post'], rest_base: 'categories', hierarchical: true } },
  acf: { post_types: [], taxonomies: [], field_groups: [{ key: 'group_people', title: 'Person Details', location: [[{ param: 'post_type', operator: '==', value: 'people' }]], fields: [{ key: 'field_people_email', name: 'email', label: 'Email', type: 'email' }] }] },
};
const model = buildModel({ pages, framework, schema });
const vocab = vocabulary({ pageTexts: pages.flatMap((p) => parsePage(p.html, p.file).texts), figmaTexts: [], layerNames: ['Department Detail'], classNames: pages.flatMap((p) => parsePage(p.html, p.file).classes) });
const draft = draftProposal(model, schema, { '1:1': 'Department Detail' });
const plan = buildDesignPlan({ jobId: 'test', version: 3, model, schema, proposal: draft, draft, vocabulary: vocab, themeFiles: ['page.php', 'single-departments.php', 'search.php'], inputs: { modelSha256: 'm', inventorySha256: 'i', schemaReadAt: '2026-11-10T00:00:00Z', targetUrl: 'https://example.test', theme: 'planeteriaweb' }, ai: null, now: new Date('2026-11-10T00:00:00Z') });

const theme: Record<string, string> = {
  'functions.php': "<?php\nadd_action('wp_enqueue_scripts', 'enqueue_planeteriaweb');\nfunction enqueue_planeteriaweb() {\n  wp_enqueue_style('bootstrap-css', get_stylesheet_directory_uri() . '/css/bootstrap.min.css');\n  wp_enqueue_style('owl-css', get_stylesheet_directory_uri() . '/css/owl.carousel.min.css');\n}\nfunction add_script_to_footer() {\n  wp_enqueue_script('bootstrap-js', get_stylesheet_directory_uri() . '/js/bootstrap.js');\n}\n",
  'header.php': "<?php\n/**\n * Displays all of the <head> section.\n */\n?><!doctype html>\n<html <?php language_attributes(); ?>>\n<head>\n\t<meta charset=\"<?php bloginfo( 'charset' ); ?>\" />\n\t<link href=\"https://fonts.googleapis.com/css2?family=Open+Sans\" rel=\"stylesheet\">\n\t<?php wp_head(); ?>\n</head>\n<body>\n",
  'footer.php': "<footer>old</footer>\n<?php wp_footer(); ?>\n<script src=\"https://example.test/widget.js\"></script>\n</body>\n</html>\n",
  'single-departments.php': "<?php\n/* old */\n",
  'page.php': "<?php\n/* old */\n",
};
const withHead = (html: string) => html.replace('<html>', '<html><head><link href="css/site.css" rel="stylesheet"></head>').replace('</body>', '<script src="js/jquery.js"></script><script src="js/site.js"></script></body>');
const sources: Record<string, string> = { 'css/site.css': '.a{background:url(../img/bg.png)} .b{background:url(../img/gone.png)}', 'img/bg.png': 'png', 'img/arrow.svg': '<svg/>', 'js/site.js': '//', 'img/p1.jpg': 'jpg' };
const changes = generateTheme({
  plan,
  model,
  pages: new Map(pages.map((p) => [p.file, withHead(p.html)])),
  slug: 'test',
  readSource: (rel) => (rel in sources ? Buffer.from(sources[rel]!) : null),
  readTheme: (rel) => theme[rel] ?? null,
});
const file = (p: string) => changes.files.find((f) => f.path === p)?.data.toString() ?? '';

describe('theme generator', () => {
  it('writes a template per mockup page, the shell, the helpers and one line in functions.php', () => {
    const paths = changes.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['single-departments.php', 'search.php', 'header.php', 'sidebar.php', 'footer.php', 'inc/test.php', 'functions.php']));
    expect(changes.files.find((f) => f.path === 'single-departments.php')!.action).toBe('replace');
    expect(changes.files.find((f) => f.path === 'sidebar.php')!.action).toBe('create');
    expect(file('functions.php')).toMatch(/^<\?php\nrequire_once get_stylesheet_directory\(\) \. '\/inc\/test\.php';/);
  });

  it('keeps the theme’s <head> (without its fonts) and everything from wp_footer() on', () => {
    const header = file('header.php');
    expect(header).toContain('<?php wp_head(); ?>');
    expect(header).not.toContain('fonts.googleapis.com/css2?family=Open+Sans');
    expect(header).not.toContain('section.\n');
    expect(header).toContain('<?php get_sidebar(); ?>');
    expect(header).toContain('<header class="main_header">');
    const footer = file('footer.php');
    expect(footer).toContain('<footer class="main_footer">');
    expect(footer).not.toContain('<footer>old</footer>');
    expect(footer).toContain('<?php wp_footer(); ?>\n<script src="https://example.test/widget.js">');
  });

  it('turns the shell menus into WordPress menus', () => {
    expect(file('sidebar.php')).toMatch(/wmd_menu\( 'Main Menu', array\( .*'depth' => 2/);
    expect(file('footer.php')).toMatch(/wmd_menu\( '[^']+', array\(/);
  });

  it('binds an entry’s values and lists its related entries', () => {
    const t = file('single-departments.php');
    expect(t).toContain('while ( have_posts() ) :');
    expect(t).toContain('<h1><?php echo esc_html( get_the_title() ); ?></h1>');
    expect(t).toMatch(/\$wmd_q\d = wmd_query\( 'people', 3 \)/);
    expect(t).toContain('wmd_initials( get_the_title() )');
    expect(t).toContain("esc_url( 'mailto:' . antispambot(");
    // A list section shows only when the list has entries; an ACF value only when it has one.
    expect(t).toMatch(/\$wmd_q\d = wmd_query\( 'people', 3 \); if \( \$wmd_q\d->have_posts\(\) \) : \?>/);
    expect(t).toMatch(/<\?php if \( '' !== trim\( wmd_text\( get_field\( 'email' \) \) \) \) : \?><a href="<\?php echo esc_url\( 'mailto:'/);
    // One item is the loop's template; the mockup's copies are gone.
    expect(t.match(/class="staff_card"/g)).toHaveLength(1);
  });

  it('loops the search results over the main query and binds breadcrumb and search forms', () => {
    const t = file('search.php');
    expect(t).toContain('<?php if ( have_posts() ) : while ( have_posts() ) : the_post(); ?>');
    expect(t.match(/class="result_row"/g)).toHaveLength(1);
    expect(t).toContain("wmd_breadcrumb( 'breadcrumb', 'breadcrumb-item' )");
    expect(t).not.toContain('while ( have_posts() ) :\n');
  });

  it('enqueues the mockup assets in place of Bootstrap 4 and copies what the CSS uses', () => {
    const lib = file('inc/test.php');
    expect(lib).toContain("wp_enqueue_style( 'wmd-site', wmd_asset( 'css/site.css' )");
    expect(lib).toContain("wp_enqueue_script( 'wmd-site', wmd_asset( 'js/site.js' )");
    expect(lib).not.toContain('jquery.js');
    expect(lib).toMatch(/array\( 'bootstrap-css' \) as \$handle/);
    expect(lib).toMatch(/array\( 'bootstrap-js' \) as \$handle/);
    expect(changes.files.map((f) => f.path)).toEqual(expect.arrayContaining(['assets/test/css/site.css', 'assets/test/img/bg.png', 'assets/test/js/site.js']));
    expect(changes.missingAssets).toContain('img/gone.png');
  });

  it('writes PHP that parses', () => {
    if (spawnSync('php', ['-v']).status !== 0) return; // PHP isn't installed here
    const dir = mkdtempSync(path.join(tmpdir(), 'wm-theme-'));
    for (const f of changes.files.filter((x) => x.path.endsWith('.php'))) {
      const out = path.join(dir, f.path.replace(/\//g, '__'));
      writeFileSync(out, f.data);
      const r = spawnSync('php', ['-l', out], { encoding: 'utf8' });
      expect(r.status, `${f.path}: ${r.stdout}${r.stderr}`).toBe(0);
    }
  });
});

describe('zip writer', () => {
  it('writes archives the reader reads back', () => {
    const big = Buffer.from('x'.repeat(5000));
    const zip = writeZip([
      { name: 'a/b.txt', data: Buffer.from('hello') },
      { name: 'big.txt', data: big },
      { name: 'ünï.txt', data: Buffer.alloc(0) },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['a/b.txt', 'big.txt', 'ünï.txt']);
    expect(entries[0]!.read().toString()).toBe('hello');
    expect(entries[1]!.read().equals(big)).toBe(true);
    expect(entries[2]!.read().length).toBe(0);
  });
});

describe('derived values', () => {
  it('recognises date parts, event times, image counts and initials from the mockup sample', () => {
    expect(derivedValue('JUL')).toBe("strtoupper( wmd_date( 'M' ) )");
    expect(derivedValue('Jul')).toBe("wmd_date( 'M' )");
    expect(derivedValue('September')).toBe("wmd_date( 'F' )");
    expect(derivedValue('6')).toBe("wmd_date( 'j' )");
    expect(derivedValue('Tue')).toBe("wmd_date( 'D' )");
    expect(derivedValue('2:00 PM - 3:00 PM')).toBe('wmd_time_range()');
    expect(derivedValue('24 Images')).toContain('wmd_image_count()');
    expect(derivedValue('JD')).toBe('wmd_initials( get_the_title() )');
    expect(derivedValue('Category')).toBeNull();
  });
});

describe('linked entries (Filter by Department)', () => {
  it('puts a department field on the listed post type and turns the drop-down into the departments', () => {
    expect(plan.relations).toEqual([expect.objectContaining({ name: 'department', relatesTo: 'departments', param: 'department', on: [expect.objectContaining({ postType: 'post' })] })]);
    const g = plan.fieldGroups.find((x) => x.key === 'group_wm_department_post')!;
    expect(g.fields[0]).toMatchObject({ name: 'department', type: 'post_object', relatesTo: 'departments' });
    const t = changes.files.find((f) => f.path.startsWith('template-') && f.data.toString().includes('newsDept'))!.data.toString();
    expect(t).toContain("foreach ( wmd_related_choices( 'department' ) as $wmd_choice )");
    expect(t).not.toContain('<option value="hr">');
    expect(file('inc/test.php')).toMatch(/'department' => array\(\s*'param'\s*=> 'department',\s*'post_type' => 'departments',\s*'on'\s*=> array\( 'post' \)/);
  });
});

describe('AI proposal check', () => {
  it('keeps a value the rules mapped to a WordPress field when the AI makes it an ACF field', async () => {
    const { checkProposal } = await import('../src/plan.js');
    const part = draft.parts.find((p) => p.fields.some((f) => f.core === 'title' || f.core === 'date'))!;
    const core = part.fields.find((f) => f.core === 'title' || f.core === 'date')!;
    const proposal = structuredClone(draft);
    const p = proposal.parts.find((x) => x.page === part.page && x.path === part.path && x.collection === part.collection)!;
    p.fields = p.fields.map((f) => (f.path === core.path ? { ...f, core: null, name: 'custom_value' } : f));
    const warnings: string[] = [];
    const checked = checkProposal({ model, schema, proposal, draft, vocabulary: vocab }, warnings).proposal;
    const kept = checked.parts.find((x) => x.page === part.page && x.path === part.path && x.collection === part.collection)!;
    expect(kept.fields.find((f) => f.path === core.path)).toMatchObject({ core: core.core });
    expect(warnings.some((w) => w.includes(`kept ${core.path} as WordPress's ${core.core}`))).toBe(true);
  });
});

describe('after theme change set v7 on Newport dev', () => {
  it('takes a block name the AI gives with its namespace without it', async () => {
    const { checkProposal } = await import('../src/plan.js');
    const proposal = structuredClone(draft);
    const p = proposal.parts[0]!;
    p.block = 'acf/acf/buttons_list';
    checkProposal({ model, schema, proposal, draft, vocabulary: vocab }, []);
    expect(p.block).toBe('buttons-list');
  });
  it('prints the content once when the AI binds it as fields and leaves a section to blocks', () => {
    const p2 = structuredClone(plan);
    const t = p2.templates.find((x) => x.parts.some((pt) => pt.values.some((v) => v.field === 'core:content')))!;
    const content = t.parts.find((pt) => pt.values.some((v) => v.field === 'core:content'))!;
    content.binding = 'fields';
    const other = t.parts.find((pt) => pt !== content && pt.collection === null && !pt.path.startsWith(content.path) && !content.path.startsWith(pt.path))!;
    other.binding = 'block';
    other.block = 'buttons-list';
    const c = generateTheme({ plan: p2, model, pages: new Map(pages.map((x) => [x.file, x.html])), slug: 'test', readSource: () => null, readTheme: (rel) => theme[rel] ?? null });
    const out = c.files.find((f) => f.path === t.file)!.data.toString();
    expect(out.match(/<\?php the_content\(\); \?>/g)).toHaveLength(1);
  });
  it('never takes a repeater as a value (the list item, or a heading over a list) from the AI', async () => {
    const { checkProposal } = await import('../src/plan.js');
    const list = draft.parts.find((p) => p.collection !== null && p.fields.length)!;
    const proposal = structuredClone(draft);
    const p = proposal.parts.find((x) => x.page === list.page && x.path === list.path && x.collection === list.collection)!;
    p.fields.unshift({ ...p.fields[0]!, path: '', name: 'items', label: 'Items', type: 'repeater', core: null });
    const warnings: string[] = [];
    const checked = checkProposal({ model, schema, proposal, draft, vocabulary: vocab }, warnings).proposal;
    const kept = checked.parts.find((x) => x.page === list.page && x.path === list.path && x.collection === list.collection)!;
    expect(kept.fields.some((f) => f.type === 'repeater')).toBe(false);
    expect(kept.fields.length).toBe(list.fields.length);
    expect(warnings.some((w) => w.includes("isn't a repeater"))).toBe(true);
  });
  it('gives keys to sub-fields a list adds to a field another part made first', () => {
    const run = (proposal: typeof draft) => buildDesignPlan({ jobId: 'test', version: 4, model, schema, proposal, draft, vocabulary: vocab, themeFiles: ['page.php', 'single-departments.php', 'search.php'], inputs: { modelSha256: 'm', inventorySha256: 'i', schemaReadAt: '2026-11-10T00:00:00Z', targetUrl: 'https://example.test', theme: 'planeteriaweb' }, ai: null, now: new Date('2026-11-10T00:00:00Z') });
    // The staff list as a repeater, and the section's heading as a field of the same name (made first).
    const proposal = structuredClone(draft);
    const lp = proposal.parts.find((x) => x.page === 'dept.html' && x.component === 'staff' && x.collection !== null)!;
    lp.binding = 'repeater';
    lp.postType = null;
    lp.fields = lp.fields.map((f) => ({ ...f, core: null }));
    const before = run(proposal);
    const repeater = before.fieldGroups.flatMap((g) => g.fields).find((f) => f.type === 'repeater' && f.source?.component === 'staff')!;
    const hp = proposal.parts.find((x) => x.page === 'dept.html' && x.component === 'staff' && x.collection === null)!;
    hp.binding = 'fields';
    hp.fields = [{ path: '', name: repeater.name, label: 'Staff', type: 'text', core: null }];
    const after = run(proposal);
    const subs = after.fieldGroups.flatMap((g) => g.fields).filter((f) => f.name === repeater.name).flatMap((f) => f.subFields);
    expect(subs.length).toBeGreaterThan(0);
    for (const sf of subs) expect(sf.key).not.toBe('');
  });
  it('doesn\u2019t reuse a repeater on the target for a single value (one an earlier build left)', () => {
    const left: TargetSchema = { ...schema, acf: { post_types: [], taxonomies: [], field_groups: [{ ...schema.acf!.field_groups[0]!, fields: [{ key: 'field_people_email', name: 'email', label: 'Email', type: 'repeater' }] }] } };
    const m2 = buildModel({ pages, framework, schema: left });
    const d2 = draftProposal(m2, left, { '1:1': 'Department Detail' });
    const p2 = buildDesignPlan({ jobId: 'test', version: 5, model: m2, schema: left, proposal: d2, draft: d2, vocabulary: vocab, themeFiles: ['page.php', 'single-departments.php', 'search.php'], inputs: { modelSha256: 'm', inventorySha256: 'i', schemaReadAt: '2026-11-10T00:00:00Z', targetUrl: 'https://example.test', theme: 'planeteriaweb' }, ai: null, now: new Date('2026-11-10T00:00:00Z') });
    const email = p2.fieldGroups.flatMap((g) => g.fields).find((f) => f.source?.path?.includes('a') && f.type === 'email');
    expect(email).toBeTruthy();
    expect(p2.fieldGroups.flatMap((g) => g.fields).some((f) => f.key === 'field_people_email')).toBe(false);
  });
  it('keeps a linked image when the link is empty: only the tags go', async () => {
    const { Php } = await import('../src/theme/markup.js');
    const php = new Php();
    const html = `<li><a href="${php.echo('esc_url( x )')}" wmdwrap="${php.token("wmd_has( get_sub_field( 'link' ) )")}"><img src="a.jpg"></a></li>`;
    expect(php.render(html)).toBe(`<li><?php if ( wmd_has( get_sub_field( 'link' ) ) ) : ?><a href="<?php echo esc_url( x ); ?>"><?php endif; ?><img src="a.jpg"><?php if ( wmd_has( get_sub_field( 'link' ) ) ) : ?></a><?php endif; ?></li>`);
  });
});

describe('the helper library’s name', () => {
  const run = (functionsPhp: string) =>
    generateTheme({ plan, model, pages: new Map(pages.map((p) => [p.file, p.html])), slug: 'newport', readSource: () => null, readTheme: (rel) => (rel === 'functions.php' ? functionsPhp : (theme[rel] ?? null)) });
  it('is named after the job and replaces a line loading an earlier name', () => {
    const c = run("<?php\nrequire_once get_stylesheet_directory() . '/inc/wm-design.php'; // Website Mover design build\nfunction a() {}\n");
    expect(c.files.map((f) => f.path)).toContain('inc/newport.php');
    const fn = c.files.find((f) => f.path === 'functions.php')!.data.toString();
    expect(fn.match(/require_once/g)).toHaveLength(1);
    expect(fn).toContain("'/inc/newport.php'; // Website Mover design build");
    expect(c.removals.map((r) => r.path)).toEqual(['inc/wm-design.php']);
  });
  it('leaves functions.php alone when it already loads it (the team’s own line)', () => {
    const c = run("<?php\nrequire_once get_stylesheet_directory() . '/inc/newport.php';\nfunction a() {}\n");
    expect(c.files.some((f) => f.path === 'functions.php')).toBe(false);
  });
});

describe('retiring an earlier hand-made design library (B0)', () => {
  const b0 = {
    'functions.php': "<?php\nrequire_once get_stylesheet_directory() . '/inc/newport.php'; // Newport design (B0): sidebar, breadcrumb\nfunction enqueue_planeteriaweb() {\n  wp_enqueue_style('newport-css', $uri . '/css/newport/newport.css');\n}\nfunction add_script_to_footer() {\n  wp_enqueue_script('newport-js', $uri . '/js/newport/newport.js');\n}\n",
    'inc/newport.php': "<?php\n/**\n * Newport design (B0): helpers.\n * Generated by Website Mover from the mockups.\n */\nrequire_once __DIR__ . '/newport-home.php';\nfunction nb_breadcrumb() {}\n",
    'inc/newport-home.php': "<?php\nfunction nb_render_alerts() {}\n",
  };
  const run = (extra: Record<string, string>) => {
    const files: Record<string, string> = { ...theme, ...b0, ...extra };
    return generateTheme({ plan, model, pages: new Map(pages.map((p) => [p.file, p.html])), slug: 'newport', readSource: () => null, readTheme: (rel) => files[rel] ?? null, listTheme: () => Object.keys(files) });
  };
  it('deletes it and what it loads when nothing left uses it, and takes its name', () => {
    const c = run({});
    expect(c.removals.map((r) => r.path).sort()).toEqual(['inc/newport-home.php', 'inc/wm-design.php']);
    expect(c.files.find((f) => f.path === 'inc/newport.php')!.data.toString()).toContain('Website Mover design build');
    const fn = c.files.find((f) => f.path === 'functions.php')!.data.toString();
    expect(fn.match(/require_once/g)).toHaveLength(1);
    expect(fn).not.toContain('Newport design (B0)');
    const lib = c.files.find((f) => f.path === 'inc/newport.php')!.data.toString();
    expect(lib).toContain("'newport-css'");
    expect(lib).toContain("'newport-js'");
  });
  it('keeps it when a theme file the change set leaves alone still calls it', () => {
    const c = run({ 'template-old.php': '<?php nb_render_alerts(); ?>' });
    expect(c.removals).toEqual([]);
    expect(c.files.find((f) => f.path === 'inc/wm-design.php')).toBeTruthy();
    expect(c.files.find((f) => f.path === 'functions.php')!.data.toString()).toContain('Newport design (B0)');
    expect(c.warnings.some((w) => w.includes('template-old.php (nb_render_alerts())'))).toBe(true);
  });
});

describe('The Events Calendar on a block theme', () => {
  const lib = (events: boolean) => helperLibrary({ assetDir: 'assets/t', styles: [], scripts: [], dequeueStyles: [], dequeueScripts: [], blocks: [], origin: 'test', events });
  it('sends TEC pages to tribe-events/default-template.php only when the change set has one', () => {
    expect(lib(true)).toContain("locate_template( 'tribe-events/default-template.php' )");
    expect(lib(true)).toContain("tribe( '\\\\Tribe\\\\Events\\\\Views\\\\V2\\\\Template_Bootstrap' )->should_load()");
    expect(lib(false)).not.toContain('tribe-events/default-template.php');
  });
  it('names a post type archive in the breadcrumb, and leaves empty rows out of text', () => {
    expect(lib(false)).toContain('} elseif ( is_post_type_archive() ) {');
    expect(lib(false)).toContain("array_filter( array_map( 'wmd_text', $value ), 'strlen' )");
  });
});
