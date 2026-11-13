/**
 * Mockup markup → PHP. The mockup's HTML is kept as it is; the values the plan binds are replaced
 * with PHP that prints them, lists become loops, and links, images and forms are pointed at
 * WordPress. PHP goes in as placeholder tokens (cheerio would escape it) and is swapped in when the
 * markup is serialized.
 */
import * as cheerio from 'cheerio';
import { elementChildren, selector, type El } from '../model.js';
import type { FieldType } from '../plan-schema.js';

/** PHP snippets behind placeholder tokens. */
export class Php {
  private code: string[] = [];
  token(php: string): string {
    this.code.push(php);
    return `WMPHP${this.code.length - 1}X`;
  }
  echo(expr: string): string {
    return this.token(`<?php echo ${expr}; ?>`);
  }
  /** Serialized markup with the PHP in place (an attribute named "wmdattr" holds a whole attribute). */
  render(html: string): string {
    return html.replace(/\s?wmdattr="(WMPHP\d+X)"/g, '$1').replace(/WMPHP(\d+)X/g, (_, i: string) => this.code[Number(i)]!);
  }
}

/** The element at a model path ("div.a > ul > li[2]") under root. */
export function resolve(root: El, path: string): El | null {
  if (!path) return root;
  let el: El = root;
  for (const raw of path.split(' > ')) {
    const m = /^(.*?)(?:\[(\d+)\])?$/.exec(raw.trim())!;
    const sel = m[1]!;
    const idx = m[2] ? Number(m[2]) : 0;
    let kids = elementChildren(el).filter((k) => selector(k) === sel);
    // "img" inside a link is written by tag alone.
    if (!kids.length) kids = elementChildren(el).filter((k) => k.name === sel.split('.')[0]);
    const next = kids[idx];
    if (!next) return null;
    el = next;
  }
  return el;
}

/** Where a value comes from in PHP. */
export type Source =
  | { kind: 'acf'; name: string; type: FieldType; scope: 'field' | 'sub' }
  | { kind: 'core'; core: string };

export const getter = (s: Extract<Source, { kind: 'acf' }>) => `${s.scope === 'sub' ? 'get_sub_field' : 'get_field'}( '${s.name}' )`;

const hasElementKids = (el: El) => elementChildren(el).length > 0 || el.children.some((c) => c.type === 'tag');
const textNodes = (el: El) => el.children.filter((c): c is { type: 'text'; data: string } & El => c.type === 'text' && /\S/.test((c as unknown as { data: string }).data));

/**
 * Puts a token where the element's words are: the whole text when it has no child elements, else
 * its own words (an icon beside a label stays), else the first child that has words.
 */
export function setText($: cheerio.CheerioAPI, el: El, token: string): void {
  if (!hasElementKids(el)) {
    $(el as never).text(token);
    return;
  }
  const own = textNodes(el);
  if (own.length) {
    (own[0] as unknown as { data: string }).data = ` ${token} `;
    for (const t of own.slice(1)) (t as unknown as { data: string }).data = ' ';
    return;
  }
  const inner = elementChildren(el).find((k) => /\S/.test($(k as never).text()));
  if (inner) setText($, inner, token);
}

const firstLink = ($: cheerio.CheerioAPI, el: El): El | null => (el.name === 'a' ? el : (($(el as never).find('a').get(0) as unknown as El) ?? null));
const firstImg = ($: cheerio.CheerioAPI, el: El): El | null => (el.name === 'img' ? el : (($(el as never).find('img').get(0) as unknown as El) ?? null));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * A value worked out from the post rather than stored, recognised by the mockup's sample: part of
 * a date ("JUL", "6", "Tuesday"), an event's time span, an image count ("12 photos") or initials.
 * Returns the PHP expression, or null when the sample says nothing.
 */
