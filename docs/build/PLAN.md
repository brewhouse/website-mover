# Build from design — plan

A second kind of job next to migration. Instead of a source website, the inputs are a **Figma file**, a
**zip of the HTML/CSS mockups** and a **target seed WordPress site** with the standard plugins. The tool
builds the site's templates, post types, fields and sample pages from them.

## Pilot: City of Newport Beach intranet ("Employee Portal")

| Input | Where |
|---|---|
| Figma | `INTRANET_Spec Link_NewportBeach`, file key `MkBxN44aFzNWXDLZ3aIlFB`, page "All Pages" (`8173:34`). Token: `FIGMA_ACCESS_TOKEN` in `.env`. Frame renders: `inputs/newport-beach/figma/frames/` |
| HTML/CSS | `inputs/newport-beach/Newport-beach-htmls.zip`, unpacked in `inputs/newport-beach/html/Newport-beach/` |
| Target | `https://dev-newport-beach-intranet.pantheonsite.io` (Pantheon site `newport-beach-intranet`). User `sandeep`, Application Password `NEWPORT_APP_PASSWORD` in `.env` |
| Seed code | Clone of the site's Pantheon repo at `bases/newport-beach-intranet` (read-only, like JHA's) |

**The target on 2026-11-09:**
- **Theme:** planeteriaweb 1.8.0, a child of twentytwentytwo, the same framework as JHA.
- **Post types:** `departments`, `people`, `alert`, `faqs` and `resource_library` exist already, plus The Events Calendar's and Kadence's.
- **Content:** 13 seed pages (`home` uses `template-home.php`, plus city-template leftovers such as parks and recreation), 4 posts, 8 media files, and the menus Main, Top, Footer and Social.
- **The Website Mover bridge isn't installed yet**, so `website-mover/v1` returns 404.

**Standard seed plugins** (from wp-admin, 36 active), and how a build uses them:

| Plugin | Use in a build |
|---|---|
| ACF Pro 6.3.8, ACF Font Awesome | Post types, taxonomies, field groups, options, ACF blocks (through the bridge) |
| The Events Calendar 6.14 + Pro 7.6 + Filter Bar | Calendar (`calendar.html` and the home calendar panel). The mockup SCSS already has `_tribe_events` |
| Gravity Forms 3.1 (+ reCAPTCHA) | Front-end forms: "Post a classified", "Upload photos" |
| Ajax Search Pro | Header and banner search, search results |
| FileBird Pro | Media folders. A candidate for the document directory's "repositories" |
| Kadence Blocks + Pro | Not used for the mockup sections. Those become ACF blocks so the markup matches the mockup |
| Block Visibility, Disable Unused Block Editor Blocks | The block allowlist is checked at preflight, as for JHA |
| Planeteria SSO | Login. The intranet greets the signed-in user ("Welcome, Jane S.") |
| Yoast SEO, WP-PageNavi, NS Featured Posts, AddToAny, Smash Balloon FB/IG, GTranslate | Used as the templates need them, e.g. pagination and featured items |

## Decisions

- **A job kind, not a site profile.** It reuses targets, the plan → approve → execute → verify → report
  flow, the review screen, rollback, QA and the bridge.
- **Theme: planeteriaweb, moved to Bootstrap 5.** The mockups' header, sidebar, footer, templates and
  CSS go into planeteriaweb. They aren't a separate theme.
- **The tool generates the theme changes. The team reviews and commits them.**
  - They come as a theme change set, like T1–T22: changed and new files, plus a README.
  - It is generated against the site's own clone, so the diff is exact. The tool never pushes to a
    Pantheon repo.
  - The Bootstrap 5 move only affects this site's copy of planeteriaweb. Each Pantheon site has its own
    repo, so JHA isn't touched.
- **Everything else is stored natively in WordPress** through REST and the bridge: ACF post types,
  taxonomies, field groups and options, menus, media, pages, events and forms.
- **Documents are media-library files with fields** (as for JHA).
- **Pages are filled with the mockups' text and images as sample content.**
  - The text is taken word for word from the HTML.
  - The AI only proposes structure (which regions are fields, which are post types) and never writes
    text.
- **The zip is the source of markup and CSS.** Figma is used to confirm the page and region mapping, to
  read design tokens, and as the reference for the visual check.

