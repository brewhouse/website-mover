/**
 * B3 theme generator (docs/build/PLAN.md "Bootstrap 5 in planeteriaweb"): from an approved design
 * plan, the model and the mockups to the theme files a team reviews and commits.
 *
 *   - assets: the mockup's stylesheets, scripts, fonts and the images the CSS and the templates use,
 *     under assets/<job>/ with their relative paths kept (so the CSS's url()s still work)
 *   - inc/<job>.php (inc/wm-design.php before 2026-11-13): enqueues (Bootstrap 5 replaces the theme's Bootstrap 4), new blocks, helpers
 *   - functions.php: one line that loads it. Hand-made design files an earlier step loaded from
 *     functions.php (Newport's B0 inc/newport.php) are retired when nothing left in the theme uses
 *     them: their line goes and they're listed for deletion (`removals`)
 *   - header.php, sidebar.php, footer.php: the mockup's shell, with WordPress menus, the signed-in
 *     user's card and the search form. The theme's own <head> and everything from wp_footer() on are
 *     kept
 *   - a template per mockup page and a render template per block: the mockup's markup with the plan's
 *     bindings (fields, lists, queries, filters, core values)
 * Pure: it returns the files; theme-run.ts writes them, lints them and makes the patch.
 */
import * as cheerio from 'cheerio';
import path from 'node:path';
import { elementChildren, selector, type Collection, type DesignModel, type El } from '../model.js';
import { normText } from '../pages.js';
import type { DesignPlan, FieldType, PlanPart, PlanRelation, PlanTemplate } from '../plan-schema.js';
import { helperLibrary, type EnqueueStyle } from './php-lib.js';
import { bindValue, clearSelected, getter, listItems, loop, Php, resolve, setText, type Source } from './markup.js';

export interface ThemeInput {
  plan: DesignPlan;
  model: DesignModel;
  /** Mockup HTML by file name. */
  pages: Map<string, string>;
  /** Reads a mockup file (assets) by its path in the mockup folder; null when missing. */
  readSource: (rel: string) => Buffer | null;
  /** Reads a file of the original theme by its path in the theme; null when missing. */
  readTheme: (rel: string) => string | null;
  /** The theme's PHP files (paths in the theme). Without it, earlier hand-made design files are kept. */
  listTheme?: () => string[];
  /** Short name for the asset folder and the file headers, e.g. "newport". */
  slug: string;
}

export interface ThemeFile {
  /** Path in the theme folder. */
  path: string;
  data: Buffer;
  action: 'replace' | 'create';
  /** What it's made from. */
  from: string;
}

export interface ThemeChangeSet {
  files: ThemeFile[];
  /** Theme files to delete (git rm), with why. They may be missing from the team's copy. */
  removals: { path: string; why: string }[];
  /** Images and files the mockup CSS refers to that aren't in the mockups. */
  missingAssets: string[];
  /** Parts the generator couldn't bind, pages it skipped, and similar. */
  warnings: string[];
  /** Plan pages by template file. */
  templates: { page: string; file: string; kind: string }[];
}

