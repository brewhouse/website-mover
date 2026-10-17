# M3 branding results (2026-10-16)

**Result: branding PASSES on the local seed, with theme patches T17–T21 applied there.** The hosted seed needs the patches pushed first (`docs/theme-patches.md`), then a re-plan.

## Local run

- **Brand:** `wm brand` on `inputs/jha/style-guide/brand.json`: 46 theme values, 2 fonts (Montserrat 500/600/700; Open Sans 400/600/700 with italics: 9 files), 2 logos.
- **Plan:** v25 of job `jha`, approved as "Claude (local test approval, not a client approval)". The Design section lists every value with its evidence. Contrast: 25 of 25 checks pass.
- **Execute:** 1,112 objects, 0 failures. Design: 46 variables in Global Styles custom CSS, 9 font files through the Font Library, both logos.

| Check | Result |
|---|---|
| Fonts | Self-hosted from the site's `uploads/fonts`. Headings and menus in Montserrat, paragraphs in Open Sans 16/24 px. The theme's Google Fonts link is off |
| Logos | Header: the colour logo, no repeated site name. Footer: the reversed logo on the footer's blue |
| Footer | "Industry Links" band, the phone with "P", hours on two lines, the three notice icons, the first notice's bold heading, phone links in the notices, the navy bottom bar |
| QA stage | 30 pages at 375, 768 and 1280 px: 0 accessibility rules violated, no sideways scrolling |
| Keyboard focus | Tabbing through the homepage, About Us, News and Events at 375 and 1280 px reaches no control without a visible focus outline (purple `#C942FF`) |
| Contrast | 25 of 25 pairs pass WCAG 2.1 AA with the brand's values |
| Review | The web app's Design tab shows the swatches, values and evidence, fonts, both logos (the footer one on the footer colour), the checks and the deviations |

## Theme patches, checked on the local seed

- **Header:** at 375, 1024, 1200, 1280, 1366, 1440 and 1920 px, with and without the brand: no overlap, no sideways scrolling. The mobile menu (375, 1024) stacks the green and navy bars under the menu. The search opens in place on desktop and full width in the mobile menu.
- **Alert bar:** with a test alert, it sits between the header and the page on every width, and closing it removes the bar. Without alerts, nothing is printed (it was an empty band, and phones kept 75 px for it).
- **Footer:** at 375, 1024 and 1440 px, with and without the brand. Without the brand the theme's own colours apply.
- **PHP:** no warnings on the 54 sample pages; each file lints.
- **SCSS:** `custom.scss` and `responsive.scss` compile with Sass 1.77 to the same rule changes as the hand-edited CSS, for each patch.
- **Patches:** 0019–0023 apply with `git am` to Pantheon's `master` (`8c8bb792f`, read 2026-10-16).

## Rollback, on a throwaway job

Job `rb-brand` (the fixture site in `e2e/fixtures/small-site`) ran after `jha` on the local seed with a deliberately different brand: another primary colour, an extra font (Lato) and the logos swapped. Rolling it back:
- removed its CSS block and put JHA's back;
- deleted Lato (installed by the job) and left Montserrat and Open Sans (installed before);
- restored `site_logo`, the footer logo and the theme options;
- deleted its logo files with its other files.

The design state then matched a snapshot taken before the job: CSS block, logo setting, options, font families and their faces, menus. Rollback reported 0 problems.

## Problems found while running, and fixes

| Problem | Fix |
|---|---|
| The Font Library's list ignores a `slug` filter, so the second font's faces went into the first family | Families are matched on their settings' slug |
| Its faces list returns every family's faces | Faces are filtered by their family; rollback would otherwise have deleted other families' faces |
| Rolling back a job would have deleted an earlier job's brand CSS instead of restoring it | The snapshot records the block as it was; rollback puts it back |
| The theme loaded Open Sans and Ubuntu from Google on every page | T21: a Theme Settings option; the tool turns it off when it installs the brand's fonts |
| The guide's body text (16/150%) had no variable | T21: `--pw-text-size`, `--pw-text-line-height` |
| The footer band's link colours fell back to the wrong theme defaults | Fixed in T19 |
| Code review (11 findings, all fixed): options set before the fonts and logo they depend on; Google fonts off with only one font role replaced; Font Library lists not paginated; a failed re-import deleting the previous brand; a classic theme's missing Global Styles stopping the whole migration; token names like `toString`; an edited `brand.json` not caught; rollback deleting font faces an editor added; menus a later plan adds missing from the snapshot | Fixed; the rollback test above was re-run after the fixes |
| On tablets the translate icon sat over the top menu, and the stacked bars ran 15 px past the screen edge | Fixed in T18 |

## Not changed

- **Plugins that still call Google:** Ajax Search Pro prints `@font-face` rules for Open Sans from Google for its search box, and a third-party frame loads Inter. Both are plugin settings, not the theme.
- **`header-recreation.php`:** the city framework's header for pages under a "Recreation" page (trashed on this seed) keeps the old layout.
