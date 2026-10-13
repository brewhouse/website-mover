# Website Mover — Technical Plan

Status: **approved for implementation, M0 next.** First real job: Jacksonville Housing Authority (JHA), source `https://www.jaxha.org/`.

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

## 3. Open items / inputs needed

1. **Planeteria framework** — the user will provide it. Need to determine: block theme (theme.json / Site Editor), classic theme, or classic + page builder. This decides §6.7.
2. **JHA style guide PDF.**
3. **JHA approved sitemap** — and its format.
4. **Seed site** URL + Application Password (needed from M1).
5. **Seed plugin stack** — defaults unless Planeteria's standard differs: The Events Calendar (events), a PDF-indexing search plugin (search), Redirection (redirects), ACF, forms plugin TBD.
6. **Which OpenAI model** — list models available to the key, pin in config.

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

Inference then proposes **extra** types for review (e.g. properties/communities, procurement/bids, careers):
- Cluster by URL prefix + layout fingerprint + JSON-LD type; ≥3 similar pages = candidate.
- Fields from DOM diffs across the cluster + label patterns (`Label:`, `dt/dd`, table rows) + type detection (image, date, email, phone, URL, price, number, rich text).
- AI gets 3–5 samples per cluster → schema with confidence and per-field coverage %.
- Created via ACF (post types/taxonomies via ACF 6.1+, field groups via import, "Show in REST" on). Values written via REST `acf` property. Body stays in Gutenberg content.
- Display: simple fields via **Block Bindings** (`acf/field` source, ACF 6.3+); repeaters/galleries via a small dynamic block (lives in theme, not the bridge) — *revisit once framework is known.*

### 6.5 Documents (first-class)
- Inventory = full source media library + every document link in content (PDF, DOC/X, XLS/X, PPT/X).
- **Preserve original upload paths** (`/wp-content/uploads/YYYY/MM/file.pdf`) via a bridge endpoint → old links in emails/other sites keep working with no redirects.
- Each document becomes a `document` post (listable, filterable, searchable); PDF text extracted for search.
- Search: core WP search doesn't read PDFs → PDF-indexing search plugin by default; fallback stores extracted text where core search looks.
- Report counts documents by type; flags untagged (inaccessible) PDFs; reviewer can mark old documents as **Archive**.

### 6.6 Approved sitemap (optional input)
- CSV/XLSX: title, parent, path.
- Auto-map source pages → sitemap nodes (path/title similarity + AI); reviewer confirms in the **Sitemap mapping** tab.
- Matched, same path → keep slug. Matched, moved → new URL + 301. Sitemap node with no source → draft placeholder "needs content". Source page not in sitemap → migrated, left out of menus, flagged.
- Header/footer navigation built from the sitemap when provided; otherwise from the source's primary nav.

### 6.7 Design system & templates
**Tokens from the style guide:** palette (primary, secondary, accent, text, background + derived tints), heading/body fonts, fluid type scale, spacing scale, button/link/heading styles, content widths. Button text colour picked for WCAG AA contrast; link colour darkened if needed.

**Applying them depends on the Planeteria framework (decide in M0):**
- *Block theme:* write global styles (theme.json) via REST, templates/template parts via `/wp/v2/templates` and `/wp/v2/template-parts`, navigation via `/wp/v2/navigation`, fonts via the Font Library REST API, site settings via `/wp/v2/settings`.
- *Classic / hybrid theme:* content still Gutenberg; header/footer/templates/menus set through the framework's theme options / PHP templates via bridge endpoints; menus via `/wp/v2/menus`.

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

### 6.10 Forms
Extract fields (label, type, required, options) → recreate via per-plugin adapter (CF7 and Gravity Forms have REST create; WPForms/Fluent Forms via bridge calling their PHP APIs). Notifications → site admin email, flagged. Third-party embeds (HubSpot, Mailchimp, Typeform) carried over as embeds, flagged.

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
- **Local test WordPress:** official `wordpress` Docker image + seed kit + ACF + forms plugin.

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

Re-estimate after M0.

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
