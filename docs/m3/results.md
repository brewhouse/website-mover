# M3 results: site structure (2026-10-14)

**Result: part 1 (site structure) PASSES on the local seed. Part 2 (branding) is waiting on the JHA style guide PDF.**

- **Pipeline:** scan → extract → analyze → plan → approve → execute → report.
- **Plan:** v11, approved as "local trial run, not a client approval".
- **Seed setup:** the same local seed as M2: the seed DB with its own plugin and block settings, and Redirection switched on.

## What was built

| Element | Result |
|---|---|
| Site title | "Jacksonville Housing" (the title segment every source page shares) |
| Main Menu | 41 items: the 6 top-level sections and their dropdowns. Links to migrated pages point at the page itself, so they follow slug changes |
| Top Menu | 6 items: Home, Calendar (→ The Events Calendar's `/events/`), News (→ the framework's News page), Procurement, E-Procurement, Rent Café |
| Footer Menu | 1 item: Accessibility |
| Social Menu | Facebook and YouTube, with the source's labels ("Like us on Facebook", "Follow our YouTube Channel") |
| Explore Menu | 7 industry links (CDC … SERC-NAHRO). The seed had no Explore Menu, although its footer uses one, so the tool created it |
| Footer contact | The source's address and phone. The seed's "City Hall" heading is cleared. Email and fax are cleared together with their headings and icons, because the source has neither and the footer would otherwise show empty "Email:" and "Fax:" rows |
| Homepage slides | 3 of the source's 4 slides, each with its image, title and link. The template allows at most 3 slides, so "Neighborhood Network Centers" is left out and reported |
| Homepage quick links | "View Our Full Calendar" → `/events/`, from the tile under the source's slideshow |
| Homepage demo content | Cleared: "Placeholder Link" tiles, "Entry or Item Title" featured programs, departments, counters, the sign-up block and the hand-picked demo news. With no hand-picked news, the template shows the 3 latest posts, as the source homepage does |

All migrated content still verifies:

| Type | Planned | Created | Failed | Live (200) | Block problems |
|---|---|---|---|---|---|
| Pages | 89 | 89 | 0 | 89 | 0 |
| News posts | 256 | 256 | 0 | 256 | 0 |
| Events | 244 | 244 | 0 | 244 | 0 |
| People | 10 | 10 | 0 | 10 | 0 |
| Forms | 5 | 5 | 0 | 5 | 0 |
| Community entries | 29 | 29 | 0 | 29 | 0 |
| Documents | 335 | 335 | 0 | 335 | 0 |
| Images | 144 | 144 | 0 | 144 | 0 |

- **Redirects:** 1,165, and all of them answer 301 to the right page.
- **Re-runs:** they update in place. The menus are replaced as a whole.
- **Front end:** checked in a browser at 1440 px: the homepage (slides, quick link, latest news) and the footer (Contact Us: address and phone only).

## Problems found while running, and fixes

| Problem | Fix |
|---|---|
| The homepage template takes at most 3 slides. The source has 4, and ACF rejected the whole update | The executor reads row limits from the seed's field definitions. It keeps the slides that fit and reports the rest by name |
| The homepage template's other fields held the seed's demo placeholders | Planned as "clear the template's other fields" (`home.clearOthers`). The source's own tile fills the quick links |
| ACF's REST check rejects an empty list for a relationship field. It can't empty a repeater that requires rows (quick links require at least 1) | Relationship and image fields are cleared with `null`, and optional repeaters with an empty list. A required field the source has nothing for is left as it is and reported, so an editor can fill it in |
| The footer showed the seed's "City Hall" heading and empty "Email:" and "Fax:" rows | Where the source has no value, the heading and icon are cleared together with the value. The footer hides a row when all three are empty |

## Left for the theme team

These add to T1–T9 (`docs/m0/framework-assessment.md` §6 and `docs/m3/design.md`). T1 still matters most: the header shows the placeholder "CITY NAME / State" over the main menu, and the logo isn't the JHA logo.

| # | Change | Why |
|---|---|---|
| T10 | Social Menu: show the platform's icon, and keep the link text for screen readers | The footer's social circles are sized for an icon, so "Like us on Facebook" overflows them. The seed's demo items were set up for the Menu Image plugin, but that plugin is inactive. Its "hide title" option also uses `display: none`, which would leave the link with no accessible name |
| T11 | Homepage "Connect with us": drive it from fields or the Social Menu, or let an editor turn it off | The section is hard-coded in `template-home.php`: four "This is the Title" lorem cards with theme images. No field controls it, so the tool can't clear it |
| T12 | Homepage upcoming events: query The Events Calendar | The template's fallback reads a framework `events` post type, which the seed doesn't have. The source homepage doesn't list events either, so this matters only if JHA wants them there |

## Next

1. **Branding (part 2):** run style guide extraction on the PDF when it arrives. Then map colours and heading sizes to the Theme Settings options, mirror them into Global Styles CSS, and add fonts and the logo (`docs/m3/design.md` §2).
2. **Hosted seed:** the M1–M3 runs need the bridge installed in the seed's Pantheon codebase and Redirection activated.
3. **M4:** the review UI (PLAN §10).
