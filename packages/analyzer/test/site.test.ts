import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { jobPath, writeJson, writeJsonl, type SiteAnalysis } from '@wm/core';
import { analyzeSite } from '../src/index.js';

/** analyzeSite on a homepage shaped like jaxha.org's (BJM CMS), markup trimmed from the real page. */
const O = 'https://www.jaxha.org';

const HOME = `<html><head><title>Home - Housing &amp; Community - Jacksonville, FL</title></head><body>
<div id="topNav"><ul><li><a href="/">Home</a></li><li><a href="/calendar">Calendar</a></li></ul></div>
<div id="bottomNav"><ul class="mainMenu">
  <li><a href="/about-us">About Us</a><ul><li><a href="/board">Board</a></li></ul></li>
  <li><a href="#">Residents</a><ul><li><a href="/fss">FSS Program</a></li><li><a href="tel:9046303810">Call us</a></li></ul></li>
  <li><a href="javascript:void(0)">Empty</a></li>
</ul></div>
<div id="rotator"><ul class="slides">
  <li data-banner-title="Providing Affordable Housing" data-banner-link="/about-us" data-banner-subtitle="Learn More">
    <img src="/plugins/show_image.php?id=820&amp;size=large&amp;type=jpg" alt="Family at home"></li>
</ul></div>
<div class="homeBorder">
  <p>The <strong class="headingFont">mission</strong> of Jacksonville Housing is to provide <a href="/fss">housing</a>.</p>
  <p>   </p>
  <a href="/about-us" class="mainButtons">Learn More About <span>Jacksonville Housing&nbsp;&nbsp;<i class="fas fa-angle-right"></i></span></a>
  <div id="anni-perf"><a href="/30th-anniversary"><img src="/a.png" alt=""></a></div>
</div>
<div id="buttonRow"><a href="/calendar"><span>View Our Full</span><br> <strong><span>Calendar</span></strong></a></div>
<div id="sideBar"><a href="https://www.facebook.com/jha" aria-label="Like us on Facebook"><i class="fab fa-facebook"></i></a></div>
<div id="nationalNews"><strong class="headingFont">Industry Links <i class='fas fa-angle-double-right' aria-hidden='true'></i></strong></div>
<div id="footerPhone"><div><strong aria-hidden="true">P</strong>&nbsp; <a href="tel:+19046303810">904-630-3810</a></div><div><a href="/staff-pages"><strong>Staff Module</strong></a></div></div>
<div id="footerInfo"><div>Monday - Friday<br>8 am - 5 pm</div></div>
<div id="footerMiddle"><div id="footerIcons"><img src="/eho.svg" alt="Equal Housing Opportunity"/> <img src="/hc.svg" alt="Handicap Accessible"/></div>
  <div class="condensedFont"> <strong>We are an Equal Housing Opportunity Provider.</strong> Call Customer Service at <a href="tel:+12027081112" class="underline">(202) 708-1112</a> (voice) &amp; more. </div>
  <div class="condensedFont padTop18"> In accordance with <span>HUD</span> policy. </div></div>
<div id="footerBottom"><div id="copycred"><a href="https://maps.google.com/?q=1300">1300 N Broad Street</a> <a href="/accessibility">Accessibility</a> <a href="#">2026</a></div></div>
</body></html>`;

let site: SiteAnalysis;

beforeAll(async () => {
  process.env.WM_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'wm-site-'));
  await writeJson(jobPath('t', 'job.json'), { id: 't', origin: O, profile: 'bjm', scannedAt: '' });
  const html = 'snapshot/html/home.html';
  await mkdir(path.dirname(jobPath('t', html)), { recursive: true });
  await writeFile(jobPath('t', html), HOME);
  const board = 'snapshot/html/board.html';
  await writeFile(jobPath('t', board), '<html><head><title>Board - Housing &amp; Community - Jacksonville, FL</title></head><body></body></html>');
  await writeJsonl(jobPath('t', 'snapshot', 'pages.jsonl'), [
    { url: `${O}/`, finalUrl: `${O}/`, status: 200, contentType: 'text/html', fetchedAt: '', html, via: 'seed' },
    { url: `${O}/board`, finalUrl: `${O}/board`, status: 200, contentType: 'text/html', fetchedAt: '', html: board, via: 'sitemap' },
  ]);
  site = await analyzeSite('t');
});

it('keeps a dropdown parent that only opens its menu, with its children, and leaves out phone and script links', () => {
  expect(site.menus.main).toEqual([
    { label: 'About Us', href: `${O}/about-us`, children: [{ label: 'Board', href: `${O}/board` }] },
    { label: 'Residents', href: '', children: [{ label: 'FSS Program', href: `${O}/fss` }] },
  ]);
  expect(site.menus.top.map((l) => l.href)).toEqual([`${O}/`, `${O}/calendar`]);
  expect(site.menus.footer).toEqual([{ label: 'Accessibility', href: `${O}/accessibility` }]);
  expect(site.menus.social).toEqual([{ label: 'Like us on Facebook', href: 'https://www.facebook.com/jha' }]);
});

it('reads the slides with the image file itself (not its size variant) and the tiles under them', () => {
  expect(site.home.slides).toEqual([
    { title: 'Providing Affordable Housing', subtitle: 'Learn More', link: `${O}/about-us`, image: `${O}/plugins/show_image.php?id=820`, alt: 'Family at home' },
  ]);
  expect(site.home.buttons).toEqual([{ label: 'View Our Full Calendar', href: `${O}/calendar` }]);
  expect(site.contact.address).toBe('1300 N Broad Street');
});

it('keeps the homepage introduction verbatim with absolute links, and its button as a linked paragraph', () => {
  expect(site.home.intro).toBe(
    `<p>The <strong class="headingFont">mission</strong> of Jacksonville Housing is to provide <a href="${O}/fss">housing</a>.</p>\n` +
      `<p><a href="${O}/about-us">Learn More About Jacksonville Housing</a></p>`,
  );
});

it('takes the site name from the page titles as shown: the shared segment before the place', () => {
  expect(site.siteName).toBe('Housing & Community');
});

it('reads the footer as the theme lays it out: the links band heading, the notice icons, the contact links and hours', () => {
  expect(site.exploreHeading).toBe('Industry Links');
  expect(site.footerIcons).toEqual(['Equal Housing Opportunity', 'Handicap Accessible']);
  expect(site.menus.contact).toEqual([{ label: 'Staff Module', href: `${O}/staff-pages` }]);
  expect(site.contact.phone).toBe('904-630-3810');
  // The line break stays, so the footer shows the hours on two lines as the source does.
  expect(site.contact.hours).toBe('Monday - Friday\n8 am - 5 pm');
});

it('keeps the notices verbatim with their bold opening and phone links, everything else as escaped text', () => {
  expect(site.footerNotices).toEqual([
    '<strong>We are an Equal Housing Opportunity Provider.</strong> Call Customer Service at <a href="tel:+12027081112">(202) 708-1112</a> (voice) &amp; more.',
    'In accordance with HUD policy.',
  ]);
});