export function derivedValue(sample: string, cls = ''): string | null {
  const s = sample.toLowerCase();
  const cased = (fmt: string) => (/^[A-Z]{2,}$/.test(sample) ? `strtoupper( wmd_date( '${fmt}' ) )` : `wmd_date( '${fmt}' )`);
  const word = (list: string[]) => list.some((m) => s === m || (s.startsWith(m) && /^[a-z]+\.?$/.test(s)));
  if (word(MONTHS)) return cased(s.replace('.', '').length > 3 ? 'F' : 'M');
  if (word(DAYS)) return cased(s.replace('.', '').length > 3 ? 'l' : 'D');
  if (/^\d{1,2}$/.test(sample) && Number(sample) >= 1 && Number(sample) <= 31) return /^0\d$/.test(sample) ? "wmd_date( 'd' )" : "wmd_date( 'j' )";
  if (/^\d{4}$/.test(sample)) return "wmd_date( 'Y' )";
  if (/^\d{1,2}(:\d{2})?\s*(am|pm)?\s*[-–]\s*\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(sample) || /^all\s*day$/i.test(sample)) return 'wmd_time_range()';
  if (/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(sample)) return "wmd_date( get_option( 'time_format' ) )";
  const count = /^\d+\s+([a-z]+)$/i.exec(sample);
  if (count && /^(photo|image|picture|item|file)s?$/i.test(count[1]!)) {
    const noun = count[1]!.replace(/s$/i, '');
    return `sprintf( _n( '%d ${noun}', '%d ${noun}s', wmd_image_count() ), wmd_image_count() )`;
  }
  if (/^\d+$/.test(sample) && /count/i.test(cls)) return 'wmd_image_count()';
  if (/^[A-Z]{1,3}$/.test(sample)) return 'wmd_initials( get_the_title() )';
  return null;
}

/** Binds one element to a value. Returns false when it couldn't (nothing to put it in). */
export function bindValue($: cheerio.CheerioAPI, php: Php, el: El, src: Source): boolean {
  const $el = $(el as never);
  if (src.kind === 'core') {
    switch (src.core) {
      case 'title':
        setText($, el, php.echo('esc_html( get_the_title() )'));
        return true;
      case 'permalink': {
        const a = firstLink($, el) ?? (($el.closest('a').get(0) as unknown as El) ?? null);
        if (!a) return true; // nothing links (an accordion title): nothing to do
        $(a as never).attr('href', php.echo('esc_url( get_permalink() )'));
        return true;
      }
      case 'featured_image': {
        const img = firstImg($, el);
        if (!img) return false;
        $(img as never).attr('src', php.echo("esc_url( get_the_post_thumbnail_url( null, 'large' ) )")).attr('alt', php.echo("esc_attr( get_post_meta( get_post_thumbnail_id(), '_wp_attachment_image_alt', true ) )")).removeAttr('srcset').removeAttr('sizes');
        $(img as never).before(php.token('<?php if ( has_post_thumbnail() ) : ?>')).after(php.token('<?php endif; ?>'));
        return true;
      }
      case 'excerpt':
        setText($, el, php.echo('esc_html( get_the_excerpt() )'));
        return true;
      case 'content':
        // the_content() prints paragraphs: a paragraph in the mockup gives way to it.
        if (['p', 'span'].includes(el.name)) $el.replaceWith(php.token('<?php the_content(); ?>'));
        else $el.html(php.token('<?php the_content(); ?>'));
        return true;
      case 'initials':
        setText($, el, php.echo('esc_html( wmd_initials( get_the_title() ) )'));
        return true;
      case 'date':
        setText($, el, php.echo('esc_html( wmd_date() )'));
        if (el.name === 'time') $el.attr('datetime', php.echo("esc_attr( wmd_date( 'c' ) )"));
        return true;
      case 'derived': {
        const expr = derivedValue($el.text().trim(), $el.attr('class') ?? '');
        if (!expr) return false;
        setText($, el, php.echo(`esc_html( ${expr} )`));
        return true;
      }
      case 'author':
        setText($, el, php.echo('esc_html( get_the_author() )'));
        return true;
      case 'term': {
        setText($, el, php.echo('esc_html( wmd_first_term_name() )'));
        if (el.name === 'a') $el.attr('href', php.echo('esc_url( wmd_first_term_link() )'));
        return true;
      }
      default:
        return false;
    }
  }
  const v = getter(src);
  switch (src.type) {
    case 'wysiwyg':
      $el.html(php.echo(`wp_kses_post( ${v} )`));
      guard($, php, el, `wmd_has( ${v} )`);
      return true;
    case 'image': {
      const img = firstImg($, el);
      if (!img) return false;
      $(img as never).attr('src', php.echo(`esc_url( wmd_image_url( ${v} ) )`)).attr('alt', php.echo(`esc_attr( wmd_image_alt( ${v} ) )`)).removeAttr('srcset').removeAttr('sizes');
      guard($, php, img, `wmd_has( ${v} )`);
      return true;
    }
    case 'gallery':
      return false;
    case 'link':
    case 'url':
    case 'file': {
      const a = firstLink($, el);
      const url = src.type === 'file' ? `wmd_file_url( ${v} )` : src.type === 'url' ? `wmd_text( ${v} )` : `wmd_link_url( ${v} )`;
      if (a) {
        $(a as never).attr('href', php.echo(`esc_url( ${url} )`));
        if (src.type === 'link') $(a as never).attr('wmdattr', php.echo(`wmd_link_target( ${v} )`)).removeAttr('target');
        // The link's words, unless it wraps a card (its words are other fields).
        const own = !elementChildren(a).some((k) => !['img', 'span', 'svg', 'i', 'strong', 'em'].includes(k.name));
        if (src.type === 'link' && own) setText($, a, php.echo(`esc_html( wmd_link_title( ${v} ) )`));
        if (own) guard($, php, a, `wmd_has( ${v} )`);
        return true;
      }
      setText($, el, php.echo(`esc_html( wmd_text( ${v} ) )`));
      guard($, php, el, `wmd_has( ${v} )`);
      return true;
    }
    default: {
      // A mailto: or tel: link holds the value (its label, "Office", stays beside it).
      const a = firstLink($, el);
      const scheme = /^(mailto|tel):/i.exec(a?.attribs.href ?? '')?.[1]?.toLowerCase() ?? (src.type === 'email' ? 'mailto' : null);
      const shown = scheme === 'mailto' ? `antispambot( wmd_text( ${v} ) )` : `wmd_text( ${v} )`;
      if (a && scheme) {
        setText($, a, php.echo(`esc_html( ${shown} )`));
        $(a as never).attr('href', php.echo(scheme === 'mailto' ? `esc_url( 'mailto:' . antispambot( wmd_text( ${v} ) ) )` : `esc_url( 'tel:' . wmd_tel( ${v} ) )`));
      } else setText($, el, php.echo(`esc_html( ${shown} )`));
      guard($, php, a && scheme ? a : el, `wmd_has( ${v} )`);
      return true;
    }
  }
}

