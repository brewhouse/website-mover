# M3 design: site structure and branding

M3 has two parts.

1. **Site structure (from the source, built now).** The tool takes these from the current site's shared structure (`wm analyze` → `analyze/site.json`): menus, footer contact details, homepage slides and the site title.
2. **Branding (waits on the JHA style guide PDF).** Colours, heading sizes, fonts and logo come from the style guide (PLAN §6.8).

## 1. Site structure

| Framework element | Built from (jaxha.org) | How |
|---|---|---|
| Site title | The title segment every page shares: "Jacksonville Housing" | `/wp/v2/settings` `title` |
| **Main Menu** | Main navigation: About Us, Public Housing, HCV Program, Residents, Communities, Customer Service Survey, with their dropdowns | Named menu replaced through `/wp/v2/menus` + `/wp/v2/menu-items`. Items link to the migrated object (they follow slug changes), else to a URL |
| **Top Menu** | Utility bar: Home, Calendar, News, Procurement, E-Procurement, Rent Café | Calendar → The Events Calendar's `/events/`; News → the framework's News page |
| **Footer Menu** | Footer links (Accessibility) | |
| **Social Menu** | Facebook, YouTube | |
| **Explore Menu** | "Industry Links": CDC, FAHRO, HDLI, HUD, NAHRO, PHADA, SERC-NAHRO | The seed had no Explore Menu, although `footer.php` uses one; it is created |
| Footer contact (theme options) | Address and phone from the footer. The seed's placeholder email and fax are cleared with their headings and icons, so the footer hides those rows; the demo "City Hall" heading is cleared | Bridge `POST /acf/options`; the framework regenerates its CSS file afterwards |
| Homepage slides (`banner`) | The slideshow slides: title, image, link, and link text from the slide subtitle. The template takes at most 3; the rest are reported | Front page ACF fields over REST, within the row limits in the seed's field definitions |
| Homepage quick links (`banner_icon`) | The tile under the slideshow ("View Our Full Calendar") | Same |
| Homepage demo content | The template's other fields (featured programs, departments, counters, sign-up, hand-picked news) are cleared. A field that requires rows keeps the seed's values and is reported | Same |
| Left out (target not migrated) | Quick Links (empty page), E-News, Sign Up For News, Site Map | Listed in the plan |

## New theme changes for the team

These add to T1–T7 in `docs/m0/framework-assessment.md` §6:

| # | Change | Why |
|---|---|---|
| T8 | Footer: show office hours and the fair-housing / HUD non-discrimination statements (an options field or a footer text area) | jaxha.org shows "Monday – Friday 8 am – 5 pm" and two required fair-housing statements on every page. The framework footer has no place for them |
| T9 | Homepage: a field for the intro/mission text (or show the page content) | `template-home.php` hides the editor and has no field for the mission statement and program intro that jaxha.org's homepage leads with |

T10–T12 (social icons, the hard-coded "Connect with us" section, homepage events) came out of the first run: see `docs/m3/results.md`.

## 2. Branding (when the style guide arrives)

- **Colours and heading sizes:** extracted per PLAN §6.8 (deterministic pass, then `gpt-6-astra` with a cross-check) into the Theme Settings options (`primary_color` … `h6_font_size`) through the same options endpoint. They are mirrored into Global Styles custom CSS, because the framework's generated CSS file can't be written on Pantheon test/live.
- **Fonts:** a CSS override plus the Font Library, since the theme hard-codes Open Sans and Ubuntu.
- **Logo:** `site_logo`. It needs theme change T1 to be displayed.
