# M3 part 2: branding from the JHA style guide

The style guide is a Figma prototype, not a PDF: "Style Guide_JHA" (two pages), linked by Rohit on 2026-10-16. Page 1 has the header and footer mockups, text styles, buttons, forms and colours; page 2 has the typography system. The client inputs are gitignored:
- `inputs/jha/style-guide/link.md`: the link;
- `inputs/jha/style-guide/brand.json`: the guide transcribed for the tool;
- `inputs/jha/logos/`: the logo.

Results: `docs/m3/branding-results.md`.

## Decisions (Rohit, 2026-10-16)

- **Body font: Open Sans.** Page 1's text styles say Inter; page 2's typography spec says Open Sans. Page 2 is the newer, more detailed spec, so it wins wherever the pages differ: headings follow its scale (Display 48 → H1 … S 14 → H6).
- **Scope: tokens plus header and footer.**
  - The tool sets colours, fonts, sizes, buttons, form fields, focus and the logos, without a code deploy.
  - Theme patches rebuild the header and footer like the guide's mockups (T18, T19).
- **Logo: from the Figma file.** The file has one logo image: 1254 px, on a white square. The tool's inputs are cleaned-up versions of it:
  - `logo-color.png`: white removed, margins trimmed;
  - `logo-reversed.png`: navy parts white, greens kept, as the guide's footer shows;
  - `logo-figma-original.png`: the image as Figma has it.

## How the guide reaches the site

The PDF pipeline (PLAN §6.8: deterministic facts, the model, then a cross-check) needs text to check against, and a Figma prototype has none. For a guide like this, a person transcribes it into a **brand file**, and the plan's Design section shows every value with where the guide states it, so approving the plan checks them.

```
wm brand --job jha --file inputs/jha/style-guide/brand.json   checks it; copies it, its logos and its fonts into the job
wm plan  --job jha …                                           the Design section, with contrast checks
wm approve … ; wm execute …                                    logos, fonts, the brand CSS
```

| Layer | What | Where |
|---|---|---|
| Theme (patches T17–T21) | Exposes roles as CSS variables (`--pw-color-*`, `--pw-font-*`, sizes, buttons), with the theme's own values as defaults. Rebuilds the header and footer | Theme code, applied by the team (`docs/theme-patches.md`) |
| Tool | Fills the variables from the brand, installs the fonts, sets the logos and two theme options | Global Styles custom CSS (in the database, so it works on Pantheon test and live, where theme files can't be written), the Font Library, `site_logo`, theme options |

### The brand file (`website-mover/brand@1`)

| Part | What |
|---|---|
| `guide` | Title, link, who transcribed it and when |
| `tokens` | The guide's values by name (`primary`, `darkGreen`, `h1Size`), each with `evidence`: where the guide states it |
| `fonts` | Families and weights to install, with evidence |
| `theme` | The theme's variables (without `--pw-`), each a token name or a CSS value. A value that isn't the guide's obvious one says `why` |
| `logos` | Header and footer files, whether the logo shows the name, evidence |
| `deviations` | Where the site knowingly differs from the guide, and why |

The tool refuses a file with a variable the theme doesn't have, an unknown token, a value of the wrong kind (only `#RRGGBB`, lengths, letter cases, weights and font stacks of the brand's own fonts pass, so nothing can break out of the CSS) or a font it doesn't install.

### What the tool does