## The pilot's inputs

**HTML (14 pages)**
- **Shared shell:** `header.main_header` (logo, search), `aside.page_sidebar` (user card and section
  nav), `div.main_wrapper#page_content` and `footer.main_footer`.
- **Stack:** Bootstrap **5.3.8**, jQuery, Slick, `custom.css` compiled from SCSS
  (`css/sections/{core,global,home,templates}`), and Montserrat from Google Fonts.
- **Images:** `img/` is 102 MB, with PNGs of up to 13 MB, so images are resized and compressed before
  upload.

**Figma "All Pages" (24 frames)**
- **Desktop at 1440 px:** a frame for every HTML page. Classifieds and Photo Gallery have two states
  each (list and modal).
- **Mobile at 375 px:** Dashboard, Page Builder Blocks and three menu states.
- **"Specs and Style Guide"** and **"Typography & Colors Style Guide"**, plus 88 shared styles.

The Dashboard frame matches `index.html` section for section.

| Mockup (Figma frame) | WordPress object |
|---|---|
| `index.html` (Dashboard v1) | Front page (`template-home.php`): alerts (green, orange and red → `alert`), hero slider, banner search, quick links, Rabbit Reads, calendar panel, Training Updates, Classifieds, Welcome Aboard, Throwback Thursday, Employee Perks, Follow Us |
| `department-directory.html`, `department-detail*.html` | Existing `departments` type: overview, resources, staff (`people`), department news, contact sidebar (address, phone, email, fax, hours, social) |
| `news-rabbit-reads.html` (Rabbit Reads) | Posts archive, with search, filters and tags |
| `calendar.html` | The Events Calendar month and list views, restyled |
| `document-directory.html` | Media-library documents with fields: repositories, filters, details and related documents |
| `classifieds.html` (×2) | `classified` post type, plus a Gravity Forms submission form (modal with photos and expiry) |
| `photo_gallery.html`, `album_detail.html` (×2 each) | `photo_album` post type with a gallery, plus a Gravity Forms upload form |
| `page-builder1.html` (Page Builder Blocks) | Default page plus **ACF blocks**: clickable images, quick links, image + text cards, expandable image grid, document list. The typography comes from `.generic_middle_block` |
| `result.html` (Search Results), `404.html`, `403.html` | `search.php` (Ajax Search Pro results), `404.php`, and a 403 template for pages without access |

Training Updates and Employee Perks may be post categories or post types of their own. That's for review.

### The mockups are a restyle of planeteriaweb (2026-11-09)

The mockup HTML uses planeteriaweb's own markup vocabulary: the same class names and the same block
structure. For example, the page builder's "Clickable Images" section is the theme's
`angled_clickable_image` block, with three changes:
- a section heading
- an optional description under each title
- the image wrapped in its own `div`

Matching each mockup section to the theme file whose classes it shares most (the share is in brackets)
gives three kinds of work:

| Kind | Sections | Work |
|---|---|---|
| **Changed framework parts** | Header (`header.php`, 58%); page-builder blocks: Clickable Images (`angled_clickable_image`, 86%), Image + Text Card (`image_text_card`, 70%), How-to (`how_to`, 88%), Buttons List (`buttons_list`, 88%), Contact Cards, Expandable Image Grid; home banner (`template-home.php`, 60%); department detail (`single-departments.php`, 42%); page intro and breadcrumb (`single-*.php`, 60%) | Update the existing render template to the new markup. Add the ACF fields the new markup needs (e.g. a heading, a description sub-field). Keep the existing field names, so content on other framework sites still fits |
| **New parts** | Sidebar (user card and section nav), the footer (rewritten), Quick Links, home content widgets (Rabbit Reads, calendar panel, Training Updates, Classifieds, Welcome Aboard, Throwback, Employee Perks, Follow Us), the department directory listing, the document directory, classifieds, the photo gallery and album, the calendar restyle, search results | New template, partial or ACF block, with new fields or post types |
| **Unchanged or dropped** | City-only templates (parks, recreation, facilities, business) | Listed for removal |

So the generator is a **diff against the framework**, not a theme written from scratch:
1. Match each mockup component to a framework part.
2. Show the markup and field difference on the review screen.
3. Write the updated part.

