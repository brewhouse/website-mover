import * as cheerio from 'cheerio';
import type { DocumentRole } from '@wm/core';

const BLOCKS = 'p,div,li,h1,h2,h3,h4,h5,h6,tr,td,th,ul,ol,table,section,blockquote,dt,dd';

/** Readable text of content HTML on one line, whitespace collapsed (verbatim values are cut from it). */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html, null, false);
  $('script,style').remove();
  $('br').replaceWith(' ');
  $(BLOCKS).each((_, el) => {
    $(el).prepend(' ');
    $(el).append(' ');
  });
  return collapse($.root().text());
}

export function collapse(s: string): string {
  return s.replace(/[\s ​]+/g, ' ').trim();
}

/** The printable-version line that heads the 2020–2021 pages ("For a printable version of …, click here."). */
const PRINTABLE = /^for a printable version of .*?click here\.?\s*/i;

/**
 * Where a notice names its meeting: the opening lines up to and a little past "Notice is hereby
 * given …". Later paragraphs (accommodation requests, comment deadlines) mention other times,
 * places and words like "special".
 */
export function noticeHeading(text: string): string {
  const body = text.replace(PRINTABLE, '');
  const given = body.search(/notice is hereby given/i);
  if (given >= 0 && given < 600) return body.slice(0, given + 260);
  return body.slice(0, 300);
}

/**
 * The notice's own title lines (before "Notice is hereby given"), e.g. "PUBLIC NOTICE JACKSONVILLE
 * HOUSING AUTHORITY BOARD OF COMMISSIONERS SPECIAL MEETING VIA RINGCENTRAL"; for pages that aren't
 * notices (agendas, minutes), their first line or so.
 */
export function noticeBlock(text: string): string {
  const body = text.replace(PRINTABLE, '');
  const given = body.search(/notice is hereby given/i);
  return given >= 0 ? body.slice(0, Math.min(given, 400)) : body.slice(0, 150);
}

// ---------------------------------------------------------------- cancellation

export function cancelledIn(s: string): boolean {
  return /\bcancel+ed\b/i.test(s);
}

export function rescheduledIn(s: string): boolean {
  return /\brescheduled\b/i.test(s);
}

// ---------------------------------------------------------------- location

const STREET = '(?:Street|STREET|St\\b\\.?|Avenue|AVENUE|Ave\\b\\.?|Road|Rd\\b\\.?|Boulevard|Blvd\\b\\.?|Drive|Dr\\.|Lane|Way|Parkway|Place|Court)';
const UNIT = '(?:,?\\s*(?:Building|Bldg\\.?|Suite|Ste\\.?|Room|Unit)\\s+[\\w-]+)?';
const ADDRESS = new RegExp(
  `\\b\\d{2,5}\\s+(?:(?:N|S|E|W|North|South|East|West|NORTH|SOUTH)\\.?\\s+)?(?:[A-Z0-9][\\w'’-]*\\s+){0,3}${STREET}${UNIT}` +
    `(?:,?\\s*[A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)*,\\s*(?:Florida|FLORIDA|FL|Fl)\\b\\.?)?(?:,?\\s*\\d{5}(?:-\\d{4})?)?`,
  'g',
);
/** A venue named just before the address: "at the Waves Apartments Community Room, 123 S 8th Street", "at Hogan Creek Towers 1320 …". */
const VENUE_BEFORE = /\bat\s+((?:the\s+)?[A-Z][^,.;:()\d]{2,60}?),?\s*$/;
const VIRTUAL = /\b(?:via|using)\s+(?:the\s+)?(?:Microsoft\s+Teams|Teams|RingCentral|Ring\s+Central|Zoom|WebEx)(?:\s+(?:teleconference|videoconference|video\s+conference|technology|meeting|computer application))?/i;

export interface Location {
  value: string;
  rule: string;
}

/**
 * Verbatim place the notice gives: the first street address (with the venue named before it,
 * where that same address is introduced as "at <Venue>, <address>"), else the virtual platform.
 * Later addresses belong to other things (a meeting that follows, where to send requests).
 */
export function findLocation(text: string): Location | null {
  const virtual = text.match(VIRTUAL);
  if (virtual && /no physical location/i.test(text)) return { value: virtual[0], rule: 'location-virtual (no physical location)' };
  const addresses = [...text.matchAll(ADDRESS)];
  const first = addresses[0];
  if (!first) return virtual ? { value: virtual[0], rule: 'location-virtual' } : null;
  const number = first[0].match(/^\d+/)![0];
  for (const m of addresses.filter((a) => a[0].startsWith(`${number} `))) {
    const before = text.slice(Math.max(0, m.index - 70), m.index);
    const venue = before.match(VENUE_BEFORE);
    if (venue && !/\b(?:located|offices?)\b/i.test(venue[1]!)) {
      const from = before.length - venue[0].length + venue[0].indexOf(venue[1]!);
      return { value: tidy(before.slice(from) + m[0]), rule: 'location-venue-address' };
    }
  }
  return { value: tidy(first[0]), rule: 'location-address' };
}

const tidy = (address: string) => address.replace(/[.,\s]+$/, '');

// ---------------------------------------------------------------- documents

export type Artefact = 'notice' | 'agenda' | 'minutes' | 'comment' | 'other';

/** What a source page itself is, from its title and opening text. */
export function pageArtefact(title: string, heading: string): Artefact {
  if (/minutes/i.test(title)) return 'minutes';
  if (/agenda/i.test(title)) return 'agenda';
  if (/comment/i.test(title)) return 'comment';
  if (/notice/i.test(title) || /public notice|notice is hereby given/i.test(heading)) return 'notice';
  return 'other';
}

function roleFrom(s: string): DocumentRole | null {
  if (/packet|board\s*book/i.test(s)) return 'packet';
  if (/minutes|transcript/i.test(s)) return 'minutes';
  if (/agenda/i.test(s)) return 'agenda';
  if (/presentation|powerpoint|slides|\.pptx?\b/i.test(s)) return 'presentation';
  if (/resolution|\b\d{4}-JHA-\d+\b/i.test(s)) return 'resolution';
  if (/notice/i.test(s)) return 'notice';
  return null;
}

/**
 * Role of a linked file: from the link text, then the filename, then where it is linked
 * (the 2020–2021 "printable version" link is the page itself; a "Meeting Minutes" list holds minutes).
 */
export function documentRole(text: string, filename: string | null, context: { printableOf?: Artefact; listOf?: DocumentRole }): DocumentRole {
  const fromText = roleFrom(text) ?? (filename ? roleFrom(filename) : null);
  if (fromText) return fromText;
  if (context.printableOf && /printable version/i.test(text)) {
    const a = context.printableOf;
    return a === 'notice' || a === 'agenda' || a === 'minutes' ? a : 'other';
  }
  return context.listOf ?? 'other';
}

// ---------------------------------------------------------------- recordings

/** Canonical watch URL for a YouTube embed or link; other video hosts as given; null when not a recording. */
export function recordingUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0] || null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = u.pathname.match(/^\/(?:embed|live|shorts|v)\/([\w-]+)/)?.[1] ?? null;
  }
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return href;
  return null;
}