- **`wm brand`** copies the file, its logos and its fonts into `data/jobs/<id>/inputs/brand/` with a manifest of sha256s. Fonts are the files WordPress's own Font Library installs: its Google Fonts collection (one woff2 per weight and style). The plan records the manifest's hash; execution refuses files that changed after approval.
- **Plan:** the Design section (plan Markdown and the review's **Design** tab): each variable with its value, token and evidence; fonts; logos; contrast checks; deviations. A failing check is a plan warning.
- **Contrast checks:** 25 pairs where the theme puts text or outlines on a colour the brand sets (buttons, header bars, menus, breadcrumb, alert, footer, focus outline, field borders), against WCAG 2.1 AA: 4.5:1 for text, 3:1 for large text (bold from 18.66 px, any from 24 px), focus outlines and field borders. Pairs the brand doesn't touch are left out.
- **Execute** (after the site structure):
  - logos into the media library (tagged with the job), `site_logo`, and the theme's footer logo option;
  - fonts through the Font Library (an installed family or face is reused);
  - the brand CSS in Global Styles custom CSS: `@font-face` rules for the installed files, then `:root { --pw-…: … }`. The tool owns one marked block there; CSS an editor adds outside it stays;
  - theme options, last: the header doesn't repeat the site name next to the brand's logo (`header_show_site_name`), and the theme's Google Fonts link goes off (`theme_google_fonts`, T21) when the brand sets both font roles and every font file is installed and in the CSS. A failed logo or font leaves the option alone.
- **Rollback** restores the logo settings and options, puts the CSS block back as it was before the job (an earlier job's, or none), deletes the font families the job created, and in families that were already there deletes only the faces the plan installed.
- **Re-importing** builds the new import next to the old one and swaps it in at the end: a failed `wm brand` leaves the previous brand in place. The plan stage refuses a `brand.json` edited after import.

## Tokens (from the guide)

| Role | Value | Guide |
|---|---|---|
| Primary (navy) | `#022B58` | Colors, Theme / Brand: Primary |
| Primary hover | `#003C80` | Dark Blue, "Hover" |
| Secondary (green) | `#468928` | Secondary, "Accent" |
| Secondary hover | `#295B13` | Dark Green, "Hover" |
| Tertiary (blue) | `#1F5FA8` | Tertiary |
| Quaternary | `#8FB8E8` | Quaternary |
| Backgrounds | navy `#002A58`, gray `#F1F4F9`, white, blue tint `#E8EFF7`, green tint `#EAF3E5` | Theme / Background |
| Text | `#1A1A1A`, secondary `#4A4A4A`, on dark `#A3DFFF` | Theme / Text |
| Borders | input `#767676`, divider `#D0D5DB`, input on dark `#8FB8E8` | Border |
| Focus | `#C942FF`, 2 px outer outline | Focus Purple; button and field focus states |
| Error | `#D50000` (field border), `#990000` | Utility / Semantic |
| Headings | Montserrat. Display/H1 48 Bold, H2 32 Bold, H3 24 Bold, H4 20 SemiBold, H5 18 SemiBold, H6 14 SemiBold. H1–H3 `#022B58`, H4–H5 `#1A1A1A`, H6 `#4A4A4A` | Page 2 heading styles; colours from page 1 |
| Body | Open Sans Regular 16/150%; large 18/155%; small 14/140% | Page 2 paragraph styles |
| Navigation | Montserrat: main nav Bold 18, menu SemiBold 18, utility Medium 16, breadcrumbs SemiBold 16 | Page 2 navigation |
| Buttons | Montserrat Bold 16, 44 px high, square corners. Primary green, hover dark green, pressed `#18320D`. Secondary blue `#1F5FA8`, hover `#094E9C`, pressed `#003C80` | Page 1 button styles |

## Where the guide fails WCAG 2.1 AA, and what the site does instead

Public housing sites must meet WCAG 2.1 AA (ADA Title II). Four of the guide's combinations don't. The site keeps the guide's look and passes:

| Guide | Contrast | Site |
|---|---|---|
| Primary button: white Bold 16 on green `#468928` | 4.31:1 (needs 4.5) | On `#3F7D24`, a shade darker (5.0:1); hover `#295B13` as in the guide |
| Green text on white ("View All News", event details) | 4.31:1 | `#3F7D24` (5.0:1) |
| Header top bar: white Medium 16 on `#468928` | 4.31:1 | On `#3F7D24` (5.0:1) |
| Footer links on hover: `#A3DFFF` on the footer's blue `#1F5FA8` | 4.46:1 | White; hover removes the underline |

The guide's `#468928` stays where nothing is read on it: the footer's lines. These are values in the brand file, so JHA's designer can change them; the plan's contrast checks show the effect.

## Header and footer (theme patches)

**Header (T18), from the guide's mockup:**
- **Top bar, left (green):** translate, the phone number, and an optional Utility Menu.
- **Top bar, right (navy):** the Top Menu, search, and the social icons.
- **Main bar (white):** the logo and the main menu.
- **Below:** a breadcrumb band in blue tint.
- **Alert bar:** printed only when an alert applies, between the header and the page. It was an empty yellow band on every page.

**Footer (T19), from the mockup and jaxha.org's own footer:**
- an "Industry Links" band (the Explore Menu, with the source's heading) in blue tint;
- the main footer in blue: the reversed logo, the phone ("P"), a Footer Contact Menu, and the office hours on two lines as the source shows them;
- the notices with the equal-housing, wheelchair and accessibility icons, the first one's bold opening as its heading;
- a navy bottom bar with "© 2026 Jacksonville Housing", the Footer Menu and the address.

The analysis reads these from jaxha.org: the band heading, the icons' alt text (mapped to the theme's icons), the staff link, the hours' line break, and the notices' bold opening and phone links.

## Open questions for JHA

- **Staff Module:** jaxha.org's footer links it to `/staff-pages`, the CMS's staff area, which isn't in the scan and isn't migrated. The plan leaves it out and says so. Where should it point after the move? It goes in the Footer Contact Menu.
- **Site Map:** the footer's "Site Map" (`/site-map`) is the CMS's generated page, also not migrated. WordPress can list pages with a block on a "Site Map" page if JHA wants one.
- **Help Center:** the header mockup has a "Help Center" link in the green bar. jaxha.org's header doesn't, so the Utility Menu stays empty until JHA says where it goes.
- **The two body fonts:** confirm Open Sans; page 1 says Inter.
- **The two H1 sizes:** confirm Display 48; page 1 says 32.
- **The contrast changes above,** and the alert bar colour (the guide has none; the plan uses its dark error red).