Only unmatched components are generated new. This keeps the change set reviewable, and the field
names stay compatible with the framework.

## Flow

1. **Intake:** the zip, the Figma link and token, and the target. The zip is unpacked into the job
   folder. `.git`, `node_modules`, SCSS sources and build configs are dropped, and only HTML, CSS, JS,
   images and fonts are kept.
2. **Ingest:**
   - Each HTML page is parsed and screenshotted at 1440 and 375 px.
   - From Figma it reads frames, layer names, text and shared styles (`GET /v1/files/:key/nodes`), and
     renders each frame (`GET /v1/images/:key`, at scale 0.5 for frames over about 10,000 px).
   - Frames are matched to pages by name and text overlap, and a person confirms the matches.
3. **Model (`design.json`):**
   - Deterministic first: the shell is the DOM common to every page. Regions that repeat within a page
     are collections. Regions that differ between pages using one layout are fields.
   - It reads the target's existing schema (bridge `/schema`) so it reuses `departments`, `people`,
     `alert` and TEC rather than duplicating them.
   - The AI (OpenAI Structured Outputs) proposes new post types, field names and types, and template
     assignments. Every label must appear in the HTML or as a Figma layer name.
4. **Plan, which a person approves.** A versioned plan with these sections:
   - `theme`: changed or new theme files, each with its source mockup and field bindings
   - `blocks`: the ACF blocks
   - `postTypes`, `taxonomies` and `fieldGroups`
   - `options`
   - `menus`
   - `media`
   - `pages`: sample content, the template and field values
   - `events`
   - `forms`

   The review screen shows each template beside its Figma frame with the bound regions highlighted.
   Reviewers' edits are saved as decisions, as in migration.
5. **Execute:**
   - The bridge creates the post types, taxonomies and field groups.
   - Media is uploaded, and pages, posts, events and people are created with templates and field values.
   - It writes the menus, options and Gravity Forms.
   - It writes the theme change set (`theme/` in the job folder: files, diff and README) for the team to
     commit.

   Everything except the theme goes in the rollback snapshot. The team reverts the theme with git.
6. **Verify (after the theme is deployed):** Playwright compares each target page (signed out) with its
   mockup at 1440 and 375 px, using a pixel diff and a DOM text diff. The report lists differences per
   template, with the Figma frame for reference. QA runs as for migration.

## Bootstrap 5 in planeteriaweb

The change set makes these changes:

- **Assets:** it replaces the theme's Bootstrap 4 CSS and JS with the mockup's 5.3.8 bundle, and adds
  the mockup's `custom.css` and `custom.js`, Slick and Montserrat. jQuery stays (from WordPress), because
  Slick and the theme's scripts need it.
- **Shell:** it replaces `header.php` and `footer.php` with the mockup's shell, and adds `sidebar.php`.
  - Menus stay WordPress menu locations.
  - The logo comes from `the_custom_logo()` (as T1).
  - The user card reads the signed-in user.
- **Bootstrap 4 markup in the templates the site keeps:** it ports it to Bootstrap 5 (`data-toggle` →
  `data-bs-toggle`, `.custom-select`, `.form-group`, grid gutters, `.media` and so on). Templates the
  site doesn't use, such as the parks and recreation ones, are listed for removal, not ported.
- **The theme's own CSS** (`custom.css` and `layouts/custom-styles.css`): it keeps the ACF colour
  options working by mapping them to the mockup's variables.

## Milestones

| | Scope | Done when |
|---|---|---|
| **B0 Spike** | Bridge on Newport; Figma read (done); the shell (header, sidebar, footer) and `page-builder1.html` → `page.php` plus two ACF blocks; one filled page | A page on Newport dev matches the mockup at both widths, and its fields are editable in wp-admin |
| **B1 Ingest** ✅ | Zip intake, screenshots, Figma frames and styles, frame ↔ page matching | Inventory of the 14 pages and 24 frames, with matches |
| **B2 Model & plan** | Shell detection, collections and fields, reuse of the existing schema, AI proposal, plan schema, review screen | An approvable plan for Newport |
| **B3 Theme generator** (lint ✅, applies ✅, notices: checked in B4) | Bootstrap 5 port, shell, templates, ACF blocks, assets, change set | PHP lint passes; no notices; it installs cleanly on a copy of the Newport repo |
| **B4 Execute** (code ✅, Newport dev: not run yet) | Types, fields, media, pages, events, menus, options, forms, rollback | Newport built on dev |
| **B5 Verify & report** | Visual diff, report, QA | Per-template differences under an agreed threshold |

