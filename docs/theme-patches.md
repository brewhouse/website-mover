# Theme patches for the team: T1–T16 (2026-10-14), T17–T21 (2026-10-16)

The theme changes from M0–M5 (`docs/m0/framework-assessment.md` §6, `docs/m3/design.md`, `docs/m5/results.md`) are written as a patch series for PlaneteriaWeb in the JHA seed repo. Nothing has been pushed: a push to that repo deploys to Pantheon, so the team reviews and applies them. They were tested on a local copy of the seed with JHA's migrated content.

## Applying them

- **Patches:** `dist/theme-patches/patches/0001-…0017-*.patch` (also zipped as `dist/theme-patches/jha-theme-patches.zip`), made with `git format-patch`. 0001–0016 are the theme changes, one per change; 0017 updates the bridge plugin in the repo to 0.1.1. `dist/` is gitignored; the patches are framework code and stay out of this repo.
- **Base:** commit `7dc39a56c` ("Add Website Mover Bridge") on the seed repo's `master`.
- **Apply:** in a clone of the Pantheon repo, run `git am path/to/patches/*.patch`. All 17 apply cleanly to the base, which is still Pantheon's `master` (checked 2026-10-14). If `master` has moved on, `git am -3` resolves most context changes. Pushing `master` deploys to dev.
- **Changed:** 26 theme files, only in `wp-content/themes/planeteriaweb`, and the bridge plugin's 3 files. New files are `inc/site-setup.php`, `index.php` and `inc/templates/events.php`. Five broken patterns and three unused templates are deleted.
- **Bridge 0.1.1:** patch 0017 (the same code as `dist/website-mover-bridge.zip`). It adds two things:
  - an endpoint that reads and writes a page's ACF fields. The tool uses it to clear the News page's demo sign-up box, whose field group is switched off, so REST can't reach it;
  - a guard against re-saving a field group that's defined in PHP.

  With 0.1.0 the migration still runs; the run reports that the News page wasn't cleared.

## The changes

| # | Patch | What changes |
|---|---|---|
| T4 | 0001 | Saving any ACF field no longer fatals off Pantheon: `pantheon_wp_clear_edge_all()` runs only when the cache plugin provides it |
| T1 | 0002 | **Header and footer.** The logo comes from Appearance → Site Identity (or the Site Logo block), with the theme's image as the fallback. The footer can have its own logo (Footer options). The site title and tagline replace "CITY NAME / State"; a Header option hides them when the logo already has the name. Alt text is the site name, not "logo". On desktop the logo now sits beside the menu instead of on top of it ("About Us" was covered). The page title comes from WordPress/Yoast, with the site name added when the seed's Yoast templates leave it out |
| — | 0003 | The theme's stylesheets carry their file time as `?ver=`, so CSS changes reach browsers and the CDN straight away |
| T2, T11 | 0004 | The hard-coded "Connect with us" section (lorem ipsum, "#TAG", "#" links) is off. A filter turns it back on for a real feed |
| T3 | 0005 | **Archives and event pages use the theme's header and footer.** Twenty Twenty-Two, the parent, is a block theme, so category, tag, date and author archives and every Events Calendar page used its block templates, header and footer. New `index.php` and an Events Calendar wrapper replace them |
| T5 | 0006 | **Fonts** go through two CSS variables: `--pw-font-heading` (Ubuntu) and `--pw-font-text` (Open Sans). The brand fonts are one line of custom CSS |
| T6 | 0007 | Removes the city framework's `events`/`meetings` templates. Meetings are Events Calendar events here |
| T7 | 0008 | Removes 5 patterns built from blocks the site doesn't have (`advgb/*`, `acf/how-to-*`) |
| T8 | 0009 | **Footer:** "Office hours" (under Contact Us) and "Notices" (fair-housing and HUD statements, above the copyright) on the Footer options page. The contact list no longer prints empty icons or headings |
| T9 | 0010 | **Homepage:** an "Introduction" field under the slideshow, for the mission statement |
| T10 | 0011 | **Footer social links** show the theme's own Facebook, YouTube, Instagram, LinkedIn and X icons, with the link text kept for screen readers. They had shown their text overflowing a 42px circle |
| T12 | 0012 | **Homepage "Upcoming Events"** comes from The Events Calendar. It used to read the unregistered `events` type, so it was always empty |
| T13 | 0013 | **GA4:** a measurement ID field (Theme Settings → Analytics). The tag is printed on the live environment only, so dev and test visits aren't counted |
| T14 | 0014 | "All News" and the news breadcrumb link to the News page. They pointed at `/latest-news/` and `/current-news/`, which are 404 |
| T15 | 0015 | The News and search pages' filter and sort labels point at their controls. This fixes axe `select-name` (critical) |
| T16 | 0016 | **Phones:** no sideways scrolling, and no PHP warnings. Posts without a category printed three PHP warnings on Pantheon dev, which shows warnings on the page. Long URLs and file names in content now wrap, and The Events Calendar's list rows fit. The breadcrumb takes its own space: before, its first line sat behind the band under the header and a long one ran into the page title |

