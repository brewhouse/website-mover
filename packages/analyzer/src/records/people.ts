import * as cheerio from 'cheerio';
import type { PersonRecord } from '@wm/core';
import { cleanText, slugify } from './text.js';

/** A person's name as these pages write it: 2–4 capitalised words ("Roslyn Mixon-Phillips"). */
const NAME = /^\p{Lu}[\p{L}.'’-]*(?:\s+\p{Lu}[\p{L}.'’-]*){1,3}$/u;
/** "Name - Role": a dash with a space on at least one side (so "Mixon-Phillips" isn't split). */
const DASHED = /^(.+?)(?:\s+[-–—]\s*|\s*[-–—]\s+)(.+)$/;
/** Roles that are seats on the board; anyone else listed with the board (the CEO) is staff. */
const BOARD_ROLE = /\b(chair|vice[- ]chair|chairman|chairwoman|commissioner|secretary|treasurer|board member)\b/i;

const BLOCKS = 'p, li, h2, h3, h4, h5, h6';

/**
 * People listed one per paragraph on a board or staff page, in page order:
 *
 *   [photo paragraph]  <strong><a href="mailto:…">Name</a> - Role<br></strong>Bio line
 *   <strong>Name</strong>, Role.
 *
 * A photo is the image (if any) between the previous person and this one. The email comes from
 * a mailto link in the person's paragraph; text after a line break is the bio. Names, roles and
 * bios are verbatim (whitespace collapsed, the role's trailing full stop dropped).
 */
export function parsePeople(html: string, pageKey: string, pageGroup: 'board' | 'staff'): PersonRecord[] {
  const $ = cheerio.load(html, null, false);
  const people: PersonRecord[] = [];
  let pendingPhoto: string | null = null;

  const blocks = $(BLOCKS).filter((_, el) => $(el).find(BLOCKS).length === 0);
  blocks.each((_, el) => {
    const block = $(el);
    const images = block.find('img[src]').map((_, img) => $(img).attr('src')!).get();
    const copy = block.clone();
    copy.find('br').replaceWith('\n');
    const lines = copy
      .text()
      .split('\n')
      .map(cleanText)
      .filter(Boolean);

    const mailtoLink = block.find('a[href^="mailto:" i]').first();
    const lead = cleanText(block.find('strong, b').first().text());
    const person = lines.length ? readPersonLine(lines[0]!, cleanText(mailtoLink.text()), lead) : null;
    if (!person) {
      if (images.length) pendingPhoto = images.at(-1)!;
      else if (lines.length) pendingPhoto = null; // other text between a photo and a name: not their photo
      return;
    }
    const mailto = mailtoLink.attr('href');
    const role = person.role || null;
    people.push({
      key: `person:${slugify(person.name)}`,
      pageKey,
      group: pageGroup === 'board' && role && BOARD_ROLE.test(role) ? 'board' : 'staff',
      name: person.name,
      role,
      email: mailto ? emailFrom(mailto) : null,
      phone: null,
      photo: images[0] ?? pendingPhoto,
      bio: lines.slice(1).join(' ') || null,
      order: people.length,
    });
    pendingPhoto = null;
  });
  return people;
}

/** The person on a paragraph's first line; `linked` is the mailto link's text, `bold` the first bold text. */
function readPersonLine(line: string, linked: string, bold: string): { name: string; role: string } | null {
  const dashed = line.match(DASHED);
  if (dashed) {
    const name = linked && dashed[1]!.includes(linked) && NAME.test(linked) ? linked : cleanText(dashed[1]!);
    if (NAME.test(name)) return { name, role: tidyRole(dashed[2]!) };
  }
  // "<strong>Name</strong>, Role." — the bold lead is the name.
  const lead = bold.replace(/[,\s]+$/, '');
  if (lead && NAME.test(lead) && line.startsWith(lead)) {
    const role = tidyRole(line.slice(lead.length).replace(/^[\s,:–—-]+/, ''));
    if (role) return { name: lead, role };
  }
  return null;
}

function tidyRole(text: string): string {
  return cleanText(text).replace(/\s*\.$/, '');
}

function emailFrom(href: string): string | null {
  let address = href.replace(/^mailto:/i, '').split('?')[0]!;
  try {
    address = decodeURIComponent(address);
  } catch {
    // keep as written
  }
  address = cleanText(address);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}