/** Prints the element only when the condition holds (an empty field shows nothing, not an empty tag). */
export function guard($: cheerio.CheerioAPI, php: Php, el: El, cond: string): void {
  $(el as never).before(php.token(`<?php if ( ${cond} ) : ?>`)).after(php.token('<?php endif; ?>'));
}

/** The items of a list: the holder's children with the item's selector (or the run of siblings a section starts). */
export function listItems(section: El, holderPath: string, itemSel: string): { holder: El; items: El[] } | null {
  const holder = resolve(section, holderPath);
  if (!holder) return null;
  // A run of loose siblings (search results): the section is the first item.
  if (!holderPath && selector(section) === itemSel && section.parent) {
    const items = elementChildren(section.parent).filter((k) => selector(k) === itemSel);
    return { holder: section.parent, items: items.slice(items.indexOf(section)) };
  }
  const items = elementChildren(holder).filter((k) => selector(k) === itemSel);
  return items.length ? { holder, items } : null;
}

/** Keeps the first item as the loop's template, between the loop's opening and closing PHP. */
export function loop($: cheerio.CheerioAPI, php: Php, items: El[], open: string, close: string): El {
  const [first, ...rest] = items;
  for (const r of rest) {
    // The indentation before it goes too, so no blank lines are left.
    const prev = (r as unknown as { prev: { type: string; data?: string } | null }).prev;
    if (prev && prev.type === 'text' && !/\S/.test(prev.data ?? '')) $(prev as never).remove();
    $(r as never).remove();
  }
  $(first as never).before(php.token(open)).after(php.token(close));
  return first!;
}

/** "active", "is-active", aria-current: the mockup's selected state, which WordPress decides. */
export function clearSelected($: cheerio.CheerioAPI, el: El): void {
  $(el as never)
    .find('*')
    .addBack()
    .each((_, d) => {
      const $d = $(d);
      $d.removeAttr('aria-current');
      const cls = ($d.attr('class') ?? '').split(/\s+/).filter((c) => c && !/^(active|is-active|current|selected)$/.test(c));
      if (cls.length) $d.attr('class', cls.join(' '));
      else $d.removeAttr('class');
    });
}
