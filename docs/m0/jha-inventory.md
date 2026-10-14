# M0 spike: jaxha.org source inventory

**Result: FAIL for "WordPress with a public REST API".** https://www.jaxha.org/ is not WordPress. It runs a proprietary PHP CMS from Brooks Jeffrey Marketing (BJM), who also design and host it. There is no `/wp-json/`, no `api.w.org` link, no feeds and no `wp-content`. The inventory below was therefore built from a polite HTML crawl plus HEAD requests against the CMS's file endpoint. This is the plan's non-WordPress path (§6.2), and it changes several §6.5 / §6.14 assumptions (see Risks).

- **Scan date:** 2026-10-13 (the UTC timestamp in `inventory.json` is 2026-10-14T01:28Z).
- **Re-run** from the repo root: `pnpm exec tsx packages/crawler/scripts/jha-inventory.ts --sweep-file-ids`. Responses are cached in `snapshots/jha/http/`, so a re-run is offline except for anything new. Delete that folder for a fresh scan. Without `--sweep-file-ids` the script HEADs a sample of 120 unreferenced file ids instead of all of them.
- **Code:** `packages/crawler/src/{polite-fetch,sitemaps,wp-rest}.ts`, `packages/crawler/scripts/jha-inventory.ts`.
- **Raw output** (gitignored): `snapshots/jha/` holds `inventory.json` (all numbers below), `pages.json` (per URL), `files.json` (per file id), `news.json`, `site-map-tree.json`, `sitemaps/sitemap.xml`, `robots.txt`, `pages/*.html` and the `http/` cache.

## Method

- UA `website-mover-inventory/0.1 (+internal migration tool)`; at most 4 requests in flight and ≥250 ms between request starts. robots.txt was honoured (it has no `Disallow` and no `Crawl-delay`). 429, 5xx and network errors are retried with exponential backoff (or `Retry-After`). No 429 or 5xx was seen.
- **Seeds:** the homepage, all 799 `sitemap.xml` URLs, and the CMS's HTML site map (`/site-map`, 597 nodes). From there the crawl followed same-site links. URLs are deduped case-insensitively, because the server is (`/APRIL-19-2021-BOARD-MEETING` returns 200). Filter permutations were skipped: `calendar?…`, `news?category=…`, `sign-up?type=…`, `locations/map?type=…`.
- **File library:** HEAD on every `/plugins/show_image.php?id=N` that is referenced, then a full sweep of ids 1–2,264, plus 40 ids past the highest one (none exist).
- **News categories** come from the 16 filtered listings (`/news?category=C&year=-1`, paginated). **Calendar:** default and per-year views.
- **Volume:** about 3,100 requests over two runs (about 7 min each). That is 733 HTML pages, about 2,300 HEADs, and listings and probes.

## Summary

| Item | Count | Notes |
|---|---|---|
| Platform | BJM proprietary CMS | `/templates/jaxha.org/`, `upages.php`, `news-view`, `plugins/show_image.php` |
| `sitemap.xml` URLs | 799 | one urlset, no index, no `lastmod`; stale (see §5) |
| HTML URLs fetched | 733 | 724 × 200, 3 × 404, 6 × 403 (malformed links, §8) |
| Content pages (distinct) | **360** | 162 slug pages (`/{slug}`) + 198 id-only pages (`/upages.php?id=N`), after removing 10 redirecting URLs |
| News items | **256** | `/news-view?id=N`, 2018-10-15 → 2026-10-19, 16 categories |
| Meeting-related pages and news | **397** | ≈206 distinct dated meetings (by date + kind); 87 have no date in the title |
| Calendar events | **0** | calendar module exists (26 categories) but shows no entries |
| Board members | **6 + CEO** | one page, `/board-of-commissioners` |
| Communities (locations) | 29 | `/locations/detail/N`, structured fields |
| ZIP payment-standard pages | 47 | `/zip-codes-zones?field=title&value=NNNNN` |
| File library: live files | **1,281** | ids 1–2,264: 561 referenced + 720 unreferenced |
| … documents | **996** | 704 PDF, 281 Word, 4 Excel, 7 other; only 409 are referenced anywhere |
| … images | 285 | 252 JPEG, 29 PNG, 3 BMP, 1 GIF |
| Document links in page content | 415 | 401 (97%) point at the file library |
| Forms | 7 public + staff login | native CMS forms and jQuery formBuilder; no third-party form vendors |
| Words | ~117k in pages, ~63k in news | median page 305 words |