## After applying

1. **Logo:** the header shows the site logo (the `site_logo` setting). The theme counts as a block theme, so WordPress may not list Appearance → Customize → Site Identity. In that case set it with the Site Logo block in Appearance → Editor, or let the tool set it with the branding step (M3). If the logo includes the name, turn off "Show the site name next to the logo" (Theme Settings → Header). A light version for the dark footer can go in Theme Settings → Footer → Footer logo.
2. **Re-run the migration** (a new plan version) with the tool from the `theme-fields` PR. It fills the new fields from jaxha.org, verbatim:
   - office hours and the two notices;
   - the homepage introduction, with links rewritten;
   - the GA4 ID.

   It also clears two placeholders:
   - the seed's tagline ("City Seed Site"), which the header now shows;
   - the News page's demo "Sign up for news & alerts" box (lorem ipsum and a demo form).

   JHA's subscription sign-ups still need a tool.
3. **Yoast (optional):** the seed's title templates for pages, posts and some types end with the separator and leave out `%%sitename%%`, because the old header added the name. The theme adds the name for those titles, so nothing breaks. Adding `%%sitename%%` to those templates in Yoast → Settings is the cleaner fix.
4. **GA4:** the tag appears on the live site only. Before launch, the tool's post-launch check against dev reports it missing; that's expected.

## Tested on the local seed

- **Header:** checked at 375, 800, 1200, 1280, 1366, 1440, 1600 and 1920 px, also with a 30-character site name. No overlap and no sideways scrolling.
- **Titles:** the homepage, pages, posts, archives, events and 404 each have one `<title>`, with the site name once.
- **Templates:**
  - `/events/` list, month, day and past views, single events, category and date archives (with pagination), search and 404 all use the theme's header.
  - A page and a post given a parent block template also use it.
  - Feeds and REST are unchanged.
- **PHP warnings:** with errors displayed (as on Pantheon dev), none from the theme on all 618 migrated pages. Before, 30 of the 54 QA-sampled pages printed them.
- **Phones:** none of the 618 pages scrolls sideways at 375 px. Before, 17 did.
- **QA stage:** the tool's QA on its 30-page sample (WCAG 2.1 A/AA with axe at 375, 768 and 1280 px) finds no rule violations and no sideways scrolling. Before the patches it found 2 rules (`select-name` on the News page, The Events Calendar's `list`) and sideways scrolling on 1–5 pages.
- **Post-launch check (local):** 1,242 of 1,242 legacy URLs answer as planned.
- **Patches:** each commit lints (`php -l`), and the series applies to the base with `git am`.
- **SCSS:** `custom.scss` and `responsive.scss` compile with Sass 1.77. Their rule changes match the hand-edited `custom.css` and `responsive.css` (vendor prefixes aside), so the CSS can be rebuilt from the SCSS.
- **Screenshots:** before and after, at desktop and phone width, in `dist/theme-patches/screenshots/`.

## On Pantheon dev (2026-10-15)

Rohit applied patches 0001–0017: Pantheon `master` is now `f5f3259`. Plan v2 of job `jha-dev` was approved as "Rohit Mehta (approved in chat)" and run.

| Check | Result |
|---|---|
| Migration | 1,112 objects, 0 failures, 1,167 redirects. Filled: office hours, both notices, the homepage introduction and the GA4 ID. Cleared: the tagline and the News page's demo sign-up box |
| QA | 30 pages: 0 accessibility rules violated; 0 pages scrolling sideways at 375 px |
| Links | 1,006 checked; 10 broken, the source's own dial-in links, as before |
| Post-launch | 1,242 of 1,242 legacy URLs OK. GA4 isn't on dev (the tag is live-only) |
| PHP warnings | None on the pages that showed them |
| Rollback | The snapshot now also records the tagline, the new theme options, `home_intro` and the News page's fields |

