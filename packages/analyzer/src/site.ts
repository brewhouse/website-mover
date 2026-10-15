import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { jobPath, readJson, readJsonl, writeJson, type JobInfo, type NavLink, type SiteAnalysis, type SnapshotPage } from '@wm/core';
import { cleanText as clean } from './records/text.js';

/**
 * Reads the site's shared structure from the homepage: menus, contact details, footer notices, the
 * homepage slides and its introduction. Writes analyze/site.json. Values are verbatim; URLs are made absolute.
 */
export async function analyzeSite(jobId: string, log: (msg: string) => void = () => {}): Promise<SiteAnalysis> {
  const job = await readJson<JobInfo>(jobPath(jobId, 'job.json'));
  const snapshot = await readJsonl<SnapshotPage>(jobPath(jobId, 'snapshot', 'pages.jsonl'));
  const home = snapshot.find((p) => p.status === 200 && p.html && new URL(p.url).pathname === '/' && !new URL(p.url).search);
  if (!home?.html) throw new Error('The snapshot has no homepage');
  const html = await readFile(jobPath(jobId, home.html), 'utf8');
  const titles = await Promise.all(
    snapshot
      .filter((p) => p.status === 200 && p.html)
      .slice(0, 50)
      // Title text as shown (entities decoded).
      .map(async (p) => cheerio.load((await readFile(jobPath(jobId, p.html!), 'utf8')).match(/<title>([^<]*)<\/title>/i)?.[1] ?? '', null, false).text()),
  );
  const site = job.profile === 'bjm' ? bjmSite(html, job.origin) : genericSite(html, job.origin);
  site.siteName = siteName(titles);
  await writeJson(jobPath(jobId, 'analyze', 'site.json'), site);
  log(`Site: ${site.menus.main.length} main menu items, ${site.home.slides.length} homepage slides`);
  return site;
}

/** Brooks Jeffrey Marketing sites (jaxha.org). */
function bjmSite(html: string, origin: string): SiteAnalysis {
  const $ = cheerio.load(html);
  const link = (a: cheerio.Cheerio<any>) => navLink(a, origin);
  const links = (selector: string) => $(selector).toArray().map((a) => link($(a))).filter((l): l is NavLink => !!l?.href);

  const main = $('#bottomNav ul.mainMenu > li')
    .toArray()
    .map((li) => {
      const item = link($(li).children('a').first());
      if (!item) return null;
      const children = $(li).find('> ul > li > a').toArray().map((a) => link($(a))).filter((l): l is NavLink => !!l?.href);
      return children.length ? { ...item, children } : item.href ? item : null;
    })
    .filter((l): l is NavLink => !!l);

  const footerBottom = $('#footerBottom #copycred');
  // Footer links, minus the map link (it's the address) and the copyright year.
  const footer = footerBottom
    .find('a')
    .toArray()
    .map((a) => link($(a)))
    .filter((l): l is NavLink => !!l?.href && !/maps\.(app\.)?goo|google\.[a-z]+\/maps/.test(l.href) && !/^\d{4}$/.test(l.label));
  const address = clean(footerBottom.find('a[href*="maps"]').first().text()) || null;
  const phone = clean($('#footerPhone a[href^="tel:"]').first().text()) || null;
  $('#footerInfo br').replaceWith(' ');
  const hours = clean($('#footerInfo').text()) || null;
  const notices = $('#footerMiddle .condensedFont').toArray().map((el) => clean($(el).text())).filter(Boolean);

  // The introduction under the slideshow (mission, programs): its paragraphs as they are, and its
  // "Learn More" button as a paragraph with that link. Links are made absolute.
  const introBox = $('.homeBorder').first();
  introBox.find('a[href]').each((_, a) => {
    $(a).attr('href', abs($(a).attr('href')!, origin));
  });
  const intro = introBox
    .children('p, a.mainButtons')
    .toArray()
    .filter((el) => clean($(el).text()))
    .map((el) => (el.tagName === 'p' ? $.html(el).trim() : `<p><a href="${escapeHtml($(el).attr('href') ?? '')}">${escapeHtml(clean($(el).text()))}</a></p>`));

  const slides = $('#rotator ul.slides > li')
    .toArray()
    .map((li) => {
      const img = $(li).find('img').first();
      const title = clean($(li).attr('data-banner-title') ?? '');
      if (!title) return null;
      const href = $(li).attr('data-banner-link');
      const src = img.attr('src');
      return {
        title,
        subtitle: clean($(li).attr('data-banner-subtitle') ?? '') || null,
        link: href ? abs(href, origin) : null,
        // Slide images are served in a size variant; the file is the same id.
        image: src ? withoutParams(abs(src, origin), ['size', 'type']) : null,
        alt: clean(img.attr('alt') ?? ''),
      };
    })
    .filter((s): s is NonNullable<typeof s> => !!s);

  return {
    siteName: null,
    menus: {
      top: links('#topNav > ul > li > a'),
      main,
      footer: dedupe(footer),
      social: links('#sideBar a[href*="facebook"], #sideBar a[href*="youtube"], #sideBar a[href*="instagram"], #sideBar a[href*="twitter"], #sideBar a[href*="x.com"], #sideBar a[href*="linkedin"]'),
      explore: links('#industryLinks > ul:first-of-type a'),
    },
    contact: { address, phone, email: null, fax: null, hours },
    footerNotices: notices,
    home: { slides, buttons: links('#buttonRow a'), intro: intro.length ? intro.join('\n') : null },
  };
}

