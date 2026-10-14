import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { jobPath, readJson, readJsonl, writeJson, type JobInfo, type NavLink, type SiteAnalysis, type SnapshotPage } from '@wm/core';

/**
 * Reads the site's shared structure from the homepage: menus, contact details, footer notices and
 * the homepage slides. Writes analyze/site.json. Values are verbatim; URLs are made absolute.
 */
export async function analyzeSite(jobId: string, log: (msg: string) => void = () => {}): Promise<SiteAnalysis> {
  const job = await readJson<JobInfo>(jobPath(jobId, 'job.json'));
  const snapshot = await readJsonl<SnapshotPage>(jobPath(jobId, 'snapshot', 'pages.jsonl'));
  const home = snapshot.find((p) => p.status === 200 && p.html && new URL(p.url).pathname === '/' && !new URL(p.url).search);
  if (!home?.html) throw new Error('The snapshot has no homepage');
  const html = await readFile(jobPath(jobId, home.html), 'utf8');
  const titles = await Promise.all(
    snapshot.filter((p) => p.status === 200 && p.html).slice(0, 50).map(async (p) => (await readFile(jobPath(jobId, p.html!), 'utf8')).match(/<title>([^<]*)<\/title>/i)?.[1] ?? ''),
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
  const link = (a: cheerio.Cheerio<any>): NavLink | null => {
    const href = a.attr('href');
    const label = clean(a.text()) || clean(a.attr('aria-label') ?? '') || clean(a.attr('title') ?? '');
    return href && label && !/^(javascript|tel|mailto):/i.test(href) ? { label, href: abs(href, origin) } : null;
  };
  const links = (selector: string) => $(selector).toArray().map((a) => link($(a))).filter((l): l is NavLink => !!l);

  const main = $('#bottomNav ul.mainMenu > li')
    .toArray()
    .map((li) => {
      const item = link($(li).children('a').first());
      if (!item) return null;
      const children = $(li).find('> ul > li > a').toArray().map((a) => link($(a))).filter((l): l is NavLink => !!l);
      return children.length ? { ...item, children } : item;
    })
    .filter((l): l is NavLink => !!l);

  const footerBottom = $('#footerBottom #copycred');
  // Footer links, minus the map link (it's the address) and the copyright year.
  const footer = footerBottom
    .find('a')
    .toArray()
    .map((a) => link($(a)))
    .filter((l): l is NavLink => !!l && !/maps\.(app\.)?goo|google\.[a-z]+\/maps/.test(l.href) && !/^\d{4}$/.test(l.label));
  const address = clean(footerBottom.find('a[href*="maps"]').first().text()) || null;
  const phone = clean($('#footerPhone a[href^="tel:"]').first().text()) || null;
  $('#footerInfo br').replaceWith(' ');
  const hours = clean($('#footerInfo').text()) || null;
  const notices = $('#footerMiddle .condensedFont').toArray().map((el) => clean($(el).text())).filter(Boolean);

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
        image: src ? abs(src, origin).replace(/([?&])(size|type)=[^&]*&?/g, '$1').replace(/[?&]$/, '') : null,
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
    home: { slides, buttons: links('#buttonRow a') },
  };
}

/** Unknown platforms: first <nav> list, footer links, no slides. */
function genericSite(html: string, origin: string): SiteAnalysis {
  const $ = cheerio.load(html);
  const toLink = (a: cheerio.Cheerio<any>) => {
    const href = a.attr('href');
    const label = clean(a.text());
    return href && label ? { label, href: abs(href, origin) } : null;
  };
  const main = $('nav').first().find('> ul > li, ul:first > li').toArray().map((li) => toLink($(li).children('a').first())).filter((l): l is NavLink => !!l);
  const footer = $('footer a').toArray().map((a) => toLink($(a))).filter((l): l is NavLink => !!l);
  return {
    siteName: null,
    menus: { top: [], main, footer: dedupe(footer), social: footer.filter((l) => /facebook|youtube|instagram|twitter|x\.com|linkedin/.test(l.href)), explore: [] },
    contact: { address: null, phone: null, email: null, fax: null, hours: null },
    footerNotices: [],
    home: { slides: [], buttons: [] },
  };
}

/** The title segment most pages share (titles look like "Page - Site Name - Place"). */
function siteName(titles: string[]): string | null {
  const counts = new Map<string, number>();
  for (const t of titles) for (const part of new Set(t.split(/\s[-|–]\s/).map(clean).filter(Boolean))) counts.set(part, (counts.get(part) ?? 0) + 1);
  const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  return best && best[1] >= titles.length / 2 ? best[0] : null;
}

function dedupe(items: NavLink[]): NavLink[] {
  return items.filter((item, i) => items.findIndex((o) => o.href === item.href && o.label === item.label) === i);
}

function abs(href: string, origin: string): string {
  try {
    return new URL(href, `${origin}/`).href;
  } catch {
    return href;
  }
}

function clean(s: string): string {
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}
