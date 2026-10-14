# M0 spike 1: Planeteria framework assessment

> **Update, same day: checked against the seed database** (Pantheon Dev backup, imported locally). The database **overrides §3–§5 wherever they disagree**, because those sections were inferred from templates. See [§0](#0-verified-against-the-seed-database).

**Result: done. The framework is a classic PHP theme with a block parent, so it is a hybrid.** Its post types, field groups, menus and options live in the seed's **database**, not in git. Recommended template strategy: the **classic/hybrid path** of PLAN §6.7. Content stays Gutenberg. Design, header, footer and templates are driven through the framework's own settings: ACF options, named menus, page templates and ACF fields. Section 6 lists the theme code changes the team needs to make.

- Source: the seed codebase at `SEED_CODE_PATH` (`bases/jha-lift-shift`), read on 2026-10-13. It is a plain copy, **not a git clone** (there is no `.git`). The ddev config names the project `city-seed-2024`.
- Evidence: file:line references below are relative to `wp-content/themes/planeteriaweb/` unless stated otherwise. A full field-by-field reconstruction was made from the templates; its findings are summarised here.
- Verified at runtime on the local Docker copy (spike 2): `wp_is_block_theme()` is true, there are no registered menu locations, and the page type → template results are listed in §2.

## 0. Verified against the seed database

Source: `inputs/framework/jha-lift-shift_dev_2026-10-14T01-49-57_UTC_database.sql.gz`. It's loaded with `e2e/seed/setup.sh --db <file>` and read through the bridge's `GET /schema`.

**What the JHA seed actually has:**

| Area | In the database |
|---|---|
| Theme | `planeteriaweb` active (as inferred). Site title is still "City Seed Site". Permalinks `/%postname%/`. Front page "Home" (`template-home.php`). No posts page |
| Post types | `post`, `page`, **The Events Calendar** (`tribe_events`, `tribe_venue`, `tribe_organizer`, `tribe_event_series`), and these ACF types: `alert`, `departments`, `faqs`, `people`, `resource_library`. Inactive ACF types: `parks_facilities`, `projects`, `bid`. **There is no framework `events` or `meetings` type**: the templates that use them (`single-events.php`, Events/Meetings page templates) are leftovers from the city framework |
| Taxonomies | `category`, `post_tag` (also on attachments), `tribe_events_cat` (terms: **Board Meetings**, Meetings, Events, Meeting category 2), `resource_type` (on attachments and `resource_library`; no terms), `faq_category`, plus city ones |
| Field groups (active) | **Person Details** (`people`): `title`, `organization__company`, `phone` repeater (`phone_label`, `phone_number`), `email` repeater (`email_label`, `email`), `address` (google_map), `fax`, `biography`. The name is the post title; there's no `first_name`/`last_name`. **Media Library** (all attachments): `index_for_library`, `library_select` (Bills & Resolutions / Key Documents / Maps), `related_departments`, `related_service_or_program`, `resource_summary`, `keywords`, `publication_date`. **Homepage Details** (`template-home.php`), **Website Theme** and **Footer** options, **Department Details**, **Services / Programs** (default page template), **Alert Details**, and 12 ACF block groups |
| Field groups (inactive) | Resource Details (so `resource_library` has no fields), News Page, Page Menu, Parks/Projects/Business ones |
| REST | **No field group has "Show in REST" on.** Writing ACF values needs it turned on per group (bridge endpoint `POST /acf/field-groups/{key}/show-in-rest`; it changes only that setting) |
| Menus | Main Menu (5 items), Top Menu (1), Footer Menu (2), Social Menu (4). **No "Explore Menu"**, although `footer.php` calls it |
| Options | Theme colours are placeholders (`#202188` / `#327136` / `#f0ab2b`); footer is "123 Main Street, City, ST 00000" |
| Demo content | 4 posts, 13 pages, 5 events, 1 department, 1 FAQ, 4 alerts, 8 attachments, 4 Gravity Forms forms (city-seed demo/test content) |
| Plugins | Active as assumed, except these are **inactive** on the seed: Redirection, UberMenu, Menu Image, Accessibility Checker, Enable Media Replace and WP Sheet Editor (so the editor crash from spike 4 doesn't affect the seed), Intuitive Custom Post Order, and the WP All Import ACF add-on |
| **Disabled blocks** | `dubeb_disabled_blocks` disables in the editor, among others: **`core/cover`, `core/button`** (while `core/buttons` stays enabled), **`core/separator`, `core/preformatted`, `core/code`, `core/details`, `core/gallery`, `core/file`, `core/video`, `core/audio`, `core/pullquote`**, `core/verse`, `core/social-links`, and many Kadence blocks. With these settings, 5 of the sample post's 47 blocks show as "Your site doesn't include support for this block" (`e2e/editor-check.ts`) |
| Rendering | Events Calendar single and list views render with the **TT2 block header/footer**, not the framework's (theme change T3) |

**Corrected mapping** (replaces §5's Events, Board meetings, Board members and Documents rows):

| Preset | Target in the JHA seed | Notes |
|---|---|---|
| Events | **The Events Calendar** `tribe_events` (REST `tribe/events/v1`), venues, organizers, `tribe_events_cat` | JHA has 0 events today |
| Board meetings | **Events Calendar events in the "Board Meetings" category.** Committee/kind → more `tribe_events_cat` terms (e.g. Finance & Audit Committee, Special Meeting) | `tribe_events` has no ACF fields, so agenda/minutes/packet/recording links go in the event content. Proved in the spike: create via `POST /tribe/events/v1/events` |
| Board members | `people`: name → post title, role → `title`, contact → `phone`/`email` repeaters, bio → `biography`, photo → featured image | `organization__company` has one choice left over from another client. No term field |
| Documents | Attachments + **Media Library** fields (`index_for_library`, `publication_date`, `library_select`, `related_departments`, `resource_summary`, `keywords`) + `resource_type` terms (need creating) | `resource_library` has no active fields, so use attachments |
| Extra: communities | New ACF type `community` (+ `community_type`, "Community details" group) | Proved in the spike. Renders through `single.php` (content only) until the team adds a template |

## 1. Codebase layout

| Item | Finding |
|---|---|
| Layout | Classic Pantheon WordPress: core at the root, `wp-content/` at the root, no `composer.json`, no `web/` docroot |
| WordPress | 7.0.4 (`wp-includes/version.php`) |
| PHP / DB | PHP **8.2**, MariaDB **10.4** (`pantheon.upstream.yml`; `pantheon.yml` has no overrides) |
| Config | `wp-config.php` loads `wp-config-pantheon.php` on Pantheon and `wp-config-local.php` elsewhere. Local runs use the latter (spike 2) |
| mu-plugins | `loader.php` → `pantheon-mu-plugin` only |
| Extra dirs | `.ddev/` (DDEV with the Pantheon provider), `.tmb/` (FileBird thumbnails), `.circleci/` and `.github/` (from Pantheon's upstream) |

## 2. Themes

| Theme | Role |
|---|---|
| `planeteriaweb` 1.8.0 ("PlaneteriaWeb", Planeteria Media) | **Child theme of `twentytwentytwo`.** Almost certainly the active theme: it is the only non-default theme, and its generated `layouts/custom-styles.css` holds real option values. *Inferred*: the database isn't in git, so this can't be confirmed |
| `twentytwentytwo` | Block-theme parent |
| `twentytwentythree/four/five`, `twentyseventeen` | Defaults, unused |

**Type: hybrid.** Because the parent is a block theme, WordPress treats the site as a block theme: `wp_is_block_theme()` returns true, and Global Styles, the Font Library and template REST endpoints are all available. But the child provides classic PHP templates (`header.php`, `footer.php`, `page.php`, `single*.php`, `search.php`, `404.php`, 13 `template-*.php` page templates) built on Bootstrap 4, jQuery and Owl Carousel. On the local seed:

| URL type | Rendered by | Header/footer |
|---|---|---|
| Page, single post, single CPT, search, 404 | Child PHP templates | Framework PHP header/footer |
| Blog index (`home`), category/tag/CPT archives, The Events Calendar's `/events/` | **Parent block templates** (`twentytwentytwo/templates/*.html`), because the child has no `index.php`, `archive.php` or `home.php` | TT2 block header/footer, which doesn't match the framework |

**Header** (`header.php`):
- Logo: `get_field('logo_name')`, called **without** `'option'`, so it reads the current post (a bug). The fallback is the theme file `img/Logo.png`.
- Logo text: **hard-coded** "CITY NAME / State" (`header.php:52`).
- Menus: "Top Menu" and "Main Menu" (a mega-menu walker that renders each menu item's *description* as a Font Awesome class).
- Also `[gtranslate]` and Ajax Search Pro `[wd_asp id=1]`.
- Site alert bar from the `alert` post type.

**Footer** (`footer.php`):
- Logo: same lookup as the header.
- Contact block from ACF **options**: `footer_{address,email,phone,fax}` plus `_heading` and `_icon` variants.
- Menus: "Social Menu", "Explore Menu", "Footer Menu".
- Copyright year.
- About 700 lines of inline JS, some keyed to menu-item CSS classes (`megamenu-item`, `megamenu-govt`, `megamenu-res`).

**Menus:** no `register_nav_menus` anywhere. Every `wp_nav_menu` call passes `menu => '<name>'`, so the menus must exist with those exact names. UberMenu and Menu Image are installed but unused.

**Brand styling:**
- ACF options page "Theme Settings" (sub-pages Header and Footer) has `primary_color`, `secondary_color`, `tertiary_color`, `link_color`, `hover_color`, `background_color`, `secondary_background_color`, `tertiary_background_color`, and `h1_font_size` … `h6_font_size`.
- On every `acf/save_post`, `generate_options_css()` renders `inc/custom-styles.php` and **writes `layouts/custom-styles.css` into the theme directory** (`functions.php:2-9`).
- `theme.json` (v2) palette entries point at those CSS variables.
- Fonts are **hard-coded**: Google Fonts "Open Sans" and "Ubuntu" are linked in `header.php:24` and referenced about 90 times in `css/custom.css`, some with `!important`. There is no font option. Proxima Nova files ship in `fonts/` but are unused.

**Custom blocks:**
- 26 ACF blocks (v1 `acf_register_block`, category "Custom Blocks"). Examples: Buttons List, Contact Cards, Sidebar, Resource List (`file_download`), Image with Text Card, Expandable/Modal Image Grid, Full Width Banner, Icon Button, Slideshow, Timeline, Meeting Type, Event Type, Testimonial, Carousel, FAQ Type, Counter.
- Four of them point at render templates that don't exist (`text_card`, `Team`, `map`, `featured_area`).

**Patterns:**
- 20 theme patterns (`patterns/*.php`) built from core blocks plus ACF blocks.
- The accordion and tab patterns use `advgb/*` blocks from PublishPress Blocks, which **isn't installed**, so they are broken.
- `acf/how-to-block` and `acf/how-to-item` aren't registered.

## 3. Plugins vs PLAN §3 item 5

| Need | PLAN default | Seed has | Decision |
|---|---|---|---|
| Custom fields | ACF | **ACF Pro 6.3.8**: post type/taxonomy UI (6.1+), Block Bindings source (6.3+), options pages | ✅ Use it. No `ACF_PRO_LICENSE` needed for development; the plugin is in the codebase |
| Forms | TBD | **Gravity Forms 3.1** + reCAPTCHA + Gravity SMTP | ✅ The forms adapter is Gravity Forms (proved in spike 3) |
| Events | The Events Calendar | **TEC 6.14 + Pro 7.6 + Filter Bar installed, but the theme never uses them.** The theme has its own `events` post type | ⚠️ Target the framework's `events` type, not TEC (§5). TEC's `/events/` archive renders with the TT2 block header |
| Search (PDF) | PDF-indexing search plugin | **Ajax Search Pro 4.27** in the header; the theme's `posts_search` filter searches extra meta | ⚠️ Check in M1 whether Ajax Search Pro indexes PDF text in this install. If not, use the PLAN §6.5 fallback |
| Redirects | Redirection | **Redirection 5.5** | ✅ Import there |
| SEO | — | **Yoast SEO 24.0** | Bridge endpoint (M1) to write `_yoast_wpseo_title` / `_yoast_wpseo_metadesc`, stored natively |
| Page builder | — | Kadence Blocks + Pro (unused by the theme). Content is core and ACF blocks | Emit core blocks |
| Other | — | FileBird Pro (media folders), GTranslate, Accessibility Checker (useful for QA), Broken Link Checker, Block Visibility, **Disable Unused Block Editor Blocks** (option `dubeb_disabled_blocks`), Yoast Duplicate Post, WP All Import Pro + ACF add-on, Admin Columns Pro, Admin Menu Editor Pro, Planeteria SSO, AltText.ai, BugHerd | Preflight must read `dubeb_disabled_blocks` on the real seed. A block we emit that's disabled there would not be editable |

## 4. The framework's content model (from template usage)

Nothing is registered in code: there's no `register_post_type`, no `acf-json`, and no local field groups. The definitions are ACF UI items in the database. Below is what the templates expect.

| Post type | Purpose | Key fields (types inferred) | Taxonomies | Single / listing |
|---|---|---|---|---|
| `post` (labelled "News") | News | `related_forms`, `more_sidebar_content`; featured image | `category` (+ term `category_color`), `post_tag` | `single.php` / page template **News** |
| `events` | Events **and meetings**: a meeting is an event with the `meeting_event_type` term "Meetings" | `meeting_date_and_start_time` (date_time), `meeting_end_time` (time), `was_this_meeting_cancelled`, `location_name`, `location_address` (**google_map**), `zoom_link`, `live_stream_link`, `summary_desc`, `agenda_link` / `agenda_packet_link` / `meeting_minutes_link` (link), `agenda_packet` / `agenda_summary_pdf` / `meeting_minutes` / `meeting_presentation` (file), `meeting_video_link`, `supplemental_downloads` (repeater), `multi-day` + `dates_&_times`, `agenda_items` / `minutes_items` (nested repeaters) | `event_type`, `meeting_event_type` | `single-events.php` / **Events** template; homepage feed |
| `meetings` | Second meeting model | Similar fields, but with **type conflicts**: `location_address`, `agenda_link` and `agenda_packet` are used as different types in different files. Also `paper_agenda`, `other_documents`, `select_a_person` | `meeting_type` | **No single template** (falls back to `single.php`) / **Meetings** template + "Meeting Type" block |
| `people` | Staff and contacts | `first_name`, `last_name`, `title`, `phone`, `email`, `fax`, `department` (→ departments), `address` (google_map), `biography`; featured image = headshot | — | No single template. Shown through Contact Cards, Modal/Expandable Image Grid and the department page |
| `resource_library` | Documents and resources | `publication_date`, `resource_summary`, `files_for_download` (repeater of `link_label`, `file`), `choose_link_type` + `site_page_link` / `external_content_links`, `related_depts` | `resource_type` (terms `form`, `application` drive the Forms directory) | `single-resource_library.php` / **Document Directory**, **Forms & Application** |
| `attachment` | Library documents without a wrapper post | `index_for_library` (=1), `publication_date`, `related_depts` | `resource_type`, `post_tag` | Listed by the Document/Forms directories |
| `departments` | Departments | `overview`, `dept_image`, `department_main_contact_info` group (phones, hours, address, director → people), social links, featured services/programs/FAQs/resources/staff/news | `category` | `single-departments.php` / **Department Directory** |
| `faqs` | FAQs | title/content (+ `question`, `answer`), `department` | — | Search "Featured Answer", FAQ block |
| `alert` | Site alerts | `alert_text`, `display_location` group, `alert_link`, `expiration_date` | — | Header bar |
| `page` | Pages | `is_this_a_program_or_services_page`, `administering_department`, `contact_person`, `featured forms` (name contains a space), `service_in_forms_directory`, `select_sub_navigation`, `more_sidebar_content`, `featured_youtube_video` | — | `page.php` + page templates |
| City-only types | `projects`, `parks_facilities`, `facilities`, `business_dir`, `municipalities`, `route_alert` | — | `amenities`, `rentals`, `park_facility_*`, `project_*`, `region`, `business_category` | Not relevant to JHA; leave them out of plans |

**Page templates** (set on pages via the REST `template` field): Homepage, News, Events, Meetings, Document Directory, Forms & Application, Department Directory, Service Directory, Business Directory, Recreation, Parks & Facilities, Facilities, Parks Projects.

**Homepage** (`template-home.php`): the editor is **hidden** for it (`functions.php:1694`). The homepage is built entirely from ACF fields on the front page:
- `banner` repeater (image, title, logo, link)
- `banner_icon` repeater (icon + link, i.e. quick links)
- featured programs repeater
- departments repeater
- counters
- `news_list` / `events_list` (relationships, with latest-3/next-4 fallbacks)
- sign-up block

The "Connect with us" section is hard-coded lorem ipsum. The editor is also hidden on the News, Events, Documents, Department and Service Directory templates.

## 5. Mapping our preset content model (PLAN §6.4) to the framework

Rule: target the framework's types and field names. Create nothing new unless nothing fits.

| Preset | Target in the framework | Field mapping | Gaps / decisions |
|---|---|---|---|
| **News** | `post` + `category` | date, featured image, category → core | None. The listing page uses the **News** template. Don't set `page_for_posts` (that would route to the parent's block `home` template) |
| **Events** | `events` (**not** TEC) + `event_type` | start → `meeting_date_and_start_time`; end → `meeting_end_time` (time only); multi-day → `multi-day` + `dates_&_times`; venue → `location_name` (+ `location_address` google_map); link → `zoom_link` / `live_stream_link` | Venue address needs to be split into google_map parts (no geocoding without a Maps key; keep `address` + parts, flag it). TEC stays installed and unused. Check the slug clash with TEC's `/events/` on the real seed |
| **Board meetings** | **Provisional: `events` + `meeting_event_type` = "Meetings"**. This model has a complete single template (agenda, packet, minutes, presentation, video, supplemental downloads); the spike wrote and rendered one | date/time → `meeting_date_and_start_time` / `meeting_end_time`; agenda → `agenda_packet` (file) or `agenda_link`; minutes → `meeting_minutes` / `meeting_minutes_link`; packet → `agenda_packet`; recording → `meeting_video_link`; status → `was_this_meeting_cancelled`; location → `location_name` (+ `custom_meeting_address_`); extra files → `supplemental_downloads` | **Decide once we have the seed DB:** the **Meetings** listing template and "Meeting Type" block list the separate `meetings` type, which has no single template and inconsistent field types. Kind (regular/special/hearing) and committee → `event_type` terms (no dedicated field) |
| **Board members** | `people` | name → `first_name` / `last_name`; role → `title`; photo → featured image; bio → `biography` | No `term` field and no single template. Shown on a "Board of Commissioners" page with a Modal Image Grid / Contact Cards block that selects the people. Term dates need a small extra field group (stored natively), which isn't displayed until the theme shows it |
| **Documents** | **Attachments** with `index_for_library=1` (+ `publication_date`, `resource_type`, `related_depts`) for single-file documents, with no wrapper post. **`resource_library`** posts for multi-file or external resources | file → attachment / `files_for_download`; type → `resource_type`; department → `related_depts`; date → `publication_date` | Changes PLAN §6.5's "each document becomes a `document` post": the framework's library already lists attachments directly. Language and extracted text need an extra field group (search) |
| **Forms** | Gravity Forms, plus the forms directory (`resource_type` = form/application, or a page with `service_in_forms_directory=1`) | Neutral spec → GF form via the bridge; `gravityforms/form` block in content | PDF forms are documents with `resource_type=form` |
| **Quick links** | Homepage `banner_icon` repeater, plus the Buttons List / Icon Button blocks on pages. External portals → `resource_library` with `choose_link_type=external` | — | **No `resource_link` type needed** |
| Extra (inference) | `departments`, `faqs` and `alert` exist and fit public-sector content directly | — | Properties/communities, procurement and careers have no framework type. Create them via ACF if the inventory finds ≥3 similar pages. They would render with `single.php` (body content only) until the team adds templates |

## 6. Recommended template strategy (PLAN §6.7, classic/hybrid path)

| Area | How the tool does it | Mechanism |
|---|---|---|
| Content | Gutenberg core blocks, plus the framework's ACF blocks where they fit (e.g. Buttons List for button grids) | core REST |
| Page templates | Set `template` on listing pages (`template-news.php`, `template-events.php`, `template-meetings.php`, `template-documents.php`, `template-forms.php`, `template-department.php`) and the homepage (`template-home.php`) | core REST `template` field |
| Homepage | Fill `template-home.php`'s ACF fields from the source homepage: hero → `banner`, quick-link tiles → `banner_icon`, featured items → featured programs, latest news/events → relationships. Replaces PLAN's "homepage patterns" for this framework | REST `acf` |
| Colours, heading sizes | Write the Theme Settings options (`primary_color` …, `h1_font_size` …) | **Bridge endpoint** (ACF options aren't in REST). It stores options natively, then calls `generate_options_css()` |
| CSS file caveat | `generate_options_css()` writes into the theme directory, which is read-only on Pantheon test/live and on dev unless in SFTP mode. **Also write the same `:root` variables to the site's Global Styles custom CSS** (DB-stored, works on every environment). Test which one wins in M3 | `/wp/v2/global-styles/{id}` |
| Fonts | No option exists, so override the hard-coded Open Sans/Ubuntu with Global Styles custom CSS plus Font Library fonts (self-hosted). Expect `!important` fights | Font Library REST + global styles |
| Logo, site title | `site_logo` + `blogname` via `/wp/v2/settings`. **Needs theme change T1** to be displayed | core REST |
| Header/footer navigation | Create the named menus **"Main Menu", "Top Menu", "Explore Menu", "Footer Menu", "Social Menu"** with items. Menu-item `description` = Font Awesome class; `classes` for mega-menu columns | `/wp/v2/menus`, `/wp/v2/menu-items` |
| Footer contact | `footer_*` options (address/email/phone/fax, headings, icons) | Bridge options endpoint |
| Alert bar | `alert` posts (only if the source has one) | REST |
| Archives / blog index | Keep them out of nav and sitemaps. CPTs get `has_archive: false`. **Needs theme change T3** to look right | — |
| Patterns | Save ours as `wp_block` patterns. Don't use the theme's `advgb` patterns | `/wp/v2/blocks` |

**Theme code changes the team needs to make.** The tool never edits theme code, and these block a fully branded result:

| # | Change | Why |
|---|---|---|
| T1 | Header/footer logo: use `the_custom_logo()` or `get_field('logo_name','option')`, and replace the hard-coded "CITY NAME / State" with `bloginfo('name')` or an option | Otherwise every page shows the framework's placeholder logo and text |
| T2 | Homepage "Connect with us": replace the hard-coded lorem ipsum (`template-home.php:566-672`) with fields or remove it | Placeholder text on the live homepage |
| T3 | Add `index.php` (and optionally `archive.php`) to the child theme using `get_header()` / `get_footer()`, and make Events Calendar views use them (TEC setting "Events template" or a child-theme override) | Archives, the blog index and **all event pages** (`/events/`, `/event/…`) currently use TT2's block header/footer |
| T4 | Guard `acf_clear_cache()` with `function_exists('pantheon_wp_clear_edge_all')` (`functions.php:1929`) | Fatal error on any non-Pantheon environment without the Pantheon mu-plugin |
| T5 | Brand fonts: add a font option or switch `custom.css` to CSS variables | Fonts are hard-coded, so the brand needs a CSS override until then |
| T6 | ~~Pick one meeting model~~. **Resolved by the seed DB:** meetings are Events Calendar events. Instead: remove or ignore the unused `events`/`meetings` templates, and make Events Calendar views use the framework header/footer (see T3) | Leftover city-framework templates |
| T7 | Remove or replace patterns that use `advgb/*` and `acf/how-to-*` | They're broken in the editor |

## 7. Blockers and risks

1. ~~**Seed database needed (blocks M1).**~~ **Resolved:** the database was provided and imported (§0). The CPTs, taxonomies, field groups (with keys), options, menus and pages (e.g. post 342) exist only in the seed's DB. The local seed recreates what M0 needed from template usage. The spike hit a wrong guess (`location_address` is a google_map, not text) that crashed the framework's template. **Need either** a DB export of the seed (Pantheon backup) **or** ACF → Tools → Export (field groups + post types + taxonomies) JSON and a list of menus/options. In M1 the bridge's `GET /website-mover/v1/schema` reads the real definitions from the hosted seed.
2. **Secrets committed in the seed codebase** (seen while reading; not copied anywhere):
   - a Pantheon **Terminus machine token** in `.ddev/config.yaml`
   - `PSSO_JWT_SECRET` in `plugins/planeteria-sso/planeteria-sso.php`
   - Smash Balloon encryption keys in `wp-config.php`
   - a Google Maps API key in `functions.php:732` and `footer.php:99`
   
   The Terminus token should be rotated. `e2e/seed/setup.sh` excludes `.ddev` from the local copy.
3. **City framework fork.** Half the types and templates are city-specific (parks, projects, business directory, recreation header keyed to page 36026). Plans for JHA should list only the types in §5.
4. **CSS regeneration on Pantheon** (§6): design changes made by the tool may not reach the CSS file on test/live.
5. **Block allowlist.** "Disable Unused Block Editor Blocks" may disable core blocks we emit (`core/details`, `core/cover`, `core/embed`). Preflight reads `dubeb_disabled_blocks`.
6. **TEC vs `events`.** Both want `/events/`. Confirm the seed's rewrite slugs.