## B0 results (2026-11-10)

B0 is deployed to Newport dev, and `/page-builder-blocks/` was compared with `page-builder1.html` at
1440 and 375 px.

- **What matches:** the header, sidebar, footer, page title, breadcrumb, headings, image and both blocks.
- **What needed fixing:** the mockup CSS includes rules for WordPress's own markup (`.wp-block-group > *`
  centred at 900px, `.wp-block-list` at 20px) that the static HTML never triggers. Separately,
  WordPress's default block styles (`wp-block-styles`, from the TT2 parent) load after the theme and
  override it.

Two rules for the generator come out of this:
1. Emit a small **adapter stylesheet** (`css/newport/wordpress.css`) next to the unchanged mockup CSS.
2. Turn off `wp-block-styles`.

Both are in B0.1. The visual check also has to click through Pantheon's "sandbox environment" notice on
dev.

## B0.2 results: the dashboard (2026-11-10)

`template-home.php` was rewritten to the mockup dashboard, and its content was added on Newport dev.
The content is 3 new post types (Training Updates, Classifieds, Employee Perks), new fields on Homepage
Details, Alert Details and Person Details, and sample content with the mockup's text.

Compared with `index.html` at 1440 and 375 px, every section matches: alerts, hero, Quick Links,
Rabbit Reads, calendar, the list cards, Welcome Aboard, Throwback, Perks, Follow Us and the footer.
Page heights are within 1%. The only differences are intended:
- **Calendar:** a real month grid (styled after Figma) in place of the placeholder image.
- **Cards:** the real author and date in place of "Jane S." and "Date/Timestamp".

The visual check has to scroll the page first, because WordPress lazy-loads images below the fold.

## B1 results: ingest (2026-11-10)

`packages/design` (`@wm/design`) and `wm design ingest --job newport --zip … --figma <link>`. Output goes
to `data/jobs/<job>/design/`:
- `source/`: the unpacked mockups.
- `pages.json`
- `screenshots/`: each page at 1440 and 375 px.
- `figma/`: the raw read, frames, styles and PNG renders.
- `inventory.json` and `inventory.md`.

Later runs reuse the zip and the Figma read; `--refresh` re-reads Figma.

- **Intake:** the zip is read by a small built-in reader, with no new dependency. It refuses paths that
  leave the folder, symbolic links, encrypted entries, ZIP64 and archives over the size limits. The
  single wrapping folder is removed. Kept: 101 files (103 MB). Dropped: 240 `.git`, 27 SCSS, 4 project
  files, 2 editor settings, 1 source map.
- **Figma:** 24 frames (18 desktop, 5 phone, 1 other) and 157 shared styles. Frames over 10,000 px tall
  are rendered at 0.5×. Rate limits and dropped connections are retried.
- **Screenshots:** scrolled first (lazy images), with smooth scrolling off. Otherwise the sticky header
  is caught halfway down the page. Requests stay inside the mockup folder or go to public hosts. Every
  page logs the mockup's own `matchHeight is not a function`, which is listed once.
- **Matching:** each frame gets a score of 0.4 × name + 0.6 × text, where:
  - name compares the frame name with the file name;
  - text is the share of the frame's text layers found in the page, with shell text left out and
    rarer strings counting more.

  Rules on top:
  - Style guides and odd widths are references.
  - Frames named as a menu or nav are shell states.
  - A clear, unique name match carries a page whose text is a copy of another: `403.html` is the 404
    page with a different file name.
  - Two frames of one kind on one page are allowed (a list and its modal).

  **Result:** all 24 frames are placed correctly:
  - 19 to pages, every page has a desktop frame, and the dashboard and page builder have phone frames
  - 3 phone menu states to the shell
  - 2 style guides as references

  3 are flagged as close calls (department detail and album detail, which share most of their text
  with a sibling page). All 24 stay "proposed" until a reviewer confirms them in
  `review/design-matches.json`. The B2 review screen will write that file.

