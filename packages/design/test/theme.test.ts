import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDesignPlan, buildModel, draftProposal, generateTheme, parsePage, readZip, vocabulary, writeZip, type TargetSchema } from '../src/index.js';
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
    expect(paths).toEqual(expect.arrayContaining(['single-departments.php', 'search.php', 'header.php', 'sidebar.php', 'footer.php', 'inc/wm-design.php', 'functions.php']));
    expect(changes.files.find((f) => f.path === 'single-departments.php')!.action).toBe('replace');
    expect(changes.files.find((f) => f.path === 'sidebar.php')!.action).toBe('create');
    expect(file('functions.php')).toMatch(/^<\?php\nrequire_once get_stylesheet_directory\(\) \. '\/inc\/wm-design\.php';/);
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
    const lib = file('inc/wm-design.php');
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
