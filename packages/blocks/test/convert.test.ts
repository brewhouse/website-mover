import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  acfBlock,
  buttons,
  columns,
  cover,
  group,
  htmlToBlocks,
  loadWordPress,
  restrictBlocks,
  serializeBlocks,
  validateSerialized,
  type Block,
} from '../src/index.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, fixtures), 'utf8');

/** Depth-first list of every block in the tree. */
const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => [b, ...flat(b.innerBlocks)]);
const names = (blocks: Block[]) => blocks.map((b) => b.name);
const attr = (b: Block, key: string) => String(b.attributes[key] ?? '');

/**
 * Serialize, then do what the editor does on load (parse + validate), and
 * return the parsed blocks so assertions run on what WordPress will see.
 */
function throughEditor(blocks: Block[]) {
  const markup = serializeBlocks(blocks);
  const report = validateSerialized(markup);
  expect(report.errors).toEqual([]);
  expect(report.roundTrip).toBe(true);
  expect(report.names).not.toContain('core/freeform');
  expect(report.names).not.toContain('core/missing');
  return { markup, report, parsed: loadWordPress().parse(markup) };
}

beforeAll(() => {
  loadWordPress(); // jsdom + block registration takes a few seconds
}, 60_000);

/** Per-fixture expectations on the parsed result; every fixture is validated regardless. */
const expectations: Record<string, (parsed: Block[], markup: string) => void> = {
  'paragraphs.html': (parsed, markup) => {
    expect(names(parsed)).toEqual(['core/paragraph', 'core/paragraph', 'core/paragraph']); // &nbsp; paragraph dropped
    expect(markup).toContain('<strong>check their waitlist status</strong>'); // <b> normalized
    expect(markup).toContain('<em>Customer Service Center</em>'); // <i> normalized
    expect(markup).toContain('<a href="/wp-content/uploads/2024/01/Annual-Plan-2024.pdf">'); // doc path kept for the link rewriter
  },
  'headings.html': (parsed) => {
    expect(parsed.map((b) => [b.name, b.attributes.level])).toEqual(
      [1, 2, 3, 4, 5, 6].map((level) => ['core/heading', level]),
    );
  },
  'lists.html': (parsed) => {
    expect(names(parsed)).toEqual(['core/list', 'core/list']);
    expect(parsed[1].attributes).toMatchObject({ ordered: true, start: 3 });
    // nested lists live inside list items
    const nested = flat(parsed).filter((b) => b.name === 'core/list-item' && b.innerBlocks[0]?.name === 'core/list');
    expect(nested).toHaveLength(2);
  },
  'table.html': (parsed) => {
    expect(names(parsed)).toEqual(['core/table', 'core/table']);
    const [classic, gutenberg] = parsed;
    const { head, body } = classic.attributes as { head: { cells: { tag: string }[] }[]; body: unknown[] };
    expect(head).toHaveLength(1);
    expect(head[0].cells.map((c) => c.tag)).toEqual(['th', 'th', 'th']);
    expect(body).toHaveLength(3);
    // rawHandler drops <caption> and turns figure.wp-block-table into core/html
    expect(attr(classic, 'caption')).toBe('2024 income limits, Jacksonville MSA');
    expect(attr(gutenberg, 'caption')).toBe('Call <strong>8 a.m.–5 p.m.</strong>');
  },
  'images.html': (parsed) => {
    expect(names(parsed)).toEqual(['core/image', 'core/image', 'core/image', 'core/image']);
    const [plain, captioned, lazy, linked] = parsed;
    expect(attr(plain, 'url')).toBe('https://www.jaxha.org/wp-content/uploads/2023/05/brentwood-park.jpg');
    expect(attr(captioned, 'caption')).toContain('Ribbon cutting at Lindsey Terrace');
    expect(captioned.attributes).toMatchObject({ align: 'center' });
    // source attachment IDs (wp-image-4512) must not leak into the target
    expect(parsed.every((b) => b.attributes.id === undefined)).toBe(true);
    expect(attr(lazy, 'url')).toBe('https://www.jaxha.org/wp-content/uploads/2024/02/board-2024.jpg');
    expect(attr(linked, 'href')).toBe('https://www.jaxha.org/wp-content/uploads/2023/09/site-map-large.png');
  },
  'blockquote.html': (parsed) => {
    expect(names(flat(parsed))).toEqual(['core/quote', 'core/paragraph']);
    expect(attr(parsed[0], 'citation')).toBe('Dwayne Alexander, President &amp; CEO');
  },
  'code.html': (parsed) => {
    expect(names(parsed)).toEqual(['core/code', 'core/preformatted']);
    expect(attr(parsed[0], 'content')).toContain('&lt;iframe src=');
  },
  'separator.html': (parsed) => {
    expect(names(parsed)).toEqual(['core/paragraph', 'core/separator', 'core/paragraph']);
  },
  'embeds.html': (parsed) => {
    const embeds = parsed.filter((b) => b.name === 'core/embed');
    expect(embeds.map((b) => [b.attributes.providerNameSlug, b.attributes.url])).toEqual([
      ['youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
      ['vimeo', 'https://vimeo.com/76979871'],
      ['youtube', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'], // from a youtube-nocookie iframe
      ['vimeo', 'https://vimeo.com/22439234'], // from a wrapped player.vimeo.com iframe
    ]);
    expect(embeds.every((b) => b.attributes.type === 'video' && b.attributes.responsive === true)).toBe(true);
  },
  'layout-wrappers.html': (parsed, markup) => {
    // page-builder wrappers are unwrapped instead of becoming one core/html block,
    // and sibling text <div>s stay separate paragraphs
    expect(names(parsed)).toEqual(['core/heading', 'core/paragraph', 'core/paragraph', 'core/paragraph', 'core/paragraph']);
    expect(markup).not.toMatch(/<script|onclick|javascript:|style=|et_pb|fa-comments/);
  },
  'sample-post.html': (parsed) => {
    expect(names(flat(parsed))).toEqual(
      expect.arrayContaining(['core/heading', 'core/list', 'core/image', 'core/table', 'core/quote', 'core/embed', 'core/separator', 'core/preformatted']),
    );
  },
};

describe('htmlToBlocks', () => {
  const files = readdirSync(fixtures).filter((f) => f.endsWith('.html'));

  it.each(files)('%s → valid blocks with no fallbacks', (file) => {
    const warnings: string[] = [];
    const { markup, report, parsed } = throughEditor(htmlToBlocks(read(file), { onWarning: (w) => warnings.push(w) }));
    expect(report.warnings).toEqual([]); // no core/html fallback in any fixture
    expect(warnings).toEqual([]);
    expect(expectations[file], `add expectations for ${file}`).toBeDefined();
    expectations[file](parsed, markup);
  });

  it('demotes content H1s when asked', () => {
    const { parsed } = throughEditor(htmlToBlocks(read('headings.html'), { demoteH1: true }));
    expect(parsed.map((b) => b.attributes.level)).toEqual([2, 2, 3, 4, 5, 6]);
  });

  it('keeps allowlisted iframes as core/html and drops the rest', () => {
    const warnings: string[] = [];
    const html =
      '<p><iframe src="https://www.google.com/maps/embed?pb=!1m18"></iframe></p><iframe src="https://tracker.example.com/pixel"></iframe>';
    const { report } = throughEditor(htmlToBlocks(html, { onWarning: (w) => warnings.push(w) }));
    expect(report.names).toEqual(['core/html']);
    expect(report.warnings.map((w) => w.kind)).toEqual(['html']);
    expect(warnings).toEqual(['dropped iframe https://tracker.example.com/pixel']);
  });
});

describe('acfBlock', () => {
  it('serializes an ACF block as a self-closing comment with its field data', () => {
    const block = acfBlock('acf/angled-clickable-image', {
      section_heading: 'Clickable Images',
      _section_heading: 'field_wm_ci_section_heading',
      angled_clickable_images: 1,
      angled_clickable_images_0_link: { title: 'Image Title', url: '#', target: '' },
    });
    const html = serializeBlocks([block]);
    expect(html).toMatch(/^<!-- wp:acf\/angled-clickable-image \{"name":"acf\/angled-clickable-image","data":\{/);
    expect(html.endsWith('"mode":"preview"} /-->')).toBe(true);
    const parsed = loadWordPress().parse(html)[0]!;
    expect(parsed.attributes.data).toEqual(block.attributes.data);
  });
});

describe('structured builders', () => {
  it('columns (2 and 3), cover, group and buttons serialize to valid blocks', () => {
    const tree = [
      cover({
        url: 'https://s.w.org/images/core/5.3/Windbuchencom.jpg',
        alt: 'Families outside a JHA community',
        innerBlocks: htmlToBlocks('<h2>Find a Home with JHA</h2><p>Affordable housing across Duval County.</p>'),
      }),
      columns([
        htmlToBlocks('<h3>Public Housing</h3><p>2,600 apartments.</p><img src="https://s.w.org/images/core/5.3/MtBlanc1.jpg" alt="">'),
        htmlToBlocks('<h3>Vouchers</h3><ul><li>Portability</li><li>Homeownership</li></ul>'),
      ]),
      group([
        columns([
          htmlToBlocks('<h4>Call</h4><p>(904) 630-3810</p>'),
          htmlToBlocks('<p>https://www.youtube.com/watch?v=dQw4w9WgXcQ</p>'),
          htmlToBlocks('<table><tbody><tr><td>Mon–Fri</td><td>8–5</td></tr></tbody></table>'),
        ]),
        buttons([{ text: 'Apply now', url: '/apply/' }]),
      ]),
    ];
    const { parsed } = throughEditor(tree);

    const [hero, two, section] = parsed;
    expect(hero.name).toBe('core/cover');
    expect(hero.attributes).toMatchObject({ url: 'https://s.w.org/images/core/5.3/Windbuchencom.jpg', dimRatio: 50 });
    expect(names(hero.innerBlocks)).toEqual(['core/heading', 'core/paragraph']);

    expect(two.innerBlocks.map((c) => [c.name, ...names(c.innerBlocks)])).toEqual([
      ['core/column', 'core/heading', 'core/paragraph', 'core/image'],
      ['core/column', 'core/heading', 'core/list'],
    ]);

    expect(names(section.innerBlocks)).toEqual(['core/columns', 'core/buttons']);
    expect(section.innerBlocks[0].innerBlocks.map((c) => names(c.innerBlocks))).toEqual([
      ['core/heading', 'core/paragraph'],
      ['core/embed'],
      ['core/table'],
    ]);
    expect(attr(section.innerBlocks[1].innerBlocks[0], 'url')).toBe('/apply/');
  });
});

describe('validateSerialized', () => {
  it('flags markup the editor would reject, migrate or fall back on', () => {
    const report = validateSerialized(
      [
        '<!-- wp:heading {"level":3} -->\n<h2 class="wp-block-heading">Wrong level</h2>\n<!-- /wp:heading -->',
        '<p>Loose classic HTML</p>',
        '<!-- wp:acme/widget /-->',
        '<!-- wp:quote -->\n<blockquote class="wp-block-quote"><p>Pre-6.2 quote</p></blockquote>\n<!-- /wp:quote -->',
        '<!-- wp:paragraph -->\n<p class="legacy">Fixed up on load</p>\n<!-- /wp:paragraph -->',
        '<!-- wp:html -->\n<div>raw</div>\n<!-- /wp:html -->',
      ].join('\n\n'),
    );
    expect(report.ok).toBe(false);
    expect(report.roundTrip).toBe(false);
    expect(report.errors.map((e) => [e.kind, e.name, e.path])).toEqual([
      ['invalid', 'core/heading', '0'],
      ['freeform', 'core/freeform', '1'],
      ['missing', 'core/missing', '2'],
      ['deprecated', 'core/quote', '3'],
      ['drift', 'core/paragraph', '4'],
    ]);
    expect(report.errors[0].messages.join('\n')).toContain('<h3 class="wp-block-heading">Wrong level</h3>');
    expect(report.warnings.map((w) => [w.kind, w.path])).toEqual([['html', '5']]);
  });
});

describe('restrictBlocks', () => {
  it('rebuilds blocks the target disables from allowed ones, keeping their content', () => {
    const tree = [
      cover({ url: 'https://example.com/hero.jpg', alt: 'Families', innerBlocks: htmlToBlocks('<h2>Find a Home</h2>') }),
      buttons([{ text: 'Apply now', url: 'https://example.com/apply?a=1&b=2' }]),
      ...htmlToBlocks(
        '<hr><pre>line 1\nline 2</pre><pre><code>x = 1</code></pre>' +
          '<p>https://www.youtube.com/watch?v=dQw4w9WgXcQ</p>' +
          '<table><tbody><tr><td>Studio</td><td>$900</td></tr></tbody></table>',
      ),
    ];
    // The seed switches off core/button but not core/buttons; core/table has no
    // dedicated fallback, so it exercises the core/html path.
    const disabled = ['core/cover', 'core/button', 'core/separator', 'core/preformatted', 'core/code', 'core/embed', 'core/table'];
    const warnings: string[] = [];

    const { markup, report } = throughEditor(restrictBlocks(tree, disabled, (w) => warnings.push(w)));

    for (const name of [...disabled, 'core/buttons']) expect(report.names).not.toContain(name);
    for (const kept of ['https://example.com/hero.jpg', 'Find a Home', 'href="https://example.com/apply?a=1&amp;b=2"', 'Apply now', 'line 1<br>line 2', '<code>x = 1</code>', 'dQw4w9WgXcQ', 'Studio']) {
      expect(markup).toContain(kept);
    }
    for (const name of disabled.filter((n) => n !== 'core/button')) {
      expect(warnings.some((w) => w.startsWith(name))).toBe(true);
    }
  });
});