/** Unknown platforms: first <nav> list, footer links, no slides. */
function genericSite(html: string, origin: string): SiteAnalysis {
  const $ = cheerio.load(html);
  const toLink = (a: cheerio.Cheerio<any>) => navLink(a, origin);
  const main = $('nav').first().find('> ul > li, ul:first > li').toArray().map((li) => toLink($(li).children('a').first())).filter((l): l is NavLink => !!l?.href);
  const footer = $('footer a').toArray().map((a) => toLink($(a))).filter((l): l is NavLink => !!l?.href);
  return {
    siteName: null,
    menus: { top: [], main, footer: dedupe(footer), social: footer.filter((l) => /facebook|youtube|instagram|twitter|x\.com|linkedin/.test(l.href)), explore: [] },
    contact: { address: null, phone: null, email: null, fax: null, hours: null },
    footerNotices: [],
    home: { slides: [], buttons: [], intro: null },
  };
}

/**
 * The title segment most pages share. Titles look like "Page - Site Name - Place", so when the site
 * name and the place are on every page, the one further from the end wins.
 */
function siteName(titles: string[]): string | null {
  const seen = new Map<string, { count: number; fromEnd: number }>();
  for (const t of titles) {
    const parts = t.split(/\s[-|–]\s/).map(clean).filter(Boolean);
    for (const [i, part] of [...new Set(parts)].entries()) {
      const s = seen.get(part) ?? { count: 0, fromEnd: 0 };
      seen.set(part, { count: s.count + 1, fromEnd: s.fromEnd + (parts.length - 1 - i) });
    }
  }
  const [best] = [...seen].sort(([, a], [, b]) => b.count - a.count || b.fromEnd / b.count - a.fromEnd / a.count);
  return best && best[1].count >= titles.length / 2 ? best[0] : null;
}

/**
 * A link as a menu item. '#' and script links get an empty href: they only open a dropdown.
 * Phone and email links aren't menu items.
 */
function navLink(a: cheerio.Cheerio<any>, origin: string): NavLink | null {
  const href = (a.attr('href') ?? '').trim();
  const label = clean(a.text()) || clean(a.attr('aria-label') ?? '') || clean(a.attr('title') ?? '');
  if (!label || /^(tel|mailto):/i.test(href)) return null;
  return { label, href: !href || href.startsWith('#') || /^javascript:/i.test(href) ? '' : abs(href, origin) };
}

function withoutParams(url: string, names: string[]): string {
  try {
    const u = new URL(url);
    for (const n of names) u.searchParams.delete(n);
    return u.href;
  } catch {
    return url;
  }
}

function dedupe(items: NavLink[]): NavLink[] {
  return items.filter((item, i) => items.findIndex((o) => o.href === item.href && o.label === item.label) === i);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function abs(href: string, origin: string): string {
  try {
    return new URL(href, `${origin}/`).href;
  } catch {
    return href;
  }
}

