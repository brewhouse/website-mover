# M2 results: public-sector content model (2026-10-14)

**Result: PASS on the local seed.** This ran against the seed DB with its own plugin and block settings, with Redirection switched on locally. Pipeline: scan → extract → **analyze** → plan → approve → execute → report. Plan v7 was approved as "local trial run, not a client approval".

| Type | Planned | Created | Failed | Live / present | Block problems |
|---|---|---|---|---|---|
| Pages (incl. the payment-standards table page and the communities listing) | 89 | 89 | 0 | 89 | 0 |
| News posts | 256 | 256 | 0 | 256 | 0 |
| Events (meetings, The Events Calendar) | 244 | 244 | 0 | 244 | — |
| People (board + senior staff) | 10 | 10 | 0 | 10 | — |
| Forms (Gravity Forms) | 5 | 5 | 0 | 5 | — |
| Community entries (new ACF type) | 29 | 29 | 0 | 29 | — |
| Documents | 335 | 335 | 0 | 335 | — |
| Images | 140 | 140 | 0 | 140 | — |

- **Redirects:** 1,161 in Redirection, and all 1,161 answer 301 to the right page or file. That covers meeting pages → events, `/locations/detail/N` → entries, the 47 ZIP pages and 2 map pages → `/payment-standards/`, `show_image.php?id=N` → files, and `news-view` / `upages` → new URLs.
- **Site setting:** timezone changed from `America/Los_Angeles` (left over from the city template) to `America/New_York`.
- **Real editor:** 7 M2 pages open with 0 invalid or unsupported blocks: both form pages with their `gravityforms/form` block, the table page, the communities listing, a community entry, a meetings index page and the board page.
- **Front end:** every M2 page renders, including the event pages (date, time, notice text), the table and the form pages.
- **Re-runs:** they update in place. A changed analysis or plan needs a new approval.

## What the analyzers found (details in `analyze/*.json`)

**Meetings.** 285 meeting pages became:
- **244 meetings:** Committee 119, Board 107, Union Negotiations 16, Resident 2. 242 have a start time, 240 a location, and 24 are marked cancelled. 20 were merged from several pages (2020–21 notice + agenda + minutes).
- **17 index pages**, migrated as pages.
- **1 page that couldn't be placed:** an interview schedule covering three meetings.

The meetings carry 291 documents (agenda 127, minutes 97, notice 47, …), 13 YouTube recordings and links to 112 news items. A title date that contradicts the notice's own weekday-checked date gives way to the notice (one case: "June 3rd, 2023" is really June 3, 2024).

**Forms.** 7 found:
- **5 rebuilt:** Help Center, Customer Service Survey, Landlord Verification (49 fields), Online Vendor Application (file uploads), Direct Deposit. Each has a CAPTCHA, and the form sits where the source form was, without repeating the page title.
- **Direct Deposit** collects SSN/EIN and bank numbers. Those fields are left out of notification emails, and entries are deleted after 30 days.
- **2 alerts sign-ups** (SMS/email subscription) are flagged, not rebuilt.

**Records:**
- **People:** 6 board members plus the President/CEO, and 3 senior managers.
- **Communities:** 29, with labeled fields, the source's own type filter, photos and coordinates.
- **Payment standards:** 47 ZIP rows × 7 bedroom sizes, verbatim.
- **Document types:** 392 typed documents. Agenda, Minutes and Notice are the most common types; `library_select` is Key Documents for plans/policies, Bills & Resolutions for resolutions, and Maps for maps.

## Problems found while running, and fixes

| Problem | Fix |
|---|---|
| The seed's `people` type doesn't support custom fields, so the source-key tag was silently dropped and the next plan treated the people as demo content | The bridge enables custom-field support on public types while it's active. The executor now fails loudly if a created object comes back untagged |
| A `.dotx` public notice was rejected: WordPress allows `.dotx` but its content check disagreed | For administrator REST uploads, the bridge trusts the extension when WordPress allows it |
| A news post got the slug of an old meeting page whose URL now redirects to the event, so the post was unreachable | Old URLs that redirect elsewhere are reserved before slugs are handed out |
| After the date fix, the earlier run's event for that meeting lingered and held its slug | Objects an earlier run created that the plan no longer has are trashed (media excepted) |

## Questions for JHA (from the analysis)

1. **Forms:**
   - Which address or team should get each form's submissions? They currently go to the site admin email.
   - Direct Deposit: do you sign off on storing those fields for 30 days?
   - Which service replaces the SMS/email alerts sign-up, and can the subscriber list be exported?
   - Confirmation messages: use JHA's wording or the forms plugin's default?
   - Vendor uploads: confirm the allowed file types and size limit.
2. **Data the source contradicts:**
   - The departments page and the senior-management page name different COOs.
   - Two meeting pages carry another meeting's text.
   - ZIP 32003's Six-Bedroom value looks copied from 32033.
   - One file's link text has the wrong year.

   All of these are migrated as-is and listed in the analysis.
3. **Meetings that exist only as news items** (3 union negotiations, public hearings) don't get events, as specified. They stay news posts.

## Known gaps (later milestones or the team)

- **Event pages and listings use the parent theme's header/footer.** Theme change T3, for the team.
- **Cancelled meetings** have a warning. The Events Calendar's "canceled" status isn't set: its API doesn't expose it.
- **Help Center's conditional fields** (comment boxes per topic) are always visible. Gravity Forms conditional logic isn't in the spec yet.
- **Board page:** it keeps its migrated content. The people aren't placed through a Contact Cards block yet (M3, with the page templates).
- **Quick links and the homepage:** M3.
- **Unplaced index links:** 15 links on meeting index pages couldn't be tied to a meeting. They stay on their index pages.