**What the mockups tell us** (for B2): page titles and h1s aren't reliable. `page-builder1.html`'s h1 is
"Classifieds", and `result.html`'s title says 403. Template names come from the file and frame names.

## B2 progress: model and plan (2026-11-10)

**Model** (`wm design model --job newport --theme <theme folder> --target env:NEWPORT`, writes
`design/model.json` and `.md`). No AI. It produces:
- **Shell:**
  - the header, sidebar and footer most pages share, and their menus (sidebar, footer)
  - one content root for all pages (`div.page_main`), found from text that isn't shell
- **Sections:** each page is split by layout:
  - wrappers and containers of sections are split;
  - a title block that wraps the whole page (department detail) is cut into its title and the
    sections below;
  - repeated loose siblings (search results) form one section.
- **Lists:**
  - siblings with the same markup, where runs of identical children count once;
  - every item's values are kept for sample content;
  - pagination, breadcrumbs and select options are skipped;
  - filter-tag lists are marked as filters;
  - a few lines of different kinds (email, phone, cell) are fields, not a list.
- **Values:** headings, text, rich text, images (icons apart), links, emails, phones and dates.
- **Framework:** each component is matched to the theme file with the largest share of its classes.
  A block's render template wins when it is within 0.2 of the best and scores at least 0.35
  (`page.php` holds some block markup inline).
- **Schema:** existing post types are matched by name, the head noun of the label and synonyms
  (news → post, staff → people). Newport result: 7 pages and 15 lists.

**Plan** (`wm design plan`, then `wm design approve`; versions in `design/plan/`).
1. The rules write a draft **proposal**: page kinds, a binding for each part (theme, core, fields,
   repeater, query, filter, block) and field names and types.
2. `--ai` asks OpenAI to refine the draft. It returns the same shape.
3. Reviewer decisions (`review/design-decisions.json`) apply on top.
4. `buildDesignPlan` checks everything:
   - parts and values must exist in the model;
   - post types and taxonomies must exist or be declared new;
   - new labels must appear in the mockups (page text, Figma text or layer names, class names).

   Anything that fails falls back to the draft, with a warning.

Rules worth knowing:
- **Detail pages:** a detail page without a post type becomes a new one (`album_detail.html` →
  `album`), and a list that links to it is that type's archive.
- **Archives:** an archive's largest list shows its own entries. Archives become framework page
  templates found by name (`template-news.php`, `template-department.php`, `template-documents.php`).
  The exception is The Events Calendar, which keeps its plugin views.
- **Pages with nothing to edit:** 404, 403, search and the plugin views get no fields.
- **Entry templates:** section headings and "View all" links are template words. "Label: value"
  pairs name their field (Address, Fax, Hours).
- **Reuse:** existing fields are reused by name or label. Fields are added to an existing group
  only if it is the only group there or its title names the type. Media uses ACF's
  `attachment == all`.
- **Sample content:** every list item becomes an entry with the mockup's words. Titles come from
  the item's heading, or its title/name text. Identical items are one entry.

Newport, plan v8 (rules only):
- **Templates:** 14, with 10 framework files restyled and 3 new.
- **Content types:** 1 new post type (Albums) and 1 new taxonomy.
- **Fields:** 141 new, in 10 existing groups and 6 new ones. B0.2's fields are reused
  (`quick_links_heading`, `calendar_heading`, `calendar_more`, `throwback_title`).
- **Blocks:** 8, of which 6 are restyled framework blocks.
- **Sample content:** 47 pages and entries, 23 images.
- **Warnings:** none.

Still to do:
- **AI refinement:** run it once `OPENAI_API_KEY` and `OPENAI_MODEL` are in `.env`. The rule-made
  field names are serviceable, not good (`calendar_text`, `meta`).
- **Review screen:** templates beside their frames, and editing decisions.
- **Filters:** the "Filter by Department" drop-downs suggest relating posts to departments. That's
  for the AI or a reviewer.

## B2: design jobs in the web app (2026-11-10)

Design jobs now run in the web app and worker (on Render too).