## 1. Platform and REST API

| Check | Result |
|---|---|
| `<link rel="https://api.w.org/">` | absent |
| `<meta name="generator">` | absent |
| `wp-content` / `wp-includes` references on homepage | 0 |
| `GET /wp-json/` | 404 (HTML) |
| `GET /?rest_route=/` | 200 but it is the homepage HTML (the parameter is ignored) |
| `GET /wp-json/wp/v2/menus`, `/menu-items`, `/navigation` | 404 |
| `/wp-includes/`, `/xmlrpc.php`, `/feed/`, `/sitemap_index.xml`, `/wp-sitemap.xml` | 404 |
| `/wp-login.php`, `/wp-admin/` | connection closed with no response, on every retry (inference: a WAF or server rule for WordPress probes) |
| Templates | `/templates/jaxha.org/css/styles.css`, jQuery 3.6.0, Foundation-style grid, Font Awesome 5.9 |
| Credit | footer "Site Design & Hosting by Brooks Jeffrey Marketing"; last line of every page: `<!-- PROPRIETARY - reuse prohibited without written permission by Brooks-Jeffrey Marketing, Inc. -->` |
| Headers | `Server: Server`, `Unit: g-acew2u`, `Cache-Control: no-store`, a `PHPSESSID` session cookie, `Access-Control-Allow-Origin: https://www-jaxha-org.translate.goog`, HSTS preload |
| Analytics | GA4 `G-ZHVZNQBLZ8` via gtag on all 724 pages |

So there are no namespaces, plugins or theme to report. The CMS's own modules visible from outside are: pages (slugged or by id), news/press, calendar, locations (communities) with map and list, ZIP-code zones, SMS/email alerts sign-up, site search (`/search.php`), forms (native and formBuilder), a file library (`show_image.php`) and a "Staff Module" login.

## 2. Content counts

The WordPress types and taxonomies don't exist, so the table counts the equivalent buckets by URL pattern.

| Bucket | URL pattern | In sitemap.xml | Crawled (200) | Notes |
|---|---|---|---|---|
| Slug pages | `/{slug}` | 160 | 164 | 162 distinct (`/fss-public-housing` redirects to `/`, `/staff-pages` to `/staff-login`) |
| Id-only pages | `/upages.php?id=N` | 144 | 206 | 198 distinct: 5 redirect to their slug page, 3 redirect to `/` (deleted pages, inference) |
| News items | `/news-view?id=N` | 243 | 256 | ids 1–303 |
| News listings | `/news?grp=N`, `/press_full_list.php` | 13 | 15 | 20 per page; `grp=20` is the same as `/news` |
| Communities | `/locations/detail/N` | 29 | 29 | 1 office, 6 Project-Based Voucher, 22 rental |
| Community listings | `/locations/map`, `/locations/list` | 3 | 3 | `/locations` redirects to `/locations/map` |
| ZIP-code zones | `/zip-codes-zones?field=title&value=N` | 47 | 47 | payment standards by bedroom count, per ZIP |
| Calendar | `/calendar` | 2 | 1 | empty |
| Alerts sign-up | `/sign-up`, `/alerts-lookup` | 6 | 2 | `?type=txt/email` variants skipped |
| Files | `/plugins/show_image.php?id=N` | 151 | HEAD only | §3 |
| Home | `/` | 1 | 1 | |

