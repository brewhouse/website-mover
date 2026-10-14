import * as cheerio from 'cheerio';
import type { ExtractedPage, TableRecord } from '@wm/core';
import { cleanText } from './text.js';

export interface AssembledTable {
  table: TableRecord;
  /** Inconsistencies a person should look at (column mismatches, stray values, map vs pages). */
  anomalies: string[];
}

/**
 * The payment-standards dataset: one page per ZIP code (`/zip-codes-zones?field=title&value=N`),
 * each a two-column table of bedroom size → amount, plus the map pages that link them all.
 * Becomes one table: a ZIP column, then the bedroom-size headings as written, one row per ZIP in
 * ascending order with the amounts verbatim.
 *
 * Pages whose headings differ from the rest are still included (missing cells empty, extra
 * headings appended as columns) and reported. Notes are text other than the table and the
 * per-ZIP links that every ZIP page or the map states (an effective date, a footnote).
 */
export function assembleZipTable(zipPages: ExtractedPage[], mapPages: ExtractedPage[]): AssembledTable | null {
  if (!zipPages.length) return null;
  const anomalies: string[] = [];

  type Parsed = { page: ExtractedPage; zip: string; cells: Map<string, string>; headings: string[]; extras: string[] };
  const parsed: Parsed[] = [];
  const seen = new Set<string>();
  let zipLabel: string | null = null;
  for (const page of zipPages) {
    const param = new URL(page.url).searchParams.get('value');
    const zip = /^\d{5}$/.test(page.title) ? page.title : (param ?? page.title);
    if (param && param !== zip) anomalies.push(`${page.sourceKey}: title "${page.title}" differs from the URL's ZIP ${param}`);
    if (seen.has(zip)) {
      anomalies.push(`${page.sourceKey}: second page for ZIP ${zip}; skipped`);
      continue;
    }
    seen.add(zip);

    const $ = cheerio.load(page.contentHtml, null, false);
    const tables = $('table');
    if (tables.length !== 1) anomalies.push(`ZIP ${zip}: ${tables.length} tables on the page`);
    const cells = new Map<string, string>();
    const headings: string[] = [];
    tables
      .first()
      .find('tr')
      .each((_, tr) => {
        const row = $(tr)
          .find('th, td')
          .map((_, c) => cleanText($(c).text()))
          .get();
        if (!row.length || row.every((c) => !c)) return;
        if (row.length !== 2) anomalies.push(`ZIP ${zip}: row "${row.join(' | ')}" has ${row.length} cells, expected 2`);
        const [heading, value = ''] = row;
        if (!heading) return;
        if (cells.has(heading)) anomalies.push(`ZIP ${zip}: heading "${heading}" appears twice; first kept`);
        else {
          cells.set(heading, value);
          headings.push(heading);
        }
        if (!/^\$[\d,]+(?:\.\d{2})?$/.test(value)) anomalies.push(`ZIP ${zip}: ${heading} value "${value}" is not a plain dollar amount (kept verbatim)`);
      });
    tables.remove();

    // Text left after the table: per-ZIP links ("View Demographics for Zip Code 32246") and maybe notes.
    const text = cleanText($.root().text());
    zipLabel ??= text.match(new RegExp(`\\b(zip\\s*code)\\s*:?\\s*${zip}\\b`, 'i'))?.[1] ?? null;
    const extras = $('p, div')
      .filter((_, el) => $(el).children('p, div').length === 0)
      .filter((_, el) => {
        const node = $(el);
        // Paragraphs that are only links (Back to Map, demographics, schools) aren't notes.
        return cleanText(node.text()) !== cleanText(node.find('a').text());
      })
      .map((_, el) => cleanText($(el).text()))
      .get()
      .filter(Boolean);
    parsed.push({ page, zip, cells, headings, extras });
  }
  parsed.sort((a, b) => a.zip.localeCompare(b.zip, 'en', { numeric: true }));

  // Columns: the most common heading sequence, then any extra headings in first-seen order.
  const signatures = new Map<string, { headings: string[]; zips: string[] }>();
  for (const p of parsed) {
    const sig = p.headings.join('\u0000');
    const entry = signatures.get(sig) ?? { headings: p.headings, zips: [] };
    entry.zips.push(p.zip);
    signatures.set(sig, entry);
  }
  const majority = [...signatures.values()].sort((a, b) => b.zips.length - a.zips.length)[0]!;
  const columns = [...majority.headings];
  for (const p of parsed) for (const h of p.headings) if (!columns.includes(h)) columns.push(h);
  for (const entry of signatures.values()) {
    if (entry === majority) continue;
    const missing = majority.headings.filter((h) => !entry.headings.includes(h));
    const extra = entry.headings.filter((h) => !majority.headings.includes(h));
    const what = [missing.length ? `missing ${missing.map((h) => `"${h}"`).join(', ')}` : '', extra.length ? `extra ${extra.map((h) => `"${h}"`).join(', ')}` : '']
      .filter(Boolean)
      .join('; ');
    anomalies.push(`ZIP ${entry.zips.join(', ')}: headings differ from the other ${majority.zips.length} pages (${what || 'different order'})`);
  }

  // Notes: text every ZIP page shows besides the table (ZIP number masked), and the map pages' text.
  const notes: string[] = [];
  const mask = (text: string, zip: string) => text.split(zip).join('#');
  const first = parsed[0]!;
  for (const extra of first.extras) {
    const everywhere = parsed.every((p) => p.extras.some((e) => mask(e, p.zip) === mask(extra, first.zip)));
    if (everywhere) notes.push(extra);
    else anomalies.push(`ZIP ${first.zip}: text "${extra}" isn't on every ZIP page; not used as a note`);
  }
  for (const map of mapPages) {
    const $ = cheerio.load(map.contentHtml, null, false);
    $('svg, ul, ol, h1, h2, h3, h4, h5, h6').remove();
    $('p').each((_, el) => {
      const text = cleanText($(el).text());
      if (text && text !== cleanText($(el).find('a').text()) && !notes.includes(text)) notes.push(text);
    });
  }

  // The map pages should link exactly the ZIP pages.
  const zips = new Set(parsed.map((p) => p.zip));
  for (const map of mapPages) {
    const linked = new Set(
      map.links
        .filter((l) => /\/zip-codes-zones\b/i.test(l.href))
        .map((l) => new URL(l.href).searchParams.get('value'))
        .filter((v): v is string => !!v),
    );
    const noPage = [...linked].filter((z) => !zips.has(z));
    const notOnMap = [...zips].filter((z) => !linked.has(z));
    if (noPage.length) anomalies.push(`${map.sourceKey}: links ZIPs with no page: ${noPage.join(', ')}`);
    if (notOnMap.length) anomalies.push(`${map.sourceKey}: doesn't link ZIPs ${notOnMap.join(', ')}`);
  }

  const mapTitle = mapPages.map((m) => m.title).find(Boolean);
  return {
    table: {
      key: 'payment-standards',
      // The map pages' title ("Payment Standards Map") names the dataset; the table isn't a map.
      title: mapTitle ? mapTitle.replace(/\s+map$/i, '') : 'Payment Standards',
      sourceKeys: [...parsed.map((p) => p.page.sourceKey), ...mapPages.map((m) => m.sourceKey)],
      columns: [zipLabel ?? 'ZIP Code', ...columns],
      rows: parsed.map((p) => [p.zip, ...columns.map((c) => p.cells.get(c) ?? '')]),
      notes,
    },
    anomalies,
  };
}

/** `/zip-codes-zones?field=title&value=N` */
export function isZipPage(page: ExtractedPage): boolean {
  const url = new URL(page.url);
  return url.pathname.toLowerCase() === '/zip-codes-zones' && url.searchParams.has('value');
}

/** The payment-standards map (two URLs for one page). */
export function isZipMapPage(page: ExtractedPage): boolean {
  return ['/zip-code-map', '/payment-standards-map'].includes(new URL(page.url).pathname.toLowerCase());
}

