# M2 design: public-sector content model

**Goal (PLAN §10).** Turn JHA's structured content into the seed's own types: meetings, board members, forms, communities, the payment-standards table, and typed documents. Same pipeline as M1, with one new stage:

```
scan → extract → analyze → plan → approve → execute → report
```

`wm analyze --job jha` reads `extract/pages.jsonl` and the snapshot. It writes `analyze/meetings.json`, `analyze/forms.json` and `analyze/records.json` (types in `@wm/core` `analysis.ts`). The planner turns those into plan entries. The plan records each analysis file's hash alongside the extract hash, so approval covers them.

## Decisions (JHA, from the seed DB and the inventory)

| Topic | Decision |
|---|---|
| **Meetings** | One **Events Calendar event** per meeting (date + kind), merging every source page about it (notice/agenda/minutes pages; the newest meetings have one page each). Categories: the seed's "Board Meetings" for Board of Commissioners meetings, plus "Committee Meetings", "Union Negotiations", "Public Hearings" and "Resident Meetings" as needed. Title and text are verbatim from the primary page. Every merged source URL redirects to the event |
| Event content | The seed's Events Calendar uses the **classic editor** (block editor not enabled), so event descriptions are clean HTML: the converted content rendered without block markup. Then a "Documents" list (agenda, minutes, notice, packet… with their source link text), recordings, and links to the related news posts |
| Meeting news items | Stay news posts (M1). The event links to them |
| Meeting index pages | ("Meeting Minutes", "Past BOC Meetings", "Union Meetings", …) migrated as ordinary pages. Their links now point at the events |
| Unplaceable meeting pages | Migrated as ordinary pages and listed in the plan under "needs review" |
| Site timezone | The seed is set to `America/Los_Angeles` (from the city template). The plan proposes `America/New_York` (Jacksonville) so meeting times are right. This is an explicit plan item |
| **Board members** | `people` posts: name = title, `title` = role, `email`/`phone` repeaters, photo = featured image. The `/board-of-commissioners` page keeps its migrated content |
| **Forms** | 5 rebuilt in Gravity Forms through the bridge: Help Center, Customer Service Survey, Landlord Verification, Vendor Application, Direct Deposit. Each goes on its migrated page with the `gravityforms/form` block where the source form was. The SMS/email **alerts sign-up** is a subscription service: not rebuilt, flagged. The staff login is never migrated |
| Sensitive forms | Fields collecting SSN/EIN or bank details are left out of notification emails, and entries are deleted after 30 days (Gravity Forms retention policy). The plan flags the form for JHA sign-off |
| **Communities** | ACF post type `community` + `community_type` taxonomy (created by the bridge, stored natively), with fields from the source's labels. The body is the source content (`single.php` shows only the body until the team adds a template). A "Communities" page lists them. `/locations/detail/N` → 301 |
| **Payment standards** | The 47 ZIP-code pages are one dataset. They become one page with a table (one row per ZIP, verbatim values) and notes. All 47 ZIP URLs and the two map pages → 301 to it |
| **Documents** | Meeting documents are uploaded too, about 325 links. Every library file gets a `resource_type` term (Agenda, Minutes, Notice, Resolution, Policy, Plan, Report, Form, …) from its linking page and filename. `library_select` is "Key Documents" for plans/policies and "Bills & Resolutions" for resolutions. `publication_date` is set when the filename or link text states a date |
| Quick links | M3 (homepage `banner_icon`), built from the current portals |
| AI | Not needed for M2: the rules place meetings, and anything they can't is listed for a person |