- **Taxonomies:** news has 16 categories (every item has at most one; 54 have none, counts in §7). The calendar has 26 categories, all unused. There are no tags.
- **Authors:** none are shown on news or pages, and no user listing is exposed.
- **Hierarchy:** the CMS tree on `/site-map` has 597 nodes and a maximum depth of 5. Almost everything (582 nodes) sits under **About Us** in the CMS, even though the main nav shows Public Housing, HCV Program and Residents as top level. The largest sections by left-nav parent are Board of Commissioners Meetings (194 pages), Past BOC Meetings (43), then 2020 Cost & Admin and Asset Management Meetings (8 each) and Residents (8).

## 3. File library (the media library equivalent)

There is no WordPress media library. Every upload, document or image, is served by **`/plugins/show_image.php?id=N`**, with sequential ids. Images also take `&size=1000` or `&type=medium` variants. Documents return `Content-Disposition: inline; filename="…"` and `Content-Length`. Images return neither. **No upload dates and no `/wp-content/uploads/YYYY/MM/` paths exist**, so there are no upload paths to preserve.

A full sweep of ids 1–2,264 found:

| Id status | Count |
|---|---|
| Referenced by a crawled page or by sitemap.xml | 562 (561 live, 1 returns 410) |
| Not referenced, live | **720** |
| Not referenced, `200 text/html` with an empty body (record but no file) | 141 |
| Not referenced, `410 Gone` | 841 |
| Ids 2,265–2,304 | 0 live |

| Type | Referenced | Unreferenced | Total live |
|---|---|---|---|
| PDF | 285 | 419 | **704** |
| Word (`.docx` 119, `.doc` 1, `.dotx` 1 among referenced) | 120 | 161 | **281** |
| Excel (`.xlsx`) | 3 | 1 | 4 |
| Other (`application/octet-stream`) | 1 | 6 | 7 |
| JPEG | 133 | 119 | 252 |
| PNG | 17 | 12 | 29 |
| BMP / GIF | 2 | 2 | 4 |
| **Total** | **561** | **720** | **1,281** |

- **Sizes** (documents only, since images send no length): referenced documents total 175.5 MB (PDF 160.0 MB, Word 15.4 MB); unreferenced documents total 194.7 MB. Largest: `_FY24 Annual Plan compiled.pdf` 11.1 MB (id 1638), `Resolution No. 2024-JHA-25 (FY25 Annual Plan).pdf` 6.2 MB (1490), `Requested Board Documentation from July 15, 2024 Special Board Meeting.pdf` 5.1 MB (1483), `COJ 2026-2030 ConPlan (Draft 04.21.2026).pdf` 3.4 MB (2105), `Jacksonville Housing Administrative Plan FY2025 - FINAL.pdf` 2.7 MB (1746).
- **"Unattached" equivalent:** 720 live files that no crawled page and no sitemap entry references. 194 of the 587 unreferenced documents have hash-only names (e.g. `0438974006cc8f29cb2dc43d0659da21.pdf`; inference: an older upload scheme). The named ones are mostly superseded meeting agendas, condensed minutes, drafts and duplicate uploads (e.g. `Org Chart - Revised July 2024.pdf` is both id 1462 and id 1469).
- **17 PDFs** appear only in sitemap.xml and are linked from no page (e.g. 2024 resolutions, org charts, condensed special-meeting minutes).
- **Broken:** id 1116 returns 410 and is linked from `/board-of-commissioners-meetings`.

## 4. Document links in content

There are 415 document link instances in the main content of 187 pages:

