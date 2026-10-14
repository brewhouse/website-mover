# Website Mover — Technical Plan

Status: **M0 done** (2026-10-13), except style guide extraction, which is waiting on the PDF. Results are in `docs/m0/`. **Next: M1.** First real job: Jacksonville Housing Authority (JHA), source `https://www.jaxha.org/`.

## 1. What we're building

An internal tool for our team. You give it three things:

1. **Source URL** — the website to copy.
2. **Target URL** — a blank WordPress site with our plugins (the "seed site"), plus a WordPress username and Application Password.
3. **Style guide PDF** — primary/secondary colours, logo, fonts.

It scans the source, proposes a migration plan (pages, posts, custom post types, custom fields, templates, design), a person reviews and approves it, and then it migrates everything into the target — content as **Gutenberg blocks**, a consistent header/footer, templates for every content type, a homepage, internal pages and a contact page — and reports exact counts and errors.

Optional advanced inputs: approved sitemap (CSV/XLSX), project profile + brief, GA4 measurement ID, priority-URL export (GA / Search Console), logo override.

## 2. Decisions (locked)

| Topic | Decision |
|---|---|
| Flow | **Scan → Plan → Approve → Execute → Verify → Report.** The plan is a versioned JSON file; execution follows only the approved plan, from the snapshot taken at scan time. |
| Editor | All content is saved as Gutenberg blocks, built with WordPress's own block library (`@wordpress/blocks` `createBlock` + `serialize`, `rawHandler` for basic HTML). Never hand-written block markup. |
| Target theme | **Planeteria framework**, styled to the client's brand from the style guide. Template strategy depends on the framework type — see §6.7. |
| Seed site | ACF + whatever forms plugin is installed (adapters for the top two). Our **bridge plugin** is installed on the seed. |
| Bridge plugin | Needed only during migration. Everything it creates is stored natively (ACF post types/field groups, the forms plugin's own forms, templates), so it can be removed afterwards without breaking the site. |
| Sources | Mostly WordPress → read the source's public WP REST API first; HTML crawl is the fallback. Accept a WXR export file as an optional extra input. |
| Users | Internal team tool. Docker Compose deploy behind a login. |
| AI | **OpenAI** via the official `openai` Node SDK — Responses API, Structured Outputs (strict JSON schema), PDF file input, Batch API for bulk work. Model set by `OPENAI_MODEL` env; key from `OPENAI_API_KEY`. |
| AI rules | Rules first, AI only for judgement. **AI never writes or rewrites content.** Any value AI extracts must appear verbatim in the source (checked). |
| URLs | Keep slugs and hierarchy, unless the approved sitemap moves a page (then 301). Keep document upload paths. |
| Language/stack | TypeScript end to end (pnpm workspaces). |
| Template strategy *(M0)* | PlaneteriaWeb is a **classic PHP child theme of a block theme** (TT2), i.e. a hybrid, so we use the **classic/hybrid path** (§6.7). Design, header, footer and homepage go through the framework's own ACF options, named menus, page templates and ACF fields. See `docs/m0/framework-assessment.md`. |
| Content model *(M0)* | **Target the framework's own types and field names** (`post`, `events` + `meeting_event_type`, `people`, `resource_library` and library attachments, `departments`, `faqs`, `alert`). Create new ACF types only when nothing fits (§6.4). Field definitions are read from the seed through the bridge (`GET /schema`), never guessed. |
| Block conversion *(M0)* | `@wordpress/blocks` + `@wordpress/block-library` **pinned to the seed's WordPress release** (`wp-X.Y` dist-tags, every `@wordpress/*` package pinned via pnpm overrides) under jsdom. Pipeline: our normalize → `rawHandler` → our tidy → `createBlock` builders. Validated in Node, plus a real-editor check with Playwright. See `docs/m0/blocks-spike.md`. |
| OpenAI model *(M0)* | **`gpt-6-astra`**, OpenAI's top tier. It passed a Responses API + strict JSON schema + PDF input test. `gpt-6.1-sol` (≈5× cheaper, "near-Astra") is the fallback for bulk/Batch work if cost matters. |

## 3. Open items / inputs needed

1. ~~Planeteria framework~~: **resolved in M0** (hybrid; see §2). **New: we need the seed's database** (a Pantheon backup) **or an ACF export** (field groups, post types and taxonomies), plus its menus and options. The framework keeps all post types, field groups, options and menus in the DB, not in git (blocks M1).
2. **JHA style guide PDF**: still needed (M0 spike 6 is waiting on it).
3. **JHA approved sitemap**, and its format. More important now: the source's tree is odd (582 of 597 nodes sit under "About Us").
4. **Seed site** URL + Application Password (needed from M1).
5. ~~Seed plugin stack~~: **resolved.** ACF Pro 6.3.8, Gravity Forms 3.1, Redirection 5.5, Yoast 24, Ajax Search Pro 4.27 (search; PDF indexing still to be checked), The Events Calendar (installed but **unused** by the theme).
6. ~~OpenAI model~~: **resolved** (`gpt-6-astra`).
7. **New, from the JHA inventory:**
   - Ask Brooks Jeffrey Marketing (BJM) for a content export?
   - Migrate the 720 files nothing links to?
   - Rebuild the direct-deposit form (SSN and bank details)?
   - Who supplies the quick links? (`/quick-links` is empty.)
   - Confirm content ownership, given BJM's "proprietary" notice.
8. **New, theme code changes for the team** (T1–T7 in `docs/m0/framework-assessment.md` §6): placeholder logo text, homepage lorem ipsum, missing `index.php`/archives, a Pantheon-only call, hard-coded fonts, two meeting models, broken patterns.

## 4. Pipeline

```
1 INTAKE   source URL · target URL + WP user + App Password · style guide PDF · (optional inputs)
2 SCAN     discover URLs (WP REST / sitemaps / crawl) → snapshot every page + media list → extract → read style guide
3 ANALYZE  classify pages → apply content-model preset → cluster leftovers into CPT proposals
           → map to approved sitemap → detect forms/nav → probe target capabilities
4 PLAN     versioned JSON: every URL → destination, CPTs, fields, templates, design tokens,
           forms, menus, redirects, warnings, expected counts
5 REVIEW   human edits + approves (approver, timestamp, plan version recorded)
6 EXECUTE  preflight → design → schema → media/documents → content → links → templates/menus → homepage → publish
7 VERIFY   fetch every new URL, re-validate blocks, broken links/images, count reconciliation
8 QA       accessibility (axe-core) + responsive screenshots per template
9 REPORT   per-type counts, errors with retry, scope checklist, CSVs, screenshots, rollback
```

## 5. Core design principles

- **The plan is the contract.** Reviewable, editable, diffable, repeatable.
- **Idempotent & resumable.** Every created entity is tagged with a source key (normalized URL hash) and job ID (`_wm_source_key`, `_wm_job_id` meta). Re-runs update in place; rollback deletes everything a job created and restores the previous global styles.
- **Rebuild content, don't clone visuals.** The design comes from the style guide + framework.
- **Nothing dropped silently.** Anything we can't convert cleanly falls back (e.g. `core/html`) and is counted as a warning.

## 6. Components

### 6.1 Intake
Form with the three required inputs + Advanced section. App Password encrypted at rest (AES-256-GCM, key from env), redacted in logs, can be purged after the run. Required checkbox: "I have the rights to migrate this content."

### 6.2 Source acquisition
- **WordPress sources (primary):** detect via `<link rel="https://api.w.org/">`. Pull pages, posts, public CPTs, categories, tags, authors, and the **full media library** (`/wp/v2/media`, catches unlinked PDFs). Use `content.rendered` (raw needs auth).
- **Other sources:** robots.txt → sitemaps (incl. indexes, `/wp-sitemap.xml`) → same-host BFS with depth/page limits. Platform fingerprinting (Squarespace, Wix, Webflow, Shopify, static).
- **JHA is not WordPress** *(M0)*. jaxha.org runs a proprietary CMS from Brooks Jeffrey Marketing (BJM). For JHA, the HTML path *is* the main path, so the generic extractor moves into M1.
  - **Seed the crawl from `sitemap.xml` *and* any HTML site map.** JHA's `sitemap.xml` is stale and is missing 82 live pages.
  - **Per-platform content selectors.** For BJM: `#bodyContainer`, `#cms_body_content`, `#cms-content`, `#interior section`.
  - **Find unlinked files where the file endpoint uses sequential ids** by HEAD-sweeping the id range.
  - `docs/m0/jha-inventory.md` has the numbers.
- **JS-rendered pages:** Playwright fallback when static HTML has little content.
- URL normalization: canonical, strip tracking params, trailing slash, dedupe by content hash. Skip feeds, pagination, tag archives, search, login, cart.
- Polite: concurrency 4, crawl-delay respected, retries with backoff. **SSRF guard:** block private/link-local/metadata IPs, re-checked after DNS and on every redirect.
- Snapshot everything (HTML + metadata) — execution uses snapshots, not the live site.

### 6.3 Extraction & classification
- Boilerplate removal: DOM blocks repeated on >~60% of pages = site chrome. `<main>`/`<article>`/Readability as fallbacks.
- Per page: title, SEO title/description, OG image, H1, dates, author, breadcrumbs, JSON-LD, cleaned main HTML, sections, images, links, forms, embeds, layout fingerprint, word count.
- Classes: `page | post | cpt:<type> | listing | utility | exclude`. Signals: URL patterns, Article JSON-LD, RSS membership, date/author presence. AI decides low-confidence cases. Listings become archive templates, not pages.
- Hierarchy from URL paths.

### 6.4 Content model — public-sector profile (preset first, inference second)

| Type | Built as | Key fields |
|---|---|---|
| News | Core posts | date, featured image, category |
| Events | The Events Calendar if present (REST create), else ACF `event` | start/end, all-day, venue, link |
| Board meetings | ACF `meeting` | date/time, kind (regular/special/committee/hearing), committee (taxonomy), location, agenda, minutes, packet, recording URL, status |
| Board members | ACF `board_member` | name, role, photo, bio, term |
| Documents | ACF `document` | file, document type (taxonomy), department, date, language, extracted text |
| Forms & quick links | Forms plugin + ACF `resource_link` | forms; external portals (applications, tenant/landlord portals) |

**On the Planeteria framework, the presets map to the framework's existing types** *(M0, `docs/m0/framework-assessment.md` §5)*:

| Preset | Framework target |
|---|---|
| News | `post` + `category`. Listing page uses the News template |
| Events | Framework `events` + `event_type`, **not** The Events Calendar (installed but unused by the theme) |
| Board meetings | Provisionally `events` tagged `meeting_event_type`="Meetings". It has a full single template with agenda, packet, minutes, video and supplemental files. Kind and committee go into `event_type` terms. Final choice between this and the framework's separate `meetings` type waits for the seed DB (theme change T6) |
| Board members | `people` (`first_name`, `last_name`, `title`, `biography`, photo), shown on a page through a people-grid ACF block. Term dates need a small extra field group |
| Documents | Library **attachments** (`index_for_library`, `publication_date`, `resource_type`, `related_depts`) for single files. `resource_library` posts for multi-file or external resources |
| Forms | Gravity Forms, plus the framework's Forms directory (`resource_type` form/application) |
| Quick links | Homepage `banner_icon` repeater and Buttons List / Icon Button blocks. External portals → `resource_library` with external links. **No `resource_link` type** |

JHA inventory: news 256; events 0 (the calendar is empty); meetings ≈206, spread over 397 URLs (notice/agenda/minutes pages, notice news items, files) that must be **merged by date + kind**; board 6 + CEO; documents 996 (409 referenced); forms 7.

Inference then proposes **extra** types for review (e.g. properties/communities, procurement/bids, careers). For JHA these are: communities (29 pages with labelled fields) and ZIP payment standards (47 pages that are really one table):
- Cluster by URL prefix + layout fingerprint + JSON-LD type; ≥3 similar pages = candidate.
- Fields from DOM diffs across the cluster + label patterns (`Label:`, `dt/dd`, table rows) + type detection (image, date, email, phone, URL, price, number, rich text).
- AI gets 3–5 samples per cluster → schema with confidence and per-field coverage %.
- Created via ACF (post types/taxonomies via ACF 6.1+, field groups via import, "Show in REST" on). Values written via REST `acf` property. Body stays in Gutenberg content.
- Display: simple fields via **Block Bindings** (`acf/field` source, ACF 6.3+); repeaters/galleries via a small dynamic block (lives in theme, not the bridge) — *revisit once framework is known.*

### 6.5 Documents (first-class)
- Inventory = full source media library + every document link in content (PDF, DOC/X, XLS/X, PPT/X).
- **Preserve original upload paths** (`/wp-content/uploads/YYYY/MM/file.pdf`) via a bridge endpoint → old links in emails/other sites keep working with no redirects. *This only applies to WordPress sources.* JHA serves every file as `/plugins/show_image.php?id=N` (1,281 live files), so old document links need **query-string redirects** (§6.14).
- On Planeteria, each document is a library **attachment** (`index_for_library=1`, `publication_date`, `resource_type`, `related_depts`) listed by the framework's Document Directory. Multi-file resources become `resource_library` posts. PDF text is extracted for search.
- Files nothing links to (JHA: 720, 195 MB of documents) are listed in the plan with a default of **skip**. The reviewer can include them or mark them as Archive.
- Search: core WP search doesn't read PDFs → PDF-indexing search plugin by default; fallback stores extracted text where core search looks.
- Report counts documents by type; flags untagged (inaccessible) PDFs; reviewer can mark old documents as **Archive**.

### 6.6 Approved sitemap (optional input)
- CSV/XLSX: title, parent, path.
- Auto-map source pages → sitemap nodes (path/title similarity + AI); reviewer confirms in the **Sitemap mapping** tab.
- Matched, same path → keep slug. Matched, moved → new URL + 301. Sitemap node with no source → draft placeholder "needs content". Source page not in sitemap → migrated, left out of menus, flagged.
- Header/footer navigation built from the sitemap when provided; otherwise from the source's primary nav.

### 6.7 Design system & templates
**Tokens from the style guide:** palette (primary, secondary, accent, text, background + derived tints), heading/body fonts, fluid type scale, spacing scale, button/link/heading styles, content widths. Button text colour picked for WCAG AA contrast; link colour darkened if needed.

**Applying them depends on the Planeteria framework. M0 decided: classic/hybrid** (`docs/m0/framework-assessment.md` §6):
- *Block theme:* write global styles (theme.json) via REST, templates/template parts via `/wp/v2/templates` and `/wp/v2/template-parts`, navigation via `/wp/v2/navigation`, fonts via the Font Library REST API, site settings via `/wp/v2/settings`.
- **Classic / hybrid theme (PlaneteriaWeb):**
  - **Content:** Gutenberg.
  - **Colours and heading sizes:** ACF options on "Theme Settings" (`primary_color`… `h6_font_size`), written by the bridge, which then calls the theme's `generate_options_css()`. Mirror the same `:root` variables into Global Styles custom CSS, because the CSS file is written into the theme directory, which is read-only on Pantheon test/live.
  - **Fonts:** Global Styles custom CSS + Font Library. The theme hard-codes Open Sans/Ubuntu.
  - **Header/footer menus:** named menus "Main Menu", "Top Menu", "Explore Menu", "Footer Menu", "Social Menu" via `/wp/v2/menus` + `/wp/v2/menu-items`. The item description is a Font Awesome class.
  - **Footer contact:** `footer_*` ACF options.
  - **Logo:** `site_logo`. It needs theme change T1 to be displayed.
  - **Listing pages:** framework page templates set via the REST `template` field (News, Events, Meetings, Document Directory, Forms & Application, Department Directory).
  - **Homepage:** filled through `template-home.php`'s ACF fields (`banner`, `banner_icon` quick links, featured programs, news/events relationships). That replaces generated homepage patterns.
  - **Archives:** CPT and category archives fall back to the parent's block templates (theme change T3), so keep them out of nav.

**Templates/parts to produce:** header (logo, nav, CTA), footer (logo/blurb, link columns, contact info, social, copyright), front page, page (title band → content → CTA band), full-width page, single post, blog index/archive/search/404, `single-{cpt}` + `archive-{cpt}` per type (meetings list grouped by year, document library with filters, events calendar/list), contact page (form + address/phone/email/hours + map).

**Patterns** (saved to the pattern library for editors): hero, feature grid, text+media, testimonials, CTA band, team/board grid, FAQ (`core/details`), logo strip, contact details, quick links.

**Homepage:** AI classifies source homepage sections into pattern types and fills them with the source's own text/images verbatim; unmappable sections are converted as-is inside a styled group.

### 6.8 Style guide PDF
1. Deterministic: hex/RGB/CMYK in text, vector swatch fills, embedded images (logo candidates), font names.
2. AI: send the PDF (+ page renders) → structured roles (primary, secondary, accent, text, background, heading font, body font, logo location).
3. Cross-check: every colour AI reports must exist in the PDF.
- Fonts: match Google Fonts → download woff2 → self-host. Commercial fonts → closest free substitute + warning, or upload licensed files in review.
- Logo: SVG when extractable, else high-DPI PNG crop; reviewer picks or uploads. SVG upload allowed via bridge (admins only).

### 6.9 HTML → blocks

| Source | Block |
|---|---|
| p, h1–h6, ul/ol, blockquote, pre, hr, table | paragraph, heading, list/list-item, quote, code, separator, table |
| img / figure / srcset / lazy `data-src` | `core/image` (uploaded, with ID + alt) |
| Hero with CSS background image | `core/cover` |
| Multi-column layouts | `core/columns` / `core/column` |
| Sections | `core/group` |
| Button-styled links | `core/buttons` / `core/button` |
| Image grids | `core/gallery` |
| YouTube / Vimeo / Maps iframes | `core/embed` |
| Accordions | `core/details` |
| `<form>` | forms plugin block |
| Anything else | `core/html` fallback → warning |

Always stripped: `<script>`, inline event handlers, `javascript:` URLs, tracking pixels; iframes allowlisted. Content H1s demoted (template supplies the H1).

**Approach (proved in M0, `docs/m0/blocks-spike.md`):**
- **Pipeline:** our DOM normalize (strip classes/styles, resolve lazy `data-src`, iframes → embed URLs, unwrap layout wrappers, keep table captions) → WordPress's `rawHandler` → our tidy pass (embed provider attributes, quote citations) → `createBlock` builders for structure the extractor finds (cover, columns, group, buttons).
- **Packages:** loaded as CommonJS under jsdom, one registry, about 4.4 s cold start, about 19 ms per 2.5 KB page warm. So the worker keeps one converter per process.
- **Images and links:** rebuilt on the `Block[]` tree with `createBlock`, never by regex on serialized markup.
- **Verify:** check `content.raw` byte for byte after saving, then run `validateSerialized`, plus `e2e/editor-check.ts` (the real editor) on a sample.
- **Preflight:** read the seed's disabled blocks (`dubeb_disabled_blocks`).
- **Before M1:** `rawHandler` is not a sanitizer, so M1 adds an allowlist sanitizer.
- **JHA extras:** about 7,300 inline styles to drop, Outlook Safe Links to unwrap, 195 pages with dead Teams/RingCentral links to flag.

### 6.10 Forms
Extract fields (label, type, required, options) → recreate via per-plugin adapter (CF7 and Gravity Forms have REST create; WPForms/Fluent Forms via bridge calling their PHP APIs). Notifications → site admin email, flagged. Third-party embeds (HubSpot, Mailchimp, Typeform) carried over as embeds, flagged.

**Gravity Forms first** *(M0)*: the bridge's `POST /forms` takes a plugin-neutral spec, calls `GFAPI`, is idempotent by `source_key`, and returns the `gravityforms/form` block to insert. JHA forms are native HTML (2) and jQuery formBuilder (3, with an inline JSON definition we can parse).
- **Forms that collect SSNs, bank details or file uploads are never recreated automatically.** They are flagged for a human decision (JHA: direct deposit, vendor application).
- SMS/email alert sign-ups need the client's new tool.

### 6.11 Review screen
Tabs: **Summary** (expected counts, warnings) · **Content** (every URL → type/slug/parent, include toggle, reclassify) · **Sitemap mapping** · **Post types & fields** (rename/merge/split, sample values, coverage %) · **Templates** · **Design** (swatches, fonts, logo, header/footer preview) · **Forms** · **Menus** · **Warnings**. **Approve & run** records approver, time, plan version.

### 6.12 Execution order
1. **Preflight:** auth, WP version, required plugins active, theme, upload limits, `Authorization` header not stripped, environment lock (e.g. Pantheon basic-auth lock conflicts with App Passwords).
2. **Design:** tokens, fonts, logo, site title/icon.
3. **Schema:** CPTs, taxonomies, field groups, forms, permalink structure (match source to avoid redirects).
4. **Terms → media & documents** (dedupe by hash, preserved paths).
5. **Content pass 1:** create as drafts, parents first.
6. **Content pass 2:** rewrite internal links and media URLs.
7. **Templates, parts, menus, homepage**, front page / posts page settings.
8. **Publish.**

Concurrency adapts to the host (back off on 429/503).

### 6.13 Verification, QA, report
- **Verify:** every new URL returns 200; stored content re-validated with WordPress's block validator; broken internal links/images; counts cross-checked against `X-WP-Total`.
- **Accessibility + responsive QA:** axe-core via Playwright on every template type + a sample of migrated pages at mobile/tablet/desktop; screenshots in the report. Target **WCAG 2.1 AA** (the DOJ ADA Title II web rule's standard; likely applies to JHA — confirm). Safe auto-fixes only (heading levels, table headers, empty links); missing alt text flagged, never invented.
- **Report:** per type Planned / Created / Updated / Skipped / Failed / Warnings (reconciles exactly); error list with source URL, step, reason, **retry failed only**; documents by type; **scope checklist** (each SOW line: done / partial / n/a + why); downloads (URL map CSV, redirect CSV, log); screenshots; **rollback**.

### 6.14 Redirects
Full old→new map always. Priority = old nav/sitemap URLs, any changed path, documents, top pages from GA/Search Console export. Import into Redirection plugin if present; otherwise CSV for server-level.

**Id- and query-string URLs** *(M0, JHA)*: about 1,800 legacy URLs are `show_image.php?id=N`, `upages.php?id=N` or `news-view?id=N`. Redirection must match on the query string. For files, prefer one rule per pattern that looks up the id in stored meta (`_wm_source_key`) rather than 1,281 rows.
- Case-insensitive matching (the source server is case-insensitive).
- Clean up 10 non-WordPress-safe slugs.

### 6.15 Analytics & launch support
- Optional GA4 ID → installed (Site Kit if present, else bridge snippet) and verified on the homepage.
- **Delta sync:** re-scan before launch and migrate only new/changed items (agendas, news) instead of a long content freeze.
- **Post-launch check:** re-crawl the full legacy URL list against the live domain — 404s, redirect chains, broken document links, GA tag present. Re-runnable during stabilization.

## 7. Stack & repo layout

- **Web:** Next.js + Tailwind + shadcn/ui; live progress via SSE.
- **Worker:** Node + Playwright/Chromium. Long jobs never run in request handlers.
- **Postgres + pg-boss** (data + job queue). Snapshots/media cache on a volume or S3.
- **AI:** `openai` SDK behind a thin internal interface (`structured(schema, input)`), ~5 call sites.
- **Deploy:** Docker Compose (web, worker, postgres).
- **Local test WordPress:** Docker, running a copy of the seed site's Pantheon codebase (exact theme + plugins) with a local DB, plus the bridge plugin mounted in.
  - Built in M0 as `e2e/seed/setup.sh`: PHP 8.2 + MariaDB 10.4 on `localhost:8088`, with `wp-config-local.php`.
  - It skips plugins that call outside services, and WP Sheet Editor – Media Library, which crashes the post editor.
  - Until we have a seed DB export, its database is empty apart from what tests create.

```
apps/web            Next.js UI + API
apps/worker         job runner
packages/crawler    discovery, fetch, Playwright, robots, rate limiting, SSRF guard
packages/extractor  boilerplate removal, extraction, classification, clustering
packages/analyzer   content-model presets, CPT/field inference, sitemap mapping
packages/styleguide PDF parsing, AI extraction, font resolution
packages/blocks     HTML → block tree → serialized markup, validation
packages/planner    plan schema (zod), generation, diffing
packages/executor   phases, idempotency, rollback, verification, QA
packages/wp-client  typed WP REST client (core + bridge + plugin adapters)
packages/llm        OpenAI wrapper (structured outputs, batch)
wp/bridge           website-mover-bridge PHP plugin
fixtures/           saved source sites + style guide PDFs
e2e/                Docker WordPress + full-pipeline tests
```

**Data model:** Job · SourcePage (snapshot + extracted JSON) · MediaAsset · Plan (versioned, approval) · EntityMap (source key → target type/ID/URL) · Event (structured log).

## 8. Security
Encrypted credentials; SSRF guard; HTML sanitized before saving to WordPress; PDF parsing in the worker with size/page limits; app login required; rights-confirmation checkbox.

## 9. Testing
- **Golden tests** for the converter: HTML in → blocks out; every fixture also asserts zero invalid blocks via WordPress's validator.
- **Fixture corpus:** saved real sites (JHA first) + real style guide PDFs.
- **E2E:** Docker WordPress with seed kit; full scan → plan → approve → execute → verify; assert counts, block validity, 200s, no broken links/images.
- **AI regression set:** small labelled set for classification / CPT inference / sitemap mapping, re-run when prompts change.

## 10. Milestones (JHA is the pilot)

| # | Milestone | Demo | Size |
|---|---|---|---|
| M0 | **De-risk:** HTML→blocks validity in Node; bridge creating CPTs, ACF groups, forms; style guide extraction on real PDFs; scan jaxha.org → inventory (pages, posts, documents by type, meetings, events, forms); inspect Planeteria framework → pick template strategy | Risky parts proven + JHA inventory | S |
| M1 | **Thin end-to-end:** pages + news + **documents with preserved paths** → Gutenberg → media → links → read-only plan + approve → count report | JHA pages/news/docs in the seed | M |
| M2 | **Public-sector model:** meetings, events, document library, board members, quick links, forms | Structured JHA content | M |
| M3 | **Design:** JHA style guide → Planeteria framework; header/footer/nav from approved sitemap; templates | Branded site | M |
| M4 | **Review UI:** editable plan, sitemap mapping, extra-type inference, design preview | Approval gate as specified | S–M |
| M5 | **Finish:** homepage patterns, verification, a11y/responsive QA, redirects, GA4, delta sync, post-launch check, rollback, hardening | Production-ready | M |

### Re-estimate after M0

| # | Was | Now | Why |
|---|---|---|---|
| M1 | M | **M–L** | jaxha.org isn't WordPress, so the generic HTML extractor (BJM selectors, boilerplate removal, allowlist sanitizer) comes into M1 instead of reading WP REST. Documents have no upload paths to keep: they become library attachments plus id-based redirects. 561 referenced files to upload. Blocked until we have the seed DB/ACF export and seed credentials. Less risk on conversion (done) and the bridge (done) |
| M2 | M | **M–L** | Merging meetings is the hard part: 397 URLs (notice/agenda/minutes pages, notice news items, files) → ≈206 meetings, 87 with no date in the title. Lighter elsewhere: events 0, board 6, quick links come from the client, forms 7 (3 with parseable JSON). Communities (29) and the ZIP table are optional extras |
| M3 | M | **M** | No block templates to build: the framework's PHP templates, ACF options, named menus and homepage ACF fields do it. New work: CSS overrides for hard-coded fonts and the Pantheon read-only CSS file. Depends on the style guide PDF and on the team making theme changes T1–T7 |
| M4 | S–M | **S–M** | Unchanged. The sitemap mapping tab matters more, since the source tree has almost everything under "About Us" |
| M5 | M | **M** | Redirects are bigger (≈1,800 id/query-string URLs). The homepage is ACF field mapping rather than patterns (smaller). GA4 property known (`G-ZHVZNQBLZ8`) |

Net: about one size larger overall, mostly because the first client isn't a WordPress source. Order unchanged.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Invalid blocks in the editor | Serialize with WordPress's own block library; validate in CI and after each run |
| Planeteria framework is classic/page-builder | Content still Gutenberg; templates via bridge + theme options (decided in M0) |
| Wrong CPT guesses | Presets for known types; human review; confidence + coverage shown |
| Style guides vary | Deterministic + AI cross-check; manual override in review |
| Host limits (WAF, rate limits, upload size, stripped auth header, env lock) | Preflight checks, adaptive throttling, resumable jobs |
| Source blocks bots / JS-rendered | Playwright fallback; blocked pages flagged, never silently dropped |
| Complex widgets (sliders, tabs, calculators) | Nearest core block or HTML fallback, counted as warnings |
| Content changes before launch | Delta sync |
| *(M0)* Seed content model only in the DB, so it gets guessed wrong | Read definitions from the seed via the bridge's `GET /schema`. Local tests use an ACF export of the seed. M0 hit this: a guessed field type crashed a framework template |
| *(M0)* Framework needs theme code changes we can't make (placeholder logo text, lorem ipsum, missing archives, Pantheon-only call) | T1–T7 list handed to the team. The report flags any that are still open |
| *(M0)* Generated CSS file can't be written on Pantheon test/live | Mirror tokens into Global Styles custom CSS |
| *(M0)* Seed plugins that break wp-admin (WP Sheet Editor Media Library vs Enable Media Replace) or disable blocks | Preflight opens one post in the editor and reads `dubeb_disabled_blocks` |
| *(M0)* Sensitive forms (SSN, bank details) | Never recreated automatically; human decision |

## 12. Not in v1
Pixel-perfect visual cloning · WooCommerce · memberships / gated content · multilingual · comments (except WP sources, later) · creating user accounts (content attributed to one user, original author name kept).

## 13. JHA scope traceability

| SOW line | Owner | Where in this plan |
|---|---|---|
| WordPress CMS setup and managed hosting | Team | Preflight validates the seed (§6.12) |
| Responsive Planeteria framework styled to JHA brand | Tool | §6.7, §6.8 |
| Lift-and-shift of public pages and documents | Tool | §6.2, §6.5, §6.9 |
| Implementation of the approved sitemap where practical | Tool | §6.6 |
| News, events/calendar, board/meeting content, forms/links, search, document access | Tool | §6.4, §6.5, §6.10 |
| Navigation, header/footer, reusable page templates | Tool | §6.6, §6.7 |
| Basic accessibility and responsive QA | Tool | §6.13 |
| 301 redirects for priority legacy URLs where available | Tool | §6.14 |
| Analytics setup, launch coordination, post-launch stabilization | Tool (analytics, checks) + Team | §6.15 |

This scope list is also the default **project brief** passed to every AI step for public-sector jobs.