const PHP_HEAD = (lines: string[]) => `<?php\n/**\n${lines.map((l) => (l ? ` * ${l}` : ' *')).join('\n')}\n */\n`;
/** The Events Calendar's theme override, used on classic themes by TEC and on block themes by the library's hook. */
const EVENTS_TEMPLATE = 'tribe-events/default-template.php';
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const isLocal = (u: string) => !!u && !/^(https?:|data:|mailto:|tel:|#|\/\/|javascript:)/i.test(u) && !u.includes('WMPHP');
const cleanRel = (u: string, base = '') => path.posix.normalize(path.posix.join(base, u.split(/[?#]/)[0]!)).replace(/^(\.\/)+/, '');

export function generateTheme(input: ThemeInput): ThemeChangeSet {
  const { plan, model, slug } = input;
  const warnings: string[] = [];
  const files: ThemeFile[] = [];
  const assets = new Set<string>();
  const assetDir = `assets/${slug}`;
  const origin = `the ${slug} design mockups (design plan v${plan.version})`;
  const add = (p: string, data: string | Buffer, from: string) => {
    files.push({ path: p, data: typeof data === 'string' ? Buffer.from(data) : data, action: input.readTheme(p) !== null ? 'replace' : 'create', from });
  };

  // ── Fields by key ─────────────────────────────────────────────────────────
  const fieldByKey = new Map<string, { name: string; type: FieldType; sub: boolean }>();
  for (const g of plan.fieldGroups)
    for (const f of g.fields) {
      fieldByKey.set(f.key, { name: f.name, type: f.type, sub: false });
      for (const s of f.subFields) fieldByKey.set(s.key, { name: s.name, type: s.type, sub: true });
    }
  const sourceOf = (key: string, inList: boolean): Source | null => {
    if (key.startsWith('core:')) return { kind: 'core', core: key.slice(5) };
    const f = fieldByKey.get(key);
    if (!f) return null;
    return { kind: 'acf', name: f.name, type: f.type, scope: f.sub && inList ? 'sub' : 'field' };
  };
  const sectionModel = (page: string, p: string) => model.pages.find((x) => x.file === page)?.sections.find((s) => s.path === p);
  const collectionModel = (page: string, part: PlanPart): Collection | undefined => sectionModel(page, part.path)?.collections.find((c) => c.path === part.collection);
  const listName = (part: PlanPart): string | null => {
    for (const k of part.fields) {
      const f = fieldByKey.get(k);
      if (f && !f.sub && plan.fieldGroups.some((g) => g.fields.some((x) => x.key === k && x.type === 'repeater'))) return f.name;
    }
    return null;
  };
  const ctx: Ctx = { sourceOf, collection: collectionModel, listName };

  // ── Where mockup pages link to on the site ────────────────────────────────
  const pageEntry = new Map(plan.entries.filter((e) => e.source.component === null).map((e) => [e.source.page, e]));
  const templateOf = new Map(plan.templates.map((t) => [t.page, t]));
  const linkFor = (href: string): string | null => {
    const file = path.posix.basename(href.split(/[?#]/)[0]!);
    if (!/\.html?$/i.test(file)) return null;
    const t = templateOf.get(file);
    const e = pageEntry.get(file);
    if (t?.kind === 'front-page' || /^(index|home)\d*\.html?$/i.test(file)) return "home_url( '/' )";
    if (t?.kind === 'search') return "home_url( '/?s=' )";
    if (e && e.postType === 'page') return `home_url( ${q(`/${e.slug}/`)} )`;
    if (t?.kind === 'single' && t.postType) {
      // A detail page: link to its list page if there is one.
      const list = plan.templates.find((x) => x.postType === t.postType && (x.kind === 'page-template' || x.kind === 'archive') && pageEntry.get(x.page)?.postType === 'page');
      if (list) return `home_url( ${q(`/${pageEntry.get(list.page)!.slug}/`)} )`;
      return `get_post_type_archive_link( ${q(t.postType)} )`;
    }
    // A list a plugin renders (calendar.html → The Events Calendar's /events/).
    if (t?.kind === 'archive' && t.postType && !e) return `get_post_type_archive_link( ${q(t.postType)} )`;
    return null;
  };

  // ── Shared finishing: links, images, forms, breadcrumbs, pagination ───────
  const finish = ($: cheerio.CheerioAPI, php: Php, scope: cheerio.Cheerio<never>) => {
    scope.find('nav').each((_, nav) => {
      const $nav = $(nav);
      const ol = $nav.find('ol.breadcrumb, ul.breadcrumb, .breadcrumb').first();
      if (!ol.length && !/breadcrumb/i.test($nav.attr('aria-label') ?? '')) return;
      const list = ol.length ? ol : $nav.find('ol, ul').first();
      const li = list.children('li').first();
      const liClass = (li.attr('class') ?? '').split(/\s+/).filter((c) => c && c !== 'active').join(' ');
      $nav.replaceWith(php.token(`<?php wmd_breadcrumb( ${q(list.attr('class') ?? '')}, ${q(liClass)} ); ?>`));
    });
    // A breadcrumb list without a <nav> around it.
    scope.find('ol.breadcrumb, ul.breadcrumb').each((_, list) => {
      const $l = $(list);
      const liClass = ($l.children('li').first().attr('class') ?? '').split(/\s+/).filter((c) => c && c !== 'active').join(' ');
      $l.replaceWith(php.token(`<?php wmd_breadcrumb( ${q($l.attr('class') ?? '')}, ${q(liClass)} ); ?>`));
    });
    scope.find('[class*="pagination"]').each((_, el) => {
      const $p = $(el);
      if ($p.parents('[class*="pagination"]').length) return;
      const ul = $p.find('ul, ol').first();
      if (!ul.length) return;
      const links = $p.find('a').toArray().filter((a) => !$(a).closest('ul, ol').length);
      const order = $p.find('*').toArray();
      const before = links.filter((a) => order.indexOf(a) < order.indexOf(ul.get(0)!));
      const after = links.filter((a) => !before.includes(a));
      const dir = (a: unknown, which: 'prev' | 'next') => {
        $(a as never)
          .removeAttr('aria-disabled')
          .removeAttr('tabindex')
          .attr('href', php.echo(`esc_url( $wmd_pages['${which}'] ? $wmd_pages['${which}'] : '#' )`))
          .attr('wmdattr', php.echo(`$wmd_pages['${which}'] ? '' : ' aria-disabled="true" tabindex="-1"'`));
      };
      if (before[0]) dir(before[0], 'prev');
      if (after[after.length - 1]) dir(after[after.length - 1], 'next');
      const li = ul.children('li').filter((_, x) => $(x).find('a').length > 0).first();
      const liCls = li.attr('class') ? ` class="${li.attr('class')}"` : '';
      const aCls = li.find('a').attr('class') ? ` class="${li.find('a').attr('class')}"` : '';
      ul.html(
        php.token(
          `<?php foreach ( $wmd_pages['pages'] as $wmd_p ) : ?><li${liCls}><?php if ( $wmd_p[1] ) : ?><a${aCls} href="<?php echo esc_url( $wmd_p[1] ); ?>"><?php echo esc_html( $wmd_p[0] ); ?></a><?php elseif ( $wmd_p[2] ) : ?><a${aCls} href="<?php echo esc_url( get_pagenum_link( (int) $wmd_p[0] ) ); ?>" aria-current="page"><?php echo esc_html( $wmd_p[0] ); ?></a><?php else : ?><span><?php echo esc_html( $wmd_p[0] ); ?></span><?php endif; ?></li><?php endforeach; ?>`,
        ),
      );
      $p.before(php.token("<?php $wmd_pages = wmd_pages( isset( $wmd_main ) ? $wmd_main : null ); if ( $wmd_pages['total'] > 1 ) : ?>")).after(php.token('<?php endif; ?>'));
    });
    scope.find('form').each((_, form) => {
      const $f = $(form);
      const input = $f.find('input[type="search"], input[name="s"]').first();
      if (!input.length) return;
      $f.attr('action', php.echo("esc_url( home_url( '/' ) )")).attr('method', 'get');
      input.attr('name', 's').attr('value', php.echo('esc_attr( get_search_query() )'));
    });
    const asset = (u: string) => {
      const rel = cleanRel(u);
      assets.add(rel);
      return php.echo(`esc_url( wmd_asset( ${q(rel)} ) )`);
    };
    scope
      .find('img[src], source[srcset], img[srcset]')
      .addBack('img[src]')
      .each((_, img) => {
        const $i = $(img);
        const src = $i.attr('src');
        if (src && isLocal(src)) $i.attr('src', asset(src));
        const set = $i.attr('srcset');
        if (set && isLocal(set.split(/\s+/)[0]!)) $i.attr('srcset', set.replace(/(^|,\s*)(\S+)/g, (m, sep: string, u: string) => (isLocal(u) ? `${sep}${asset(u)}` : m)));
      });
    scope
      .find('[style*="url("]')
      .addBack('[style*="url("]')
      .each((_, el) => {
        const $e = $(el);
        $e.attr('style', ($e.attr('style') ?? '').replace(/url\((['"]?)([^'")]+)\1\)/g, (m, qt: string, u: string) => (isLocal(u) ? `url(${qt}${asset(u)}${qt})` : m)));
      });
    scope
      .find('a[href]')
      .addBack('a[href]')
      .each((_, a) => {
        const $a = $(a);
        const href = $a.attr('href')!;
        if (!isLocal(href)) return;
        const to = linkFor(href);
        if (to) $a.attr('href', php.echo(`esc_url( ${to} )`));
        else if (/\.html?([?#]|$)/i.test(href)) $a.attr('href', '#');
        else $a.attr('href', asset(href));
      });
    scope.find('script[src]').remove();
  };

  // ── Content root and page extras ─────────────────────────────────────────
  const loaded = new Map([...input.pages].map(([file, html]) => [file, html]));
  const rootOf = ($: cheerio.CheerioAPI): El | null => (model.shell.contentRoot ? (($(model.shell.contentRoot).first().get(0) as unknown as El) ?? null) : null);
  const shellSigs = new Set(model.shell.landmarks.map((l) => l.signature));
  const isShell = (el: El) => shellSigs.has(selector(el));
  /** Elements beside the content root's ancestors (not shell): a modal, a page-only banner. */
  const offChain = ($: cheerio.CheerioAPI, root: El): El[] => {
    const out: El[] = [];
    for (let a: El | null = root; a && a.parent && a.name !== 'body'; a = a.parent) {
      for (const sib of elementChildren(a.parent)) if (sib !== a && !isShell(sib)) out.push(sib);
    }
    return out;
  };
  const offCounts = new Map<string, number>();
  for (const [, html] of loaded) {
    const $ = cheerio.load(html);
    const root = rootOf($);
    if (!root) continue;
    for (const s of new Set(offChain($, root).map((e) => selector(e)))) offCounts.set(s, (offCounts.get(s) ?? 0) + 1);
  }
  const common = (el: El) => (offCounts.get(selector(el)) ?? 0) >= Math.max(2, loaded.size * 0.6);

  // ── Templates ─────────────────────────────────────────────────────────────
  const done = new Map<string, string>();
  const templates: ThemeChangeSet['templates'] = [];
  let events = false;
  for (const t of plan.templates) {
    if (!t.file && t.postType === 'tribe_events' && !done.has(EVENTS_TEMPLATE)) {
      // The Events Calendar renders the events; the mockup gives the page around them.
      const html = loaded.get(t.page);
      const $ = html ? cheerio.load(html) : null;
      const root = $ ? rootOf($) : null;
      if ($ && root) {
        const php = new Php();
        const views = [...new Set(t.parts.filter((p) => p.binding === 'query' || p.collection).map((p) => p.path))].map((p) => resolve(root, p)).filter((x): x is El => !!x);
        const outer = views.filter((v) => !views.some((o) => o !== v && $(o as never).find(v as never).length));
        const view = php.token("<?php echo tribe( '\\Tribe\\Events\\Views\\V2\\Template_Bootstrap' )->get_view_html(); // phpcs:ignore WordPress.Security.EscapeOutput ?>");
        outer.forEach((v, i) => $(v as never).replaceWith(i === 0 ? view : ''));
        if (!outer.length) $(root as never).append(view);
        const intro = t.parts.find((p) => p.component === 'page_intro' || /intro|heading|hero/i.test(p.component));
        const heading = $(root as never).find('h1').first().text().replace(/\s+/g, ' ').trim() || intro?.heading || 'Events';
        $(root as never).find('h1').first().text(php.echo(`esc_html( is_singular() ? get_the_title() : ${q(heading)} )`));
        const scope = $('<div></div>');
        scope.append($(root as never));
        finish($, php, scope as never);
        const head = PHP_HEAD([`${t.page} in ${origin}, generated by Website Mover.`, "The Events Calendar's list, month and single event views, inside the site's header, sidebar and footer.", 'On a block theme (a child of Twenty Twenty-Two) the helper library sends those pages here.', 'Regenerate rather than edit.', '', '@package planeteriaweb']);
        const code = `${head}\n$GLOBALS['wmd_archive_titles']['tribe_events'] = ${q(heading)};\nget_header();\n?>\n${php.render(scope.html() ?? '').trim()}\n<?php\nget_footer();\n`;
        add(EVENTS_TEMPLATE, code, t.page);
        done.set(EVENTS_TEMPLATE, t.page);
        templates.push({ page: t.page, file: EVENTS_TEMPLATE, kind: t.kind });
        events = true;
        if (!outer.length) warnings.push(`${t.page}: no event list found in the mockup; The Events Calendar's view goes at the end of ${EVENTS_TEMPLATE}`);
        continue;
      }
    }
    if (!t.file) {
      warnings.push(`${t.page}: rendered by a plugin's own views (${t.postType ?? 'no post type'}), so no template. The mockup's CSS styles it where the class names match.`);
      continue;
    }
    if (done.has(t.file)) {
      warnings.push(`${t.page}: ${t.file} is made from ${done.get(t.file)} (two mockups for one template); check that it covers this page too.`);
      continue;
    }
    const html = loaded.get(t.page);
    if (!html) {
      warnings.push(`${t.page}: not in the mockups`);
      continue;
    }
    done.set(t.file, t.page);
    const $ = cheerio.load(html);
    const root = rootOf($);
    if (!root) {
      warnings.push(`${t.page}: no content root (${model.shell.contentRoot})`);
      continue;
    }
    // A root class named after another mockup page is a copy-paste from it (page-builder1.html's
    // "classifieds"), and would give this page that page's styles.
    const own = (f: string) => f.replace(/\.html?$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const borrowed = (root.attribs.class ?? '').split(/\s+/).filter((c) => c && !own(t.page).includes(c.toLowerCase()) && [...loaded.keys()].some((f) => f !== t.page && own(f).includes(c.toLowerCase()) && c.length > 3));
    if (borrowed.length) {
      $(root as never).removeClass(borrowed.join(' '));
      warnings.push(`${t.page}: left out the content class${borrowed.length > 1 ? 'es' : ''} ${borrowed.map((c) => `"${c}"`).join(', ')}, which belong${borrowed.length > 1 ? '' : 's'} to another mockup page`);
    }
    const php = new Php();
    bindParts($, php, root, t, 'template', warnings, ctx);
    bindRelationFilters($, php, root, t.page, plan.relations, warnings);
    const extras = offChain($, root).filter((e) => !common(e) && e.name !== 'script');
    const scope = $('<div></div>');
    scope.append($(root as never));
    for (const e of extras) scope.append($(e as never));
    finish($, php, scope as never);
    const body = php.render(scope.html() ?? '');
    const original = input.readTheme(t.file);
    const templateName = /Template Name:\s*([^*\n]+)/.exec(original ?? '')?.[1]?.trim() ?? (t.kind === 'page-template' ? pageEntry.get(t.page)?.title ?? t.page : null);
    const singular = ['front-page', 'page', 'page-template', 'single'].includes(t.kind);
    const head = PHP_HEAD([...(templateName ? [`Template Name: ${templateName}`, ''] : []), `${t.page} in ${origin}, generated by Website Mover.`, `Kind: ${t.kind}${t.postType ? ` (${t.postType})` : ''}. Regenerate rather than edit.`, '', '@package planeteriaweb']);
    const code = `${head}\nget_header();\n${singular ? 'while ( have_posts() ) :\n\tthe_post();\n\t?>' : '?>'}\n${body.trim()}\n${singular ? '<?php\nendwhile;\n' : '<?php\n'}get_footer();\n`;
    add(t.file, code, t.page);
    templates.push({ page: t.page, file: t.file, kind: t.kind });
  }

  // ── Blocks ────────────────────────────────────────────────────────────────
  for (const b of plan.blocks) {
    const t = plan.templates.find((x) => x.page === b.from.page);
    const parts = t?.parts.filter((p) => p.block === b.name && p.component === b.from.component) ?? [];
    const html = loaded.get(b.from.page);
    if (!t || !parts.length || !html) {
      warnings.push(`Block ${b.name}: no section to make it from`);
      continue;
    }
    const $ = cheerio.load(html);
    const root = rootOf($);
    const section = root && resolve(root, parts[0]!.path);
    if (!section) {
      warnings.push(`Block ${b.name}: section ${parts[0]!.path} not found in ${b.from.page}`);
      continue;
    }
    const php = new Php();
    bindParts($, php, root!, { ...t, parts }, 'block', warnings, ctx);
    const $s = $(section as never);
    $s.attr('id', php.echo('esc_attr( $wmd_id )'));
    $s.attr('class', `${$s.attr('class') ?? ''}${php.echo('esc_attr( $wmd_class )')}`.trim());
    const scope = $('<div></div>');
    scope.append($s);
    finish($, php, scope as never);
    const head = PHP_HEAD([`Block: ${b.title} (acf/${b.name}), from ${b.from.component} in ${b.from.page}.`, `Generated by Website Mover from ${origin}. Regenerate rather than edit.`, '', '@param array  $block      The block settings and attributes.', '@param string $content    The block inner HTML (empty).', '@param bool   $is_preview True during AJAX preview.', '@param int    $post_id    The post the block is saved to.', '', '@package planeteriaweb']);
    const code = `${head}\n$wmd_id    = ! empty( $block['anchor'] ) ? $block['anchor'] : 'wmd-' . $block['id'];\n$wmd_class = ! empty( $block['className'] ) ? ' ' . $block['className'] : '';\n?>\n${php.render(scope.html() ?? '').trim()}\n`;
    add(b.template, code, `${b.from.page} ${b.from.component}`);
  }

  // ── Shell: header, sidebar, footer ────────────────────────────────────────
  // The page with the whole shell and the most in it (the fullest menus).
  const shellPage = [...loaded]
    .map(([file, html]) => {
      const $ = cheerio.load(html);
      const whole = [...shellSigs].every((sig) => $(sig).length > 0) && !!rootOf($);
      return { file, html, size: whole ? [...shellSigs].reduce((n, sig) => n + $(sig).find('*').length, 0) : -1 };
    })
    .filter((x) => x.size >= 0)
    .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file))
    .map((x) => [x.file, x.html] as const)[0];
  const styles: EnqueueStyle[] = [];
  const scripts: EnqueueStyle[] = [];
  if (!shellPage) warnings.push('No mockup page has the whole shell (header, sidebar, footer): header.php and footer.php are unchanged');
  else {
    const [file, html] = shellPage;
    const $ = cheerio.load(html);
    const php = new Php();
    const handle = (u: string) => `wmd-${path.posix.basename(u.split(/[?#]/)[0]!).replace(/\.(min\.)?(css|js)$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    $('head link[rel="stylesheet"][href], body link[rel="stylesheet"][href]').each((_, l) => {
      const href = $(l).attr('href')!;
      styles.push(isLocal(href) ? { handle: handle(href), src: cleanRel(href), external: false } : { handle: handle(href), src: href, external: true });
    });
    $('script[src]').each((_, s) => {
      const src = $(s).attr('src')!;
      if (/(^|\/)jquery(\.min)?\.js$/i.test(src)) return; // WordPress's jQuery
      scripts.push(isLocal(src) ? { handle: handle(src), src: cleanRel(src), external: false } : { handle: handle(src), src, external: true });
    });
    const root = rootOf($)!;
    for (const e of offChain($, root)) if (!common(e)) $(e as never).remove();
    $('body script, body noscript').remove();
    $(root as never).replaceWith('WMDCONTENTX');

    // Menus.
    for (const m of model.shell.menus) {
      const menu = plan.menus.find((x) => x.source === m.signature);
      const nav = $(m.signature).first();
      const ul = nav.is('ul') ? nav : nav.find('ul').first();
      if (!menu || !ul.length) continue;
      const li = ul.children('li').first();
      const cls = (x: cheerio.Cheerio<never>) => (x.attr('class') ?? '').split(/\s+/).filter((c) => c && !/^(active|current|show|open)$/.test(c)).join(' ');
      const depth = (items: { children: unknown[] }[]): number => (items.length ? 1 + Math.max(0, ...items.map((i) => depth(i.children as never))) : 0);
      const icons: string[] = [];
      ul.find('li > a').each((_, a) => {
        const img = $(a).children('img').first();
        if (!img.length || !isLocal(img.attr('src') ?? '')) return;
        const rel = cleanRel(img.attr('src')!);
        assets.add(rel);
        icons.push(`${q($(a).text().replace(/\s+/g, ' ').trim())} => ${q(rel)}`);
      });
      const opts = [`'ul' => ${q(cls(ul as never))}`, `'li' => ${q(cls(li as never))}`, `'a' => ${q(cls(li.children('a').first() as never))}`, `'sub' => ${q(cls(ul.find('ul').first() as never))}`, `'depth' => ${Math.max(1, depth(m.items))}`, `'icons' => array( ${icons.join(', ')} )`];
      ul.replaceWith(php.token(`<?php wmd_menu( ${q(menu.name)}, array( ${opts.join(', ')} ) ); ?>`));
    }

    // The signed-in user's card ("Welcome, Jane S.").
    $('[class*="profile"], [class*="user"], [class*="account"]').each((_, card) => {
      const $c = $(card);
      if ($c.parents('[class*="profile"], [class*="user"], [class*="account"]').length) return;
      const leaves = $c.find('*').addBack().toArray().filter((d) => !elementChildren(d as unknown as El).length && /\S/.test($(d).text()));
      const initials = leaves.find((d) => /^[A-Z]{1,3}$/.test($(d).text().trim()));
      if (!initials) return;
      setText($, initials as unknown as El, php.echo("esc_html( $wmd_user['initials'] )"));
      for (const d of leaves) {
        if (d === initials) continue;
        const text = $(d).text().replace(/\s+/g, ' ').trim();
        const named = /^(.*?)([A-Z][a-z]+ [A-Z]\.)$/.exec(text);
        if (named) setText($, d as unknown as El, php.echo(`esc_html( ${q(named[1]!)} . $wmd_user['short_name'] )`));
        else {
          setText($, d as unknown as El, php.echo("esc_html( $wmd_user['department'] )"));
          $(d).before(php.token("<?php if ( $wmd_user['department'] ) : ?>")).after(php.token('<?php endif; ?>'));
        }
      }
      if ($c.is('a')) $c.attr('href', php.echo("esc_url( $wmd_user['profile'] )"));
      $c.before(php.token('<?php if ( is_user_logged_in() ) : $wmd_user = wmd_user(); ?>')).after(php.token('<?php endif; ?>'));
    });

    // The sidebar landmark becomes sidebar.php.
    const aside = [...shellSigs].map((s) => $(s).first()).find((x) => x.is('aside'));
    if (aside?.length) {
      const scope = $('<div></div>');
      const marker = php.token('<?php get_sidebar(); ?>');
      aside.before(marker);
      scope.append(aside);
      finish($, php, scope as never);
      add('sidebar.php', `${PHP_HEAD([`The sidebar from ${file} in ${origin}: the signed-in user's card and the site menu.`, 'Generated by Website Mover. Regenerate rather than edit.', '', '@package planeteriaweb'])}?>\n${php.render(scope.html() ?? '').trim()}\n`, file);
    }
    finish($, php, $('body') as never);
    const [before, after = ''] = php.render($('body').html() ?? '').split('WMDCONTENTX');
    const bodyClass = $('body').attr('class');

    const origHeader = input.readTheme('header.php') ?? '';
    // The real <head> is the last one before </head> (a doc comment may mention "<head>").
    const headEnd = origHeader.search(/<\/head>/i);
    const headStart = headEnd > 0 ? origHeader.slice(0, headEnd).search(/<head(\s[^>]*)?>(?![\s\S]*<head(\s[^>]*)?>)/i) : -1;
    const headInner = headStart >= 0 ? origHeader.slice(origHeader.indexOf('>', headStart) + 1, headEnd) : null;
    const headFallback = `\n\t<meta charset="<?php bloginfo( 'charset' ); ?>">\n\t<meta name="viewport" content="width=device-width, initial-scale=1">\n\t<?php wp_head(); ?>\n`;
    // The theme's Google Fonts give way to the design's (enqueued).
    const keptHead = (headInner ?? headFallback)
      .split('\n')
      .filter((l) => !/fonts\.googleapis\.com\/css|fonts\.gstatic\.com|<!--\s*Bootstrap/i.test(l))
      .join('\n');
    add(
      'header.php',
      `${PHP_HEAD([`The header: the theme's <head>, then the shell of ${file} in ${origin} up to the page content.`, 'footer.php closes what this opens. Generated by Website Mover. Regenerate rather than edit.', '', '@package planeteriaweb'])}?><!DOCTYPE html>\n<html <?php language_attributes(); ?>>\n<head>${keptHead.replace(/\s+$/, '')}\n</head>\n\n<body <?php body_class(${bodyClass ? ` ${q(bodyClass)} ` : ''}); ?>>\n<?php wp_body_open(); ?>\n${before.replace(/^\s*\n/, '').replace(/\s+$/, '')}\n`,
      file,
    );
    const origFooter = input.readTheme('footer.php') ?? '';
    const at = origFooter.indexOf('wp_footer(');
    const from = at >= 0 ? origFooter.lastIndexOf('<?php', at) : -1;
    const tail = from >= 0 ? origFooter.slice(from) : '<?php wp_footer(); ?>\n</body>\n</html>\n';
    add('footer.php', `${PHP_HEAD([`The footer: the shell of ${file} in ${origin} after the page content, then the theme's own`, 'wp_footer() and what follows it. Generated by Website Mover. Regenerate rather than edit.', '', '@package planeteriaweb'])}?>\n${after.replace(/^\s*\n/, '').replace(/\s+$/, '')}\n${tail}`, file);
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  const missingAssets = new Set<string>();
  const queue = [...styles.filter((s) => !s.external).map((s) => s.src), ...scripts.filter((s) => !s.external).map((s) => s.src), ...assets];
  const seen = new Set<string>();
  while (queue.length) {
    const rel = queue.shift()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const data = input.readSource(rel);
    if (!data) {
      missingAssets.add(rel);
      continue;
    }
    add(`${assetDir}/${rel}`, data, rel);
    if (rel.endsWith('.css')) {
      const css = data.toString('utf8');
      for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g)) {
        const u = (m[2] ?? m[4])!.trim();
        if (isLocal(u)) queue.push(cleanRel(u, path.posix.dirname(rel)));
      }
    }
  }

  // ── The helper library (inc/<slug>.php) and functions.php ──────────────────
  const functions = input.readTheme('functions.php');
  // Named after the job (inc/newport.php), like assets/<slug>/; a theme file of that name that isn't
  // ours keeps the generic name.
  const ours = (rel: string) => /Website Mover design build/.test(input.readTheme(rel) ?? 'Website Mover design build');
  const legacy = retireLegacy(input, functions, new Set(files.map((f) => f.path)), warnings);
  const removals = legacy.removals;
  const libPath = /^[a-z0-9][a-z0-9_-]*$/i.test(slug) && (ours(`inc/${slug}.php`) || removals.some((r) => r.path === `inc/${slug}.php`)) ? `inc/${slug}.php` : 'inc/wm-design.php';
  if (libPath !== 'inc/wm-design.php' && legacy.retired.length) removals.push({ path: 'inc/wm-design.php', why: `the library's earlier name; it's ${libPath} now` });
  const enqueued = (fn: 'style' | 'script') => [...(functions ?? '').matchAll(new RegExp(`wp_enqueue_${fn}\\(\\s*['"]([^'"]+)['"]\\s*,\\s*[^;]*?['"]([^'"]+\\.${fn === 'style' ? 'css' : 'js'})['"]`, 'g'))].map((m) => ({ handle: m[1]!, file: m[2]! }));
  const mockupScripts = new Set(scripts.map((s) => path.posix.basename(s.src)));
  // The theme's Bootstrap 4 and old stylesheets, and anything an earlier design step put under
  // css/<slug>/ or js/<slug>/ (B0's Bootstrap 5 and newport.css): assets/<slug>/ replaces them.
  const earlier = (dirName: string, file: string) => new RegExp(`/${dirName}/${slug.replace(/[^\w-]/g, '')}/`).test(file);
  const dequeueStyles = enqueued('style')
    .filter((s) => /\/css\/(bootstrap|custom|responsive|style)[\w.-]*\.css$/.test(s.file) || earlier('css', s.file))
    .map((s) => s.handle);
  const dequeueScripts = enqueued('script')
    .filter((s) => /\/js\/(popper|bootstrap)[\w.-]*\.js$/.test(s.file) || mockupScripts.has(path.posix.basename(s.file)) || earlier('js', s.file))
    .map((s) => s.handle);
  add(
    libPath,
    helperLibrary({
      assetDir,
      styles,
      scripts,
      dequeueStyles: [...new Set(dequeueStyles)],
      dequeueScripts: [...new Set(dequeueScripts)],
      relations: plan.relations.map((r) => ({ name: r.name, param: r.param, relatesTo: r.relatesTo, on: r.on.map((o) => o.postType) })),
      blocks: plan.blocks.filter((b) => b.action === 'create').map((b) => ({ name: b.name, title: b.title, template: b.template, icon: 'layout' })),
      origin,
      events,
      stamp: `${slug} v${plan.version}`,
    }),
    'generated',
  );
  // One line loads it. A line for an earlier name of the library (inc/wm-design.php, or a line we
  // added) is replaced, so the library is never loaded twice.
  const line = `require_once get_stylesheet_directory() . '/${libPath}'; // Website Mover design build`;
  if (functions === null) warnings.push(`The theme has no functions.php: load ${libPath} from it by hand`);
  else {
    const lines = functions.split('\n');
    const isLoader = (l: string) => /\brequire(_once)?\b/.test(l) && (l.includes('Website Mover design build') || l.includes("/inc/wm-design.php'") || l.includes(`/${libPath}'`) || legacy.retired.some((r) => l.includes(`/${r}'`)));
    const loaders = lines.filter(isLoader);
    if (!(loaders.length === 1 && loaders[0]!.includes(`/${libPath}'`) && !legacy.retired.some((r) => loaders[0]!.includes(`/${r}'`)))) {
      if (libPath !== 'inc/wm-design.php' && functions.includes("/inc/wm-design.php'") && !removals.some((r) => r.path === 'inc/wm-design.php')) removals.push({ path: 'inc/wm-design.php', why: `the library's earlier name; it's ${libPath} now` });
      const kept = lines.filter((l) => !isLoader(l)).join('\n');
      add('functions.php', kept.replace(/^<\?php[^\n]*\n/, (m) => `${m}${line}\n`), loaders.length ? 'the line loading the library updated' : 'one line added');
    }
  }

  // A retired file whose path the library now takes is replaced, not deleted.
  const kept = new Set(files.map((f) => f.path));
  return { files, removals: removals.filter((r) => !kept.has(r.path)), missingAssets: [...missingAssets].sort(), warnings, templates };
}

/**
 * Design files an earlier step made by hand and loaded from functions.php (Newport's B0
 * inc/newport.php, which loads inc/newport-home.php). They're retired when no theme file the change
 * set leaves in place calls a function they define; otherwise they stay and a warning says which
 * file still uses them.
 */
function retireLegacy(input: ThemeInput, functions: string | null, changed: Set<string>, warnings: string[]): { retired: string[]; removals: { path: string; why: string }[] } {
  const none = { retired: [], removals: [] };
  if (!functions || !input.listTheme) return none;
  const roots = [...functions.matchAll(/\brequire(?:_once)?\s*\(?\s*get_(?:stylesheet|template)_directory\(\)\s*\.\s*'\/(inc\/[\w./-]+\.php)'/g)]
    .map((m) => m[1]!)
    .filter((rel) => {
      const src = input.readTheme(rel);
      return src !== null && !/Website Mover design build/.test(src) && /Website Mover|design \(B\d/.test(src);
    });
  if (!roots.length) return none;
  // Each root with the files it loads from its own folder.
  const group = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.shift()!;
    if (group.has(rel)) continue;
    group.add(rel);
    for (const m of (input.readTheme(rel) ?? '').matchAll(/\brequire(?:_once)?\s*\(?\s*__DIR__\s*\.\s*'\/([\w.-]+\.php)'/g)) {
      const child = path.posix.join(path.posix.dirname(rel), m[1]!);
      if (input.readTheme(child) !== null) queue.push(child);
    }
  }
  const defined = new Set([...group].flatMap((rel) => [...(input.readTheme(rel) ?? '').matchAll(/^\s*function\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]!)));
  const users: string[] = [];
  for (const rel of input.listTheme()) {
    if (group.has(rel) || changed.has(rel) || rel === 'functions.php' || !rel.endsWith('.php')) continue;
    const src = input.readTheme(rel) ?? '';
    const call = [...defined].find((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
    if (call) users.push(`${rel} (${call}())`);
  }
  if (users.length) {
    warnings.push(`Kept ${[...group].join(', ')} from an earlier design step: ${users.slice(0, 5).join(', ')} still use it. Retire it by hand once nothing does`);
    return none;
  }
  return { retired: roots, removals: [...group].map((rel) => ({ path: rel, why: 'an earlier design step (B0); the generated templates replace it' })) };
}

/**
 * Applies a template's parts to the page DOM: values become PHP, lists become loops. In "template"
 * mode block sections are left to the_content(); in "block" mode they are the block's markup.
 */
/**
 * "Filter by Department": the drop-down offers the related post type's entries, each option the
 * listing's URL filtered by it, and choosing one goes there.
 */
function bindRelationFilters($: cheerio.CheerioAPI, php: Php, root: El, page: string, relations: PlanRelation[], warnings: string[]): void {
  for (const rel of relations) {
    for (const f of rel.filters.filter((x) => x.page === page && x.themed)) {
      const found = $(root as never)
        .find('select')
        .toArray()
        .find((d) => (f.id ? d.attribs.id === f.id : d.attribs.name === f.name));
      if (!found) {
        warnings.push(`${page}: the "${f.label}" drop-down wasn't found, so it isn't linked to ${rel.relatesTo}`);
        continue;
      }
      const n = q(rel.name);
      // Its value is a URL, not a form value: it must not be submitted with a form around it.
      $(found).removeAttr('name').attr('onchange', 'if ( this.value ) { window.location.href = this.value; }');
      $(found)
        .empty()
        .append(
          php.token(
            `<option value="<?php echo esc_url( wmd_related_filter_url( ${n} ) ); ?>"><?php echo esc_html( wmd_related_all_label( ${n} ) ); ?></option><?php $wmd_picked = wmd_related_selected( ${n} ); foreach ( wmd_related_choices( ${n} ) as $wmd_choice ) : ?><option value="<?php echo esc_url( wmd_related_filter_url( ${n}, $wmd_choice ) ); ?>"<?php selected( $wmd_picked && $wmd_picked->ID === $wmd_choice->ID ); ?>><?php echo esc_html( get_the_title( $wmd_choice ) ); ?></option><?php endforeach; ?>`,
          ),
        );
    }
  }
}

function bindParts($: cheerio.CheerioAPI, php: Php, root: El, t: PlanTemplate, mode: 'template' | 'block', warnings: string[], ctx: Ctx): void {
  // Everything is found before anything changes, so paths stay valid.
  type Job = () => void;
  const values: Job[] = [];
  const loops: Job[] = [];
  const later: Job[] = [];
  const blockSections: El[] = [];
  let hasContent = false;
  let q = 0;
  // A section shows only when one of its values does (an empty list, a heading over nothing):
  // conditions per section; null means something in it always shows.
  const shows = new Map<El, (string | null)[]>();
  const when = (section: El, cond: string | null) => shows.set(section, [...(shows.get(section) ?? []), cond]);
  // A section with a list shows when the list has entries (its heading and "View all" link alone don't count).
  const lists = new Map<El, string[]>();
  const whenList = (section: El, cond: string) => (when(section, cond), lists.set(section, [...(lists.get(section) ?? []), cond]));
  const wrapped = new Set<El>();
  const queries = new Map<El, string[]>(); // section → its lists' queries, run before it when it's wrapped
  for (const part of t.parts) {
    const section = resolve(root, part.path);
    if (!section) {
      warnings.push(`${t.page}: section ${part.path} isn't in the mockup any more`);
      continue;
    }
    // The section's own words (its heading) show with its values; other kept markup always shows.
    if (!['fields', 'core', 'query', 'repeater'].includes(part.binding) && !(part.binding === 'theme' && part.collection === null)) when(section, null);
    if (part.binding === 'block' && mode === 'template') {
      if (!blockSections.includes(section)) blockSections.push(section);
      continue;
    }
    // Any part that prints the content (the AI may bind it as 'fields'): blocks render inside it.
    if (part.values.some((v) => v.field === 'core:content')) hasContent = true;
    const where = `${t.page} ${part.component}${part.collection ? ` (${part.collection || 'list'})` : ''}`;

    if (part.collection === null) {
      if (!['fields', 'core', 'block'].includes(part.binding)) continue;
      for (const v of part.values) {
        const el = resolve(section, v.path);
        const src = ctx.sourceOf(v.field, false);
        if (!el || !src) {
          warnings.push(`${where}: ${v.field} at "${v.path}" not bound`);
          continue;
        }
        when(section, showsWhen(v.field, src));
        (v.field === 'core:content' ? later : values).push(() => {
          if (!bindValue($, php, el, src)) warnings.push(`${where}: ${v.field} at "${v.path}" not bound`);
        });
      }
      continue;
    }

    const coll = ctx.collection(t.page, part);
    const search = t.kind === 'search' && part.binding === 'theme' && coll?.role === 'items' && coll.count >= 2;
    if (search) when(section, null);
    if (!['repeater', 'query', 'filter', 'block'].includes(part.binding) && !search) continue;
    if (!coll) {
      warnings.push(`${where}: list not in the model`);
      continue;
    }
    const list = listItems(section, part.collection, coll.item);
    if (!list) {
      warnings.push(`${where}: no ${coll.item} items found`);
      continue;
    }
    let items = list.items;
    if (part.binding === 'filter') {
      // "All" stays as it is, pointing at the unfiltered list.
      // The mockup's selected-state class ("is-active"), set by the selected term at run time.
      const linkIn = (e: El) => (e.name === 'a' ? e : (($(e as never).find('a').get(0) as unknown as El) ?? null));
      const stateClass = items.flatMap((e) => [e, linkIn(e)]).flatMap((e) => (e?.attribs.class ?? '').split(/\s+/)).find((c) => /^(is-active|active|current|selected)$/.test(c));
      const marked = (e: El) => (stateClass && (e.attribs.class ?? '').split(/\s+/).includes(stateClass) ? e : linkIn(e) ?? e);
      const select = (e: El, cond: string) => {
        const target = marked(e);
        clearSelected($, e);
        if (stateClass) $(target as never).attr('class', `${$(target as never).attr('class') ?? ''}${php.echo(`${cond} ? ' ${stateClass}' : ''`)}`);
        const a = linkIn(e);
        if (a) $(a as never).attr('wmdattr', php.echo(`${cond} ? ' aria-current="true"' : ''`));
      };
      if (items.length > 1 && /^all\b/i.test(normText($(items[0] as never).text()))) {
        const all = items[0]!;
        values.push(() => {
          select(all, "'' === wmd_current_term()");
          const a = linkIn(all);
          if (a) $(a as never).attr('href', php.echo("esc_url( wmd_filter_base_url( 'wmd_term' ) )"));
        });
        items = items.slice(1);
      }
      const item = items[0]!;
      values.push(() => {
        select(item, 'wmd_current_term() === $wmd_term->slug');
        const a = linkIn(item);
        if (a) {
          $(a as never).attr('href', php.echo('esc_url( wmd_term_filter_url( $wmd_term ) )'));
          setText($, a, php.echo('esc_html( $wmd_term->name )'));
        } else setText($, item, php.echo('esc_html( $wmd_term->name )'));
      });
      loops.push(() => loop($, php, items, `<?php foreach ( wmd_terms( '${part.taxonomy ?? ''}', '${part.postType ?? ''}' ) as $wmd_term ) : ?>`, '<?php endforeach; ?>'));
      continue;
    }

    const item = items[0]!;
    const bindings = search ? searchValues(coll) : [...part.values];
    if (part.binding === 'query' || search) {
      // An entry's title links to it, and initials come from its title, unless the plan says otherwise.
      const title = bindings.find((v) => v.field === 'core:title');
      if (title && !bindings.some((v) => v.field === 'core:permalink')) bindings.push({ field: 'core:permalink', path: title.path });
      // Initials badges (often aria-hidden, so not in the model): a class saying so and 1–3 capitals.
      $(item as never)
        .find('[class*="initial"], [class*="avatar"]')
        .each((_, d) => {
          if (!/^[A-Z]{1,3}$/.test($(d).text().trim())) return;
          values.push(() => bindValue($, php, d as unknown as El, { kind: 'core', core: 'initials' }));
        });
    }
    if (!bindings.length) {
      warnings.push(`${where}: no fields are bound to this list, so it stays as the mockup's markup (sample text)`);
      continue;
    }
    if (coll.collections.some((c) => c.role === 'items') && part.binding !== 'query') warnings.push(`${where}: each row repeats the list inside it as the mockup has it (sample text); give that inner list a post type on review to show real entries`);
    const inList = part.binding !== 'query' && !search;
    const main = part.binding === 'query' && (t.kind === 'page-template' || t.kind === 'archive') && part.postType === t.postType && !t.parts.some((o) => o !== part && o.binding === 'query' && o.postType === t.postType && (ctx.collection(t.page, o)?.count ?? 0) > coll.count);
    const qv = main ? '$wmd_main' : `$wmd_q${++q}`;
    if (part.binding === 'query') {
      if (main) when(section, null);
      else {
        whenList(section, `${qv}->have_posts()`);
        queries.set(section, [...(queries.get(section) ?? []), `${qv} = wmd_query( '${part.postType}', ${coll.count} );`]);
      }
    } else if (part.binding === 'repeater') {
      const name = ctx.listName(part);
      if (name) whenList(section, `wmd_has( get_field( '${name}' ) )`);
      else when(section, null);
    }
    // A carousel's first slide is the active one: the first row gets the class.
    const isActive = (e: El) => /(^|\s)active(\s|$)/.test(e.attribs.class ?? '');
    const firstActive = items.length > 1 && isActive(items[0]!) && !items.slice(1).some(isActive);
    const firstCond = search ? "0 === $GLOBALS['wp_query']->current_post" : part.binding === 'query' ? `0 === ${qv}->current_post` : '1 === get_row_index()';
    for (const v of bindings) {
      const el = resolve(item, v.path);
      const src = ctx.sourceOf(v.field, inList);
      if (!el || !src) {
        warnings.push(`${where}: ${v.field} at "${v.path}" not bound`);
        continue;
      }
      values.push(() => {
        if (!bindValue($, php, el, src)) warnings.push(`${where}: ${v.field} at "${v.path}" not bound`);
      });
    }
    values.push(() => {
      clearSelected($, item);
      if (firstActive) $(item as never).attr('class', `${$(item as never).attr('class') ?? ''}${php.echo(`${firstCond} ? ' active' : ''`)}`);
    });
    if (search) {
      loops.push(() => loop($, php, items, '<?php if ( have_posts() ) : while ( have_posts() ) : the_post(); ?>', '<?php endwhile; endif; ?>'));
    } else if (part.binding === 'query') {
      loops.push(() => loop($, php, items, `<?php ${wrapped.has(section) ? '' : `${qv} = wmd_query( '${part.postType}', ${coll.count}${main ? ', true' : ''} ); `}while ( ${qv}->have_posts() ) : ${qv}->the_post(); ?>`, '<?php endwhile; wp_reset_postdata(); ?>'));
    } else {
      const name = ctx.listName(part);
      if (!name) {
        warnings.push(`${where}: no list field`);
        continue;
      }
      loops.push(() => loop($, php, items, `<?php if ( have_rows( '${name}' ) ) : while ( have_rows( '${name}' ) ) : the_row(); ?>`, '<?php endwhile; endif; ?>'));
    }
  }
  // A section that holds other sections, or is the whole page, always shows (they decide for themselves).
  if (mode === 'template') {
    const inside = (outer: El, inner: El) => {
      for (let p = inner.parent as El | null; p; p = p.parent as El | null) if (p === outer) return true;
      return false;
    };
    const all = [...shows.keys()];
    for (const [section, conds] of shows) {
      if (section === root || conds.includes(null) || !conds.length || all.some((o) => o !== section && inside(section, o))) continue;
      wrapped.add(section);
    }
  }
  values.forEach((j) => j());
  loops.forEach((j) => j());
  later.forEach((j) => j());
  for (const section of wrapped) {
    const conds = [...new Set(lists.get(section) ?? (shows.get(section) as string[]))];
    $(section as never)
      .before(php.token(`<?php ${(queries.get(section) ?? []).join(' ')}${queries.has(section) ? ' ' : ''}if ( ${conds.join(' || ')} ) : ?>`))
      .after(php.token('<?php endif; ?>'));
  }
  if (blockSections.length) {
    // Blocks render inside the_content(); a page without a content section gets it where the first block was.
    if (!hasContent) $(blockSections[0] as never).replaceWith(php.token('<?php the_content(); ?>'));
    for (const s of blockSections.slice(hasContent ? 0 : 1)) $(s as never).remove();
  }
}

/** When a value has something to show (null: always, like a title or a date). */
function showsWhen(field: string, src: Source): string | null {
  if (src.kind === 'acf') return `wmd_has( ${getter(src)} )`;
  if (field === 'core:content') return "'' !== trim( wp_strip_all_tags( get_the_content() ) )";
  if (field === 'core:featured_image') return 'has_post_thumbnail()';
  if (field === 'core:excerpt') return 'has_excerpt()';
  return null;
}

/** Search results: title, link, image, date and excerpt read from the result's markup. */
function searchValues(coll: Collection): { field: string; path: string }[] {
  const out: { field: string; path: string }[] = [];
  // The title: a heading, or a link inside a heading ("<h3><a>Result</a></h3>").
  const heading = coll.leaves.find((l) => l.kind === 'heading') ?? coll.leaves.find((l) => l.kind === 'link' && /(^|> )h[1-6]\b/.test(l.path));
  if (heading) out.push({ field: 'core:title', path: heading.path });
  const link = coll.leaves.find((l) => l.kind === 'link' && (!heading || l.path.startsWith(heading.path) || heading.path.startsWith(l.path))) ?? coll.leaves.find((l) => l.kind === 'link');
  if (link) out.push({ field: 'core:permalink', path: link.path });
  const img = coll.leaves.find((l) => l.kind === 'image');
  if (img) out.push({ field: 'core:featured_image', path: img.path });
  const term = coll.leaves.find((l) => l.kind === 'text' && /categor|type|tag/i.test(l.label));
  if (term) out.push({ field: 'core:term', path: term.path });
  const date = coll.leaves.find((l) => l.kind === 'date');
  if (date) out.push({ field: 'core:date', path: date.path });
  const text = coll.leaves.filter((l) => (l.kind === 'text' || l.kind === 'richtext') && l !== heading && l !== term).sort((a, b) => b.sample.length - a.sample.length)[0];
  if (text) out.push({ field: 'core:excerpt', path: text.path });
  return out;
}

interface Ctx {
  sourceOf: (key: string, inList: boolean) => Source | null;
  collection: (page: string, part: PlanPart) => Collection | undefined;
  listName: (part: PlanPart) => string | null;
}
