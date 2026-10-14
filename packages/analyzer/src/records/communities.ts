import * as cheerio from 'cheerio';
import { sourceKey, type CommunityRecord, type ExtractedPage } from '@wm/core';
import { cleanText } from './text.js';

/** What the communities list view shows for one community. */
export interface ListingEntry {
  /** The type line under the title ("Office", "Multifamily", "Project Based Voucher (PBV)"). */
  type: string | null;
  photo: string | null;
  /** Position on the list (0-based). */
  order: number;
}

/**
 * The communities list view (BJM `/locations/list`): one card per community, each a link to
 * its detail page holding the title, then the type, then labelled address and phone lines.
 * Keyed by the detail page's source key.
 */
export function parseCommunityListing(html: string): Map<string, ListingEntry> {
  const $ = cheerio.load(html, null, false);
  const entries = new Map<string, ListingEntry>();
  $('a[href*="/locations/detail/"]').each((_, a) => {
    const link = $(a);
    let key: string;
    try {
      key = sourceKey(link.attr('href')!);
    } catch {
      return;
    }
    if (entries.has(key)) return;
    const firstSpan = cleanText(link.find('.location-list-item span').first().text());
    const card = link.parent();
    entries.set(key, {
      // The first line after the title is the type; a label ("Address:") means the type is missing.
      type: firstSpan && !firstSpan.endsWith(':') ? firstSpan : null,
      photo: card.find('img[src]').first().attr('src') ?? null,
      order: entries.size,
    });
  });
  return entries;
}

/**
 * Marker positions from the communities map view's inline script (raw HTML: the extractor drops
 * scripts). Each marker's info window links "detail/N" and is followed by
 * `new google.maps.LatLng(lat, lng)`. Keyed by the detail page's source key.
 */
export function parseMapCoordinates(rawHtml: string, pageUrl: string): Map<string, { lat: number; lng: number }> {
  const coords = new Map<string, { lat: number; lng: number }>();
  for (const chunk of rawHtml.split(/var\s+html\s*=/).slice(1)) {
    const href = chunk.match(/href=\\?["']([^"'\\]*detail\/\d+)\\?["']/)?.[1];
    const pos = chunk.match(/LatLng\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
    if (!href || !pos) continue;
    const key = sourceKey(new URL(href, pageUrl));
    if (!coords.has(key)) coords.set(key, { lat: Number(pos[1]), lng: Number(pos[2]) });
  }
  return coords;
}

/**
 * One community detail page (BJM `/locations/detail/N`): a photo strip, a grid of labelled
 * values (`.field` "Address:" next to `.value`), then free sections ("Additional Info:",
 * "Amenities/Resources:"). Field labels lose their trailing colon; values are the shown text.
 *
 * The body keeps everything, with the label grid rewritten as a plain list ("<strong>Address:</strong>
 * 761 …") and layout-only line breaks dropped, so it reads the same without the theme's grid CSS.
 */
export function parseCommunity(
  page: ExtractedPage,
  listing: ListingEntry | undefined,
  position: { lat: number; lng: number } | undefined,
): CommunityRecord {
  const $ = cheerio.load(page.contentHtml, null, false);
  const fields: Record<string, string> = {};
  const items: string[] = [];
  const labels = $('.field');
  labels.each((_, el) => {
    const labelEl = $(el);
    const valueEl = labelEl.next('.value');
    const label = cleanText(labelEl.text()).replace(/\s*:$/, '');
    const value = cleanText(valueEl.text());
    if (!label || !value || label in fields) return;
    fields[label] = value;
    items.push(`<li>${(labelEl.html() ?? '').trim()} ${(valueEl.html() ?? '').trim()}</li>`);
  });
  // The grid: the element holding every label's row.
  const grid = labels.first().parent().parent();
  if (labels.length && grid.length && grid.find('.field').length === labels.length) {
    grid.replaceWith(`<ul>\n${items.join('\n')}\n</ul>`);
  }
  $('br[clear]').remove();

  const photo = $('img.photo_img[src]').first().attr('src') ?? $('img[src]').first().attr('src') ?? listing?.photo ?? null;
  return {
    sourceKey: page.sourceKey,
    title: page.title,
    fields,
    type: listing?.type ?? null,
    photo,
    lat: position?.lat ?? null,
    lng: position?.lng ?? null,
    contentHtml: ($.html() ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim(),
  };
}
