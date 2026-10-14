import type { CheerioAPI } from 'cheerio';
import { isNewsCategoryListing, resolveUrl } from '@wm/crawler';
import { cleanText, stripSiteName, usDateToIso } from '../text.js';
import type { ExtractContext, ExtractProfile, KindMatch, PageParts, PageRef } from './types.js';

/**
 * Brooks Jeffrey Marketing's CMS (jaxha.org). Page shapes (docs/m0/jha-inventory.md §8):
 *
 * - content pages (`/{slug}`, `/upages.php?id=N`): `h1.ptitles` title, body in
 *   `#bodyContainer`, section nav `#lm_main_page` (parent) + `.lm_sub_page` (children);
 * - news items (`/news-view?id=N`): `#cms_body_content` > first div holds
 *   `strong.ptitles` (MM/DD/YYYY) and `h1.ptitles`; the body is `.text2`;
 * - module pages (forms, listings, communities, ZIP zones, site map, sign-up):
 *   everything in `#interior section`, titled by an `h1`/`.ptitles` heading.
 *
 * News categories only show in the filtered listings `/news?category=C&year=-1`
 * (paginated), which the scan fetches; `prepare` reads them.
 */
export function createBjmProfile(): ExtractProfile {
  /** News id → category names. */
  const newsCategories = new Map<string, Set<string>>();

  return {
    name: 'bjm',

    async prepare(pages: PageRef[]) {
      for (const page of pages.filter((p) => isNewsCategoryListing(p.url))) {
        const $ = await page.load();
        const id = page.url.searchParams.get('category')!;
        const select = $('select[name=category-selector]');
        const name = cleanText(select.find(`option[value="${id}"]`).first().text()) || cleanText(select.find('option[selected]').first().text());
        if (!name) continue;
        $('a[href*="news-view?id="]').each((_, a) => {
          const newsId = $(a).attr('href')?.match(/[?&]id=(\d+)/)?.[1];
          if (!newsId) return;
          let names = newsCategories.get(newsId);
          if (!names) newsCategories.set(newsId, (names = new Set()));
          names.add(name);
        });
      }
    },

    read(page: PageRef, $: CheerioAPI, ctx: ExtractContext): PageParts {
      const path = page.url.pathname.toLowerCase();
      const pageTitle = stripSiteName($('title').first().text(), ctx.siteName);

      if (path === '/news-view') {
        const root = $('#cms_body_content').first();
        const header = root.children('div').first();
        const id = page.url.searchParams.get('id') ?? '';
        return {
          title: cleanText(header.find('h1.ptitles').first().text()) || pageTitle,
          date: usDateToIso(header.find('strong.ptitles').first().text()),
          categories: [...(newsCategories.get(id) ?? [])].sort(),
          parentUrl: null,
          sectionTitle: null,
          contentHtml: root.find('.text2').map((_, el) => $(el).html() ?? '').get().join('\n'),
        };
      }

      const sectionLink = $('#lm_main_page').first();
      const parent = sectionLink.length ? resolveUrl(sectionLink.attr('href'), page.url) : undefined;
      const section = {
        parentUrl: parent?.href ?? null,
        sectionTitle: sectionLink.length ? cleanText(sectionLink.text()) || null : null,
      };

      const body = $('#bodyContainer').first();
      if (body.length) {
        return {
          title: cleanText($('h1.ptitles').first().text()) || cleanText($('h1').first().text()) || pageTitle,
          date: null,
          categories: [],
          ...section,
          contentHtml: body.html() ?? '',
        };
      }

      // Module pages: the whole section, minus its title and the module's own navigation.
      const root = $('#interior section').first();
      if (root.length) {
        root.find('#lm_container, .paging_div, #year-selector, #category-selector, .press-full-list').remove();
        // Community detail pages link back to the map and list views.
        root.find('a[href="../map"], a[href="../list"]').parent('.left').remove();
        const heading = [root.find('h1.ptitles'), root.find('h1'), root.find('.ptitles'), root.find('h2')].find((el) => el.length && cleanText(el.first().text()));
        const title = heading ? cleanText(heading.first().text()) : pageTitle;
        heading?.first().remove();
        return { title: title || pageTitle, date: null, categories: [], ...section, contentHtml: root.html() ?? '' };
      }

      // The homepage and anything unexpected: <main> without the theme's decorations.
      const main = $('main').first().length ? $('main').first() : $('body').first();
      return {
        title: cleanText($('h1').first().text()) || pageTitle,
        date: null,
        categories: [],
        ...section,
        contentHtml: main.html() ?? '',
      };
    },

    kindByUrl(url: URL): KindMatch | undefined {
      const p = url.pathname.toLowerCase();
      if (p === '/news-view' && url.searchParams.has('id')) return { kind: 'post', reason: 'bjm-news-item' };
      if (p === '/news' || p === '/press_full_list.php' || p === '/calendar' || p === '/locations' || p === '/locations/map' || p === '/locations/list') {
        return { kind: 'listing', reason: 'bjm-listing' };
      }
      if (/^\/locations\/detail\/\d+$/.test(p)) return { kind: 'record', reason: 'bjm-community' };
      if (p === '/zip-codes-zones') return { kind: 'record', reason: 'bjm-zip-zone' };
      // The payment-standards map (two URLs, one inline-SVG page) is the ZIP zone data shown as a map.
      if (p === '/zip-code-map' || p === '/payment-standards-map') return { kind: 'record', reason: 'bjm-zip-map' };
      if (['/site-map', '/search.php', '/sign-up', '/alerts-lookup', '/staff-login', '/staff-pages'].includes(p)) {
        return { kind: 'utility', reason: 'bjm-utility-page' };
      }
      return undefined;
    },

    warnings(content: CheerioAPI): string[] {
      // BJM's staging host has its own file library; links there aren't the client's site.
      const staging = new Set<string>();
      content('a[href]').each((_, a) => {
        const url = resolveUrl(content(a).attr('href'), 'https://invalid/');
        if (url && /(^|\.)brooksjeffrey\.us$/i.test(url.hostname)) staging.add(url.href);
      });
      return [...staging].map((href) => `staging-link: ${href}`);
    },
  };
}