Patch 0018 (the new theme files exit when requested directly by URL; before, they printed a PHP error with the server path, which dev displays) was applied after this: Pantheon `master` is `8c8bb792f`.

## Branding: T17–T21 (2026-10-16)

The JHA style guide's look (`docs/m3/branding.md`). The theme only gets variables and the new header and footer; the brand's values come from the tool, so the theme keeps its own look until they're set.

**Patches:** `dist/theme-patches/patches/0019-…0023-*.patch` (also zipped as `dist/theme-patches/jha-theme-patches-0019-0023.zip`). They apply with `git am` to Pantheon's `master` (`8c8bb792f`, read 2026-10-16). Screenshots: `dist/theme-patches/screenshots/branding/`, before (Pantheon dev today) and after (the local seed with the patches and the brand), with side-by-side images.

| # | Patch | What changes |
|---|---|---|
| T17 | 0019 | **Colours and heading sizes** go through CSS variables, like the fonts (T5): `--pw-color-primary`, `-secondary`, `-accent`, `-text`, `-muted`, `-surface`, `-link`, `-heading`, `-button`, … and `--pw-h1-size` … `--pw-h6-size`, `--pw-h1-case`. The theme hard-coded its palette (`#202188` 83 times) and never used its own Theme Settings colours |
| T18 | 0020 | **Header** as in the guide: a two-part top bar (translate, phone and an optional Utility Menu on the secondary colour; the Top Menu, search and the Social Menu's icons on the primary), the logo and main menu, a breadcrumb band. Below 1200 px the top bar stacks in the mobile menu and the logo sits in the bar. **The alert bar** is printed only when an alert applies and takes its own space; closing the last alert removes it. It was an empty yellow band on every page |
| T19 | 0021 | **Footer** as in the guide: a links band (the Explore Menu under a heading, new Footer option), the logo with phone, fax, email, an optional Footer Contact Menu and the office hours, the notices in two columns with icons (new Footer option), a bottom bar with the copyright, the Footer Menu and the address. The wave background, the old columns and the footer's social icons are gone |
| T20 | 0022 | **Buttons** take their font, size, weight and corners from variables. **Green text** that needs contrast has its own variable (`--pw-color-secondary-strong`). **Form field borders** have one. **Keyboard focus** is visible on every control: the theme removed it on buttons, form fields, the mobile menu button and the language picker |
| T21 | 0023 | **Fonts:** a Theme Settings option turns off the theme's Google Fonts link (Open Sans, Ubuntu), so a site with its own fonts doesn't call Google on every page. Body text size and line height have variables |

Every variable, its default and what it styles is listed in the tool (`THEME_VARIABLES` in `packages/styleguide/src/brand.ts`).

### After applying

1. **Run the branding step** with the tool:
   - `wm brand --job jha-dev --file inputs/jha/style-guide/brand.json`;
   - a new plan version, reviewed in the Design tab and approved;
   - execute.

   It installs the fonts, sets the logos, writes the brand CSS to Global Styles and sets the new options from jaxha.org: the links band heading ("Industry Links"), the notice icons, the hours on two lines.
2. **Without the brand,** the theme looks as before except for the new header and footer layout, in its own colours.
3. **Plugins:** Ajax Search Pro still loads Open Sans from Google for its search box (its own font setting).

### Tested on the local seed

See `docs/m3/branding-results.md`:
- the header and footer at phone, tablet and desktop widths, with and without the brand;
- the alert bar with a test alert;
- the QA stage on 30 pages (0 accessibility violations, no sideways scrolling);
- keyboard focus on four page types;
- no PHP warnings on 54 pages;
- SCSS parity for each patch;
- `git am` onto Pantheon's `master`.

## Not changed

- **Plugin notices:** the Add Admin CSS plugin raises PHP 8.2 "dynamic property" deprecations. WordPress hides them (WP_DEBUG is off), but the plugin should be updated.
- **Breadcrumbs:** on custom-type single pages the breadcrumb links to "`<Type>` Directory" at the type's slug. That's the framework's behaviour; JHA's types have listing pages there.
- **City framework code:** the `events` post type references in `functions.php`, `search.php` and the General List block are left in place. They're harmless when the type isn't registered.