- **Intake** (`/jobs/new/design`):
  - the job name, the Figma link (stored as the job's `source_url`) and the target;
  - the mockup zip and a zip of the framework theme (the theme folder, or the whole site repo, where
    the named theme is found);
  - the job has `kind = 'design'`.
- **Uploads:** the zips are sent as raw request bodies to `PUT /api/jobs/<id>/inputs/<name>` and
  streamed to `inputs/` on the server. Checks: login, a ZIP signature, and a 600 MB limit. They can be
  replaced from the job page; the next ingest unpacks them again if they're newer.
- **Stages** (migration 007): `ingest` (unpack the theme's PHP/JSON, ingest the mockups and Figma),
  `model` (target from the job), and `design_plan`. The plan uses the AI whenever `OPENAI_API_KEY` and
  `OPENAI_MODEL` are set. Ingest needs `FIGMA_ACCESS_TOKEN`.
- **Review** (`/jobs/<id>/design`): approval, Summary, Templates, Content types, Fields, Blocks,
  Menus, Sample content, Frames and Warnings.
  - The Templates tab shows each mockup beside its Figma frame and screenshot. A reviewer can change
    the page's title, kind and post type, and each part's binding, post type, taxonomy, block and
    field names and labels.
  - Changes are saved to `review/design-decisions.json` and apply on Re-plan.
  - The Frames tab corrects frame matches (`review/design-matches.json`), applied at the next ingest.
- **Approval:** approvers only. It binds the exact plan version and bytes.

## B3: theme generator (2026-11-11)

`packages/design/src/theme/` and `wm design theme --job <job> [--theme <folder>]`; in the web app, the
**Theme change set** run (after approval) and a card with the downloads. Output goes to
`design/theme-changes/v<plan>/`: `files/` (repo paths), `changes.patch`, `theme-changes-v<N>.zip`,
`README.md` and `manifest.json`.

- **Plans record where each value sits:** `PlanPart.values` (field key or `core:*`, and its path from the
  section or list item). Plans made before B3 don't have it; the generator asks for a re-plan.
- **Templates:** the mockup's own markup from the content root, with the plan's bindings:
  - fields → `get_field`, lists → `have_rows` or `wmd_query(post_type, count)`, filter lists → the
    taxonomy's terms (`?wmd_term=`), core values → title, content, featured image, excerpt, date, term;
  - an archive's main list is paged and drives the mockup's pagination; search results loop the main
    query; breadcrumbs and search forms are WordPress's; an entry's title links to it; initials badges
    come from the title; a carousel's first row is active;
  - links to other mockup pages point at their pages; images and inline backgrounds load from the
    theme's assets;
  - a content-root class named after another mockup page is left out (page-builder1's "classifieds").
- **Blocks:** render templates for the restyled and new ACF blocks; new ones are registered in
  the helper library, `inc/<job>.php` (`inc/newport.php`; `inc/wm-design.php` before 2026-11-13; the
  generator replaces a `functions.php` line loading the old name, so it's never loaded twice).
- **Shell:** `header.php` keeps the theme's `<head>` (minus its Google Fonts) and prints the mockup's
  header; `sidebar.php` (menu with the mockup's classes and icons, the signed-in user's card);
  `footer.php` keeps everything from `wp_footer()` on.
- **Assets:** the mockup's stylesheets, scripts, fonts and the images the CSS and templates use, under
  `assets/<job>/` with their layout kept. The helper library drops the theme's Bootstrap 4, `custom.css`
  and `responsive.css` (and scripts the mockup replaces), enqueues the mockup's in its order (after
  the theme's footer scripts), and turns off `wp-block-styles`. `functions.php` gets one `require_once`.
- **Checks:** `php -l` on every PHP file (the Docker image now has `php-cli` and `git`), and the patch
  is a `git diff` against the uploaded theme.

Newport (plan v9, rules only): 12 templates, 8 blocks, 18 files replaced and 65 new (25 PHP, 56
assets, 3.8 MB). **PHP lint passes**, and the patch applies cleanly to the Newport clone
(`git apply --check`). 11 things to check, among them:
- `department-detail.html` and `department-detail-dept.html` both map to `single-departments.php`;
- the dashboard's widget cards and the document repositories are lists without bound fields, so
  they keep the mockup's sample text until a reviewer gives them a post type;
- The Events Calendar's views aren't templated (its markup is styled where the class names match).

Not done yet: loading it in WordPress (no notices) — that comes with B4 on Newport dev.

## B3 follow-ups and linked departments (2026-11-11)

- **Derived values:** parts of a date ("JUL", "6"), an event's time span and image counts ("24 Images")
  are worked out from the entry rather than stored. The proposal marks them `core:derived`; the
  generator prints `wmd_date()` (an event's start date with The Events Calendar), `wmd_time_range()`
  and `wmd_image_count()`. Newport: 11 → 8 things to check.
- **Linked entries (`plan.relations`):** a "Filter by <X>" drop-down on a listing, where X is an
  existing post type, links the listed post type to it. Newport: posts, events and documents each
  get a `department` post-object field (its own "Department" group per type) pointing at
  `departments`. The theme fills the drop-down from the departments (each option is the listing
  filtered by `?department=<slug>`), `wmd_query()` filters by it, and lists on a department's own page
  show only that department's entries. Sample entries listed on a department's page are linked to it.
  The calendar's drop-down is in The Events Calendar's own views, so it's left to its Filter Bar.

## B4: build on the target (2026-11-11)

`wm design build --job … --target env:NEWPORT`, or "Build on <target>" on the job page (approvers
only). From the approved plan, in order:
1. ACF post types and taxonomies (new ones), then the taxonomies' terms.
2. Field groups. The bridge replaces a whole group, so an extended group is sent with all its
   existing fields plus the plan's.
3. The mockup's images (media library, tagged `design:media:<path>`).
4. Pages and entries, tagged `design:<type>:<page>#<component>#<index>`: title, slug, excerpt, date,
   featured image, terms, template, ACF blocks (page-builder pages) and fields (through the bridge),
   with image paths turned into media IDs and links into the built pages. Events get their dates
   through The Events Calendar's REST API. Fields that point at entries are set once all exist.
5. Menus (rewritten as a whole) and the front page.

Re-runs update what the build made, after checking its record against the target: what's gone
(trashed, or the database restored or cloned) is made again. A page the build didn't make where the
plan puts one (`/page-builder-blocks/` from B0) is left as it is and linked to; the site's own front
page keeps its content, but its **empty** fields get the mockup's values (recorded in
`state.filled`, emptied on rollback). A template the target's theme doesn't have yet is left off with
a warning: deploy the theme change set and build again.

Other rules from the first Newport builds (2026-11-12/13):
- Images over 2560 px or 1.5 MB are scaled down before upload (Pantheon answers 502 while WordPress
  makes thumbnails of 4096 px exports); after a 502 the build looks for the tagged attachment.
- A sample event whose date is past moves on in 52-week steps (same weekday and time).
- Entries made from a list get the detail mockup's sample values they don't show (plan warning).
- Menus: the sidebar is merged across every mockup page; a "#" item links to the page, archive or
  entry with that name; items that match nothing are plan warnings.
- Theme: an ACF value prints only when it has one (`wmd_has`), and a section shows only when its
  list has entries or one of its values has something (its heading alone doesn't count).
- The AI can't move a value the rules mapped to a WordPress field (an event's date) into an ACF field.

After build v6 on Newport dev (2026-11-13):
- **The Events Calendar:** `planeteriaweb` is a child of Twenty Twenty-Two, so WordPress counts it as a
  block theme. TEC then renders its pages with its own block templates (the parent's header and
  footer) and hides its "Events template" setting. The generator writes
  `tribe-events/default-template.php` from the calendar mockup (its intro and breadcrumb, then TEC's
  view where the mockup's calendar is), and the helper library sends TEC's pages to it on a block
  theme (a `template_include` filter); on a classic theme TEC uses it by itself. Links to a list a
  plugin renders (`calendar.html`) go to the post type's archive.
- A `<br>` in a mockup value is a line break in the sample value (address, hours); text fields print
  with `nl2br`, WYSIWYG fields get `<br>` from ACF.
- A type shown in several lists (people in Welcome Aboard, Birthdays and Staff; events on the home
  page and the calendar) gives every entry the values the other lists show (plan warning).
- A list item with an extra class (`a.has-corner`) still gives its value; a heading that differs
  between a repeater's rows ("Training Updates", "Classifieds") is a sub-field, not a link's label.
- Text prints only when it has words (`wmd_text`, without empty rows); the breadcrumb names a post type
  archive, and a single entry's crumb goes through its archive.

After deploying theme change set v7 on Newport dev (2026-11-13): the deploy replaced `inc/` with the
zip's, deleting B0's `inc/newport.php`, which `functions.php` still loaded, and every page stopped
with a fatal error until it was restored. The live site also loaded B0's Bootstrap and scripts next to
the change set's. Now:
- **B0 is retired:** a library an earlier step loaded from `functions.php` (a non-generated
  `inc/*.php` that says "Website Mover" or "design (B0)", plus what it loads with `__DIR__`) is retired
  when no theme file the change set leaves alone calls one of its functions. Its line goes, its files
  are listed for deletion (`removals` in the manifest, "Delete" in the README, `git rm
  --ignore-unmatch` in the install steps, deletions in the patch), and the library takes back
  `inc/<job>.php` (deleting `inc/wm-design.php`). Otherwise it stays, with a warning naming the file
  that still uses it.
- Styles and scripts under `css/<job>/` and `js/<job>/` (B0's) are dequeued: `assets/<job>/` replaces
  them.
- The README and the job page say to copy files over the theme, never replace a folder.
- **The build checks the deploy:** before building, it requests the latest change set's `inc/` library
  and stylesheets and scripts on the target (templates aren't requested: opened directly they're a PHP
  error) and warns about any 404, and when the change set isn't for the approved plan. No load-line
  guard in `functions.php`: the header and templates call the library, so a missing library would
  still stop every page, only with a less clear error.
- **From Render's change set v7** (the AI's plan): a link around an image (Follow Us) loses only its
  tags when its field is empty, so the image still shows (it hid the whole item, and the build leaves
  `#` links empty). A template prints `the_content()` once even when the AI binds the content as
  `fields`: a section left to blocks printed it a second time (Finance's Overview twice, where
  Resources was). The AI's block names lose their namespace (`acf/acf/buttons_list` →
  `buttons-list`): the build wrote `acf/acf/acf/buttons-list`, a block nothing renders, so Resources
  didn't show even on the mockup's own department.
- **From Render's plan v8** (the home page's Quick Links and Follow Us empty, every hero slide "More
  About This"): the AI made values repeaters, the list item itself (`path: ""`, a nested repeater
  named like its list) and the banner's `h1` (as the existing `main_banner` repeater). A value is
  never a repeater now: the rules' field for that path stands in, or it's left out (plan warning).
  And sub-fields a list adds to a field another part made first get keys (they had `""`, so each
  slide's row held only its link).
- **After build v9:** the values were right, but build v8 had left nested repeaters (and a sub-field
  keyed `main_banner`) in Homepage Details, and plan v9 reused them by name, so a link became a loop
  over an empty list. An existing field is reused only when both are repeaters or both are values.
  And the build drops what an earlier build added to an existing group that the plan no longer has
  (build-made `field_wm_…` keys and invalid ones, against `before.json`'s copy of the group: the
  group's own fields and an editor's stay), and writes a reused group when there's something to drop.
- **After build v10:** the data and field definitions were right, but the site still ran an older
  change set (its files have the same names, so the 404 check passed). The library now prints
  `<meta name="wm-design" content="<job> vN">` in `<head>`, and the build warns when the home page's
  stamp isn't the latest change set's.

**Rollback** (`wm design rollback`, or "Roll back the build"): `design/build/before.json`, taken before
the first write, holds the extended field groups' definitions, the menus' items and the front-page
settings. Rollback restores those, trashes the pages, entries and images the build made, deletes its
terms and trashes its ACF items. The theme is reverted with git.

Run on Newport dev since 2026-11-12 (from the web app); B5 Verify is next.

## Status (2026-11-09)

- **Newport repo:** cloned at `bases/newport-beach-intranet`. It is read-only.
- **Bridge:** 0.1.1 is active on Newport dev. The site reports WordPress 7.1.4, PHP 8.3, ACF Pro 6.3.8
  and Gravity Forms 3.1.
- **Login:** the intranet doesn't require it, so the visual check runs signed out.
- **Theme deployment for testing:** each change set (starting with B0) is committed to Newport **dev** by
  the team. Dev is the pilot target and has no real content yet.