| Target | Links |
|---|---|
| File library (`show_image.php`) | 401 (97%) |
| hud.gov (7), irs.gov (2), huduser.gov (2), cdc.gov (1) PDFs | 12 |
| `jaxha-my.sharepoint.com` (a vendor town-hall video) | 1 |
| `green.brooksjeffrey.us/plugins/show_image.php?id=1518` (BJM's staging host, labelled "Agenda") | 1 |
| Same host, direct `.pdf/.docx` path | 0 |

The linked documents are 392 distinct files: 268 PDF, 120 Word, 3 Excel, 1 other. **For linked documents, the file library is the complete inventory:** the only off-library documents are 12 public agency PDFs, which can stay external, one SharePoint link and one staging-host link. **The library as a whole is not "what the site links to", though:** only 409 of its 996 documents are referenced. The pages with the most documents are `/upages.php?id=433` "Meeting Minutes" (78 links), `/board-of-commissioners-meetings` (63), `/upages.php?id=603` "HCV Forms" (10) and `/plans-and-policies` (9).

## 5. Sitemaps

`robots.txt`:
```
User-agent: *
Disallow: 
Sitemap: https://www.jaxha.org/sitemap.xml
```

| Sitemap | Status | Type | URLs |
|---|---|---|---|
| `/sitemap.xml` | 200 | urlset | 799: 243 news items, 160 slug pages, 151 files, 144 id-only pages, 47 ZIP zones, 29 communities, 13 news listings, 6 alerts/sign-up, 3 community listings, 2 calendar, 1 home |
| `/sitemap_index.xml`, `/wp-sitemap.xml` | 404 | — | — |

- **The sitemap is stale.** It ends at news id 287 (2026-02-13). The 13 newer news items (ids 288–303, from 2026-03-06) and 62 id-only pages, mostly 2024–2026 meeting pages, are missing. 82 of the crawled 200 pages are not in it, and 108 `/site-map` tree links are not in it. Inference: it was last regenerated between 2026-02-13 and 2026-03-06. One sitemap URL (`/upages.php?id=565`) redirects to `/`.
- `/site-map` (HTML) is the CMS page tree and is more complete. It is saved as `snapshots/jha/site-map-tree.json`.

## 6. Navigation

The utility bar, header icons, main nav and footer are identical on the homepage and an inner page (`/hcv-program`, compared in `inventory.json`). The WordPress menu endpoints 404 (§1).

**Utility bar (top):** Home `/` · Calendar `/calendar` · E-News `/newsletters` · News `/news` · Sign Up For News `/sign-up` · Procurement `/procurement` · E-Procurement `/e-procurement` · Rent Cafe `/rent-cafe`

**Header icons:** Accessibility `/copycred#accessibility` · Translate (Google Translate proxy of `/site-map`) · phone 904-630-3810 · Help Center `/help-center` · QUICK LINKS `/quick-links`

**Main nav** (desktop dropdowns):
- About Us `/about-us`
  - 30th Anniversary `/30th-anniversary`
  - Board of Commisioners `/board-of-commissioners` (sic)
  - Careers `/careers`
  - Code of Ethics and Standard of Conduct Policy `/code-of-ethics-and-standard-of-conduct-policy`
  - Departments & Staff `/departments-and-staff`
  - E-Procurement `/e-procurement`
  - Housing Choice Voucher Program `/hcv-program`
  - Meetings `/meetings`
  - Performance Reports `/performance-reports`
  - Plans and Policies `/plans-and-policies`
  - Procurement `/procurement`
  - Public Housing `/public-housing`
  - Quick Links `/quick-links`
  - Rent Café `/rent-cafe`
  - Residents `/residents`
  - Senior Management `/senior-management`
  - Special District Requirements `/upages.php?id=431`
- Public Housing `/public-housing`
  - Public Housing FAQs `/public-housing-faq`
  - Public Housing Forms `/public-housing-forms`
- HCV Program `/hcv-program`
  - HCV Transferring (Porting) Vouchers to Jacksonville `/hcv-transferring-porting-vouchers-to-jacksonville`
  - Affordable Housing Now Available `/affordable-housing-now-available`
  - HCV Landlords `/hcv-landlords`
  - HCV Participants `/hcv-participants`
  - SAFMR Program `/safmr-program-effective-april-1-2018`
  - HCV Forms `/upages.php?id=603`
  - Contact Us `/upages.php?id=345`
  - Payment Standards Map `/zip-code-map`
- Residents `/residents`
  - Community Resources `/community-resources`
  - COVID Info `/covid-info`
  - Disaster Preparedness `/disaster-preparedness`
  - Family Self-Sufficiency Program `/fss-hcv`
  - Jobs Plus Program - Scattered Sites `/jobs-plus`
  - Neighborhood Network Centers `/neighborhood-network-centers`
  - Resident Advisory Board `/resident-advisory-board`
  - ROSS `/ross`
  - Senior Services Program `/senior-services-program`
- Communities `/locations` (redirects to `/locations/map`)
- Customer Service Survey `/customer-service-survey`

**Mobile menu:** the first level is hard-coded in JS: Quick Links, Customer Service Survey, About Us, Public Housing, HCV Program, Residents, Communities, Home, Calendar, E-News, E-Procurement, News, Procurement, Rent Cafe, Sign Up For News. Deeper levels are fetched with `POST /ajax/ajax.php {id}` (ids 1, 5, 6, 7).

**Inner pages** add a left section nav: the section parent plus its children (e.g. on `/hcv-program`, the same 8 children as the dropdown). It is built from the CMS tree.

**Homepage only:** a 4-slide rotator (→ `/about-us`, `/community-resources`, `/residents`, `/neighborhood-network-centers`), a "View Our Full Calendar" button, 3 latest-news cards, image links to `/30th-anniversary` and `/performance-report-2023`, and an "Industry Links" row: CDC, FAHRO, HDLI, HUD, NAHRO, PHADA, SERC-NAHRO. A sidebar holds search, Facebook and YouTube.

**Footer:** logo `/` · Jax Urban Initiative Development LLC `https://www.juidev.com/` · phone · Staff Module `/staff-pages` · hours (Mon–Fri 8–5) · Equal Housing / HUD non-discrimination text (with HUD phone numbers) · © `/copycred` · Site Map `/site-map` · Accessibility `/copycred#accessibility` · address (Google Maps link) · BJM credit `https://www.brooksjeffrey.com/`

## 7. Content types

**News.** 256 items at `/news-view?id=N` (ids 1–303; gaps are deleted items, inference), dated 2018-10-15 to 2026-10-19. By year: 2018 1, 2019 1, 2020 14, 2021 55, 2022 56, 2023 58, 2024 49, 2025 7, 2026 15. Categories: Board of Commissioners 108, Public Notice 28, Housing Programs 13, Resident Events 12, Holiday 10, JH Union 6, Admin News 5, Career Opportunities 5, 30th Anniversary 4, HCV 3, Grants 2, Landlord News 2, CEO News 1, Community Partnerships 1, Development / Re-development 1, Vendor News 1; 54 uncategorized. **128 of the 256 are meeting notices** (by title). 59 have an image in the body and 45 link files. The date is shown, the author is not. Listings: `/news` (paginated by `grp`), `/press_full_list.php` (all items, titles truncated).

**Events.** There is no events plugin. `/calendar` is a CMS module with 26 categories, including "Meetings - Board of Commissioners", "Landlord Workshops", "Wait List Open" and "Procurement - Bids/RFPs". It reports "No entries found" for the default view, 2026 and 2027. Event-like content lives in news instead: Resident Events (12), Holiday (10), and landlord workshops (e.g. `/news-view?id=278`).

**Board meetings.** These are spread over three places:
- Pages under `/board-of-commissioners-meetings` (194 pages in that section), `/past-boc-meetings` (43), and `/meetings` sub-trees (union, cost & admin, asset management, resident relations). Newer meetings are id-only pages (e.g. `/upages.php?id=652` "October 19th, 2026 - Board of Commissioners Special Meeting"). 2020–2021 meetings have one slug page per artefact (e.g. `/board-meeting-june-15-2020-agenda`, `…-public-notice`, `…-meeting-minutes`).
- A news item per meeting notice (BOC category, e.g. `/news-view?id=302`).
- PDF/Word attachments, plus a minutes index at `/upages.php?id=433` (78 file links).

Altogether: **397 meeting-related URLs** (181 id-only pages, 88 slug pages, 128 news items) covering about **206 distinct dated meetings** (by date + kind). 87 titles have no parseable date. Kinds by title: board committee 145, board regular 119, board special 31, union negotiations 12, executive search 11, asset management committee 10, cost & admin 9, BPAAL board 8 (inference: an affiliate entity's board), shade/closed session 4, retreat 4, RAB 1, other (public hearings, notices, index pages) 43. Years 2020–2026. Attachments: 325 file links (agenda 136, minutes 40, notice 35, resolution 3, other 111), **118 of them Word documents**. Recordings: 8 YouTube embeds and 10 YouTube links, all on `/board-of-commissioners-meetings`. Notices carry virtual-meeting links (195 pages in all): Teams join links (214 links on 159 pages), Teams dial-in (82) and RingCentral (72).

**Board members.** One page, `/board-of-commissioners`: Heather Horovitz (Chair), Hank Rogers (Vice Chair), Harriet Brock (Secretary), Caleena Shirley, Robin Smith, Daniel Blanchard (Commissioners), plus the President/CEO Cheron Corbett. Photos come from the file library. Names are mailto links. There are no bios or terms. Staff appear in free text on `/departments-and-staff` and `/senior-management`.

**Documents.** These are the file library (§3): 996 documents, 409 of them referenced. Document "libraries" are ordinary pages with link lists: `/plans-and-policies`, `/public-housing-forms`, `/landlord-forms`, `/upages.php?id=603` (HCV Forms), `/procurement-forms`, `/performance-reports`, `/hcv-utility-allowances`, and the meeting pages. There is no document-type or department metadata, so that would have to come from the linking page and the filename.

**Forms.** No third-party form vendors (JotForm, Google Forms, Microsoft Forms, HubSpot and others) and no WordPress form plugins were found on any page. reCAPTCHA is on all 7 public forms.

| Page | Implementation | Fields | Notes |
|---|---|---|---|
| `/help-center` | native POST form | 5 inputs + topic-specific comment boxes | topics include Public Record Request and Report Fraud; Google Maps iframe |
| `/customer-service-survey` | native POST form | 17 | property select, yes/no and 1–10 ratings, comments |
| `/landlord-verification-form` | jQuery formBuilder (rendered client-side from inline JSON) | 49 | 25 radio groups, 12 text, 4 date, 3 number, 3 textarea, 2 select |
| `/online-vendor-application-form` | formBuilder, multipart | 22 | **2 file uploads**, 6 checkbox groups |
| `/direct-deposit-form` | formBuilder, multipart | 15 | **asks for SSN/EIN and financial-institution / account details** |
| `/sign-up`, `/alerts-lookup` | CMS SMS/email alerts subscription | — | the subscriber list lives in the CMS |
| `/staff-login` (`/staff-pages`) | Staff Module login | 2 | exclude |

Many "forms" pages (landlord, public housing, HCV, procurement) are lists of PDF/Word forms, i.e. documents rather than web forms.

**Quick links / portals.** `/quick-links` has an **empty body** (0 words), yet it is linked from the header button, the main nav and the mobile menu. `/newsletters` ("E-News") is empty too. The homepage has no quick-link tiles. External portals found in content:

| Portal | Where linked |
|---|---|
| Rent Café, `https://myportals.jaxha.org/` (Yardi RentCafe on a JHA domain) | `/rent-cafe`, `/applicant-rent-cafe`, `/resident-rent-cafe`, `/hcv-landlord-cafe`, 3 news items |
| Landlord Rent Café login, `https://myportals-jaxha.securecafe.com/landlord/…` | `/Viewing-Vendor-Ledger-from-Rent-Cafe`, `/public-housing`, `/departments-and-staff`, 2 news items |
| E-procurement marketplace, `ha.internationaleprocurement.com` | `/e-procurement`, `/procurement` |
| Careers, ADP Workforce Now | `/careers`, 1 news item |
| affordablehousing.com (property listings) | 8 pages, e.g. `/landlord-property-listings` |

**Other candidate types** (inference, for §6.4 inference):
- **Communities:** 29 `/locations/detail/N` pages with labelled fields (Address, City, State, Zip, County, Office Phone, Fax, Bedrooms, Monthly & Weekly Activities, photo, map position), plus map and list views.
- **ZIP payment standards:** 47 pages, each with 7 bedroom-size amounts per ZIP and links to demographics and schools. It is really one data table behind `/zip-code-map` / `/payment-standards-map` (two 710 KB pages with identical content).
- **Procurement / bids** and **careers** exist as plain pages only.

## 8. Migration risks found

- **No page builders or shortcodes.** The content is plain TinyMCE-style HTML in `#bodyContainer` (355 pages), `#cms_body_content` (news, 260), `#cms-content` (listings, 14) or `#interior section` (communities and ZIP pages, 90). The few `[…]` matches were inline JS or literal bracketed text, not shortcodes. Messy markup: **7,326 inline `style` attributes on 476 pages**, 1,179 empty paragraphs, tables on 57 pages.
- **URLs:** 256 news, 198 pages, 29 communities and 47 ZIP pages are addressed by query string or id. 10 slugs aren't WordPress-safe (commas, parentheses, dots, double or trailing hyphens, e.g. `august-16,-2021-board-(bpaal)-meeting`, `dec.-8th-boc-acquisition-committee-meeting`), and 4 are mixed case (`Cost-and-Admin-Meetings`). The source is case-insensitive.
- **Legacy file URLs** are all `/plugins/show_image.php?id=N[&size=|&type=]`. There is no path to preserve, and old links in emails and PDFs will only keep working through query-string redirects.
- **Microsoft Safe Links:** 94 Outlook-wrapped URLs on 44 pages. Their `data` parameter carries a staff mailbox address. The script unwraps them for classification, and the migration should do the same.
- **Dead virtual-meeting links** (Teams/RingCentral) on 195 pages, nearly all meeting notices.
- **Broken links:** 6 links like `+1 904-990-8560,,838959516` (a phone number without `tel:`, which the server answers with 403); 3 internal 404s (`/employment-application`, `/meetings/board-of-commissioners-meetings`, `/family-supportive-services-the-waves`); 4 URLs that redirect to `/` (`/fss-public-housing`, `/upages.php?id=303|365|565`); 1 gone file (id 1116); 1 link to BJM's staging host.
- **JavaScript:** page content is server-rendered (Playwright isn't needed for content). Three formBuilder forms render client-side from inline JSON, which the script parses. Mobile submenus come over AJAX. The community map and the two payment-standards map pages rely on Google Maps.
- **Embeds:** 8 YouTube iframes, 1 Google Maps iframe.
- **Multilingual:** no plugin. Translation is a link to Google Translate's proxy (the server allows `www-jaxha-org.translate.goog` via CORS). Multilingual is not in v1 (§12).
- **Blocking:** no blocking of our UA and no 429 or 5xx in about 3,100 requests. `/wp-login.php` and `/wp-admin/` connections are dropped (a WordPress-probe rule, inference). Responses are `no-store` and set a `PHPSESSID` session cookie.
- **Proprietary notice** on every page (BJM). We rebuild from the style guide anyway, so no `/templates/` CSS, JS or images should be reused. The page content and uploads are presumably JHA's (inference; confirm).
- **Duplicates:** 5 `upages.php` ids redirect to slug pages; `/zip-code-map` is the same page as `/payment-standards-map`; `/news?grp=20` is the same as `/news`.
- **Sensitive forms:** the direct deposit form collects SSN/EIN and bank details, and the vendor application takes file uploads.
- **Thin or empty pages:** 23 pages have under 40 words, e.g. `/quick-links` (0), `/newsletters` (0), `/upages.php?id=530` "Davis Bacon" (3), year-index pages for union meetings.

## Mapping to our preset content model (PLAN §6.4)

| Preset type | Where it lives on jaxha.org | Count | Notes |
|---|---|---|---|
| **News** (core posts) | `/news-view?id=N`; listings `/news`, `/press_full_list.php` | 256 | category maps 1:1 to the 16 news categories; date from the listing; no author. 128 items are meeting notices and probably belong to Board meetings (or both). |
| **Events** (no The Events Calendar, so ACF `event`) | `/calendar` module | 0 | module is empty; 26 categories could seed a taxonomy; event-like news items: Resident Events 12, Holiday 10, workshops |
| **Board meetings** (ACF `meeting`) | `/board-of-commissioners-meetings` and `/past-boc-meetings` pages, `/meetings/*` sub-trees, BOC news items, minutes index `/upages.php?id=433` | 397 URLs ≈ 206 dated meetings | kinds: regular, special, committee (finance & audit, HR, governance, resident relations, acquisition, asset management, cost & admin), union, executive search, BPAAL, shade, retreat. Agenda, minutes and notice files are attached (325 links). Recording URLs come from YouTube embeds and links. Several source URLs make up one meeting. |
| **Board members** (ACF `board_member`) | `/board-of-commissioners` | 6 + CEO | name, role, photo; no bio or term |
| **Documents** (ACF `document`) | file library `/plugins/show_image.php?id=N` | 996 (409 referenced) | 704 PDF, 281 Word; filename from Content-Disposition; no dates or metadata; type and department must come from context |
| **Forms** (forms plugin) | 7 public forms (§7) | 7 | 2 native, 3 formBuilder (JSON is parseable), alerts sign-up; reCAPTCHA; file uploads; sensitive banking fields |
| **Quick links** (ACF `resource_link`) | `/quick-links` (empty), header and nav entries, portal pages | about 5 portals | Rent Café (applicant/resident, landlord), e-procurement, ADP careers, affordablehousing.com, Help Center, Customer Service Survey; the set must come from the client or the approved sitemap |
| *Extra (inferred)* | `/locations/detail/N`; `/zip-codes-zones` | 29; 47 | communities (structured fields + map); ZIP payment standards (one table) |

## Risks / open questions

1. **Non-WordPress source.** JHA has to use the HTML path (§6.2): a crawl seeded by sitemap.xml *and* `/site-map`, since the sitemap is stale, with the content selectors listed in §8. This is the first client, so the generic HTML extractor moves earlier in the plan.
2. **Ask BJM for an export?** A database or CSV export (pages with ids and parents, news with categories and dates, files with upload dates and original names, alert subscribers, form submissions) would be more complete than the crawl and would give dates the HTML lacks. Contract and ownership terms need checking given the proprietary notice.
3. **Unreferenced files (720 live, 587 of them documents, 195 MB).** Do we migrate them, migrate them as Archive (§6.5), or skip them? They include old agendas and minutes, duplicates and hash-named files whose context is unknown.
4. **Redirects.** About 1,800 legacy URLs are query-string or id based (1,281 files, 256 news, 198 pages, 76 communities and ZIPs). §6.5 "preserve upload paths" doesn't apply. We need id-to-URL redirect maps for `show_image.php`, `upages.php` and `news-view`, ideally handled in the bridge rather than as thousands of redirect rows. The redirect tool must match query strings.
5. **Meeting model.** We need rules to merge one meeting's notice page, agenda page, minutes page, news item and files into one `meeting` (date + kind). 87 titles have no date. Do the 128 meeting-notice news items stay as news too?
6. **Events.** The calendar is empty. Should Events start empty, or should meetings and workshops show on a calendar?
7. **Forms.** Is the direct deposit form (SSN/EIN and bank details) rebuilt in the WordPress forms plugin, replaced by a PDF, or moved into Rent Café? Where do submissions go today (email or CMS)? The SMS/email alerts subscribers need an export and a new tool.
8. **Quick links** have no source content: `/quick-links` and `/newsletters` are empty. The client or the approved sitemap must supply them.
9. **Old virtual-meeting links and Safe Links.** Strip, keep or flag them?
10. **Word documents as meeting attachments** (118 meeting links, 281 Word files overall). This is an accessibility concern. Convert them to PDF or leave them as they are? PDF tagging can't be checked without downloading the files, which hasn't been done yet.
11. **Analytics continuity.** Keep GA4 property `G-ZHVZNQBLZ8` (§6.15).
