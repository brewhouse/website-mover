# M5 results: verification, QA, launch support, rollback, hardening (2026-10-14)

**Result: PASS on the local seed.**
- JHA ran the full M5 chain from the web app: plan → approve → migrate → report (with link checks) → QA → post-launch check.
- Rollback was tested end to end on a throwaway job against the same seed.
- Approvals came from a local test account, not from the client.

## JHA, plan v19

| Check | Result |
|---|---|
| Migration | 0 failures; every page, post, document, image, event, person, form and community entry live; 0 block problems |
| Redirects | 1,167 (the 1,165 legacy URLs plus the framework's 2 hard-coded news paths); all answer 301 to the right page |
| Links and images | 1,022 same-site links and images checked; 10 broken. All 10 are the source's own Zoom dial-in links: phone numbers pasted as links with no `tel:`. They're broken on jaxha.org too, and are kept verbatim by design (M1) |
| QA, accessibility | 30 pages (10 templates, 20 sampled) checked against WCAG 2.1 A/AA with axe-core. 2 rules violated, both in theme or plugin markup: the News page's sort dropdown has no label (critical), and The Events Calendar's navigation list has non-`li` children (serious). No content-level violations |
| QA, phone width | Sideways scrolling at 375 px on 1–3 pages per sample: a news post whose link text is a long URL, and The Events Calendar's list cards. Tablet and desktop: every page fits |
| Post-launch check (against the target) | 1,242 of 1,242 legacy URLs answer 200, directly or with one 301 to the right page. Of the 46 left out on purpose, 31 answer 404; 15 answer 200, since they're the homepage and News listing paths the framework rebuilt |
| GA4 `G-ZHVZNQBLZ8` | Not on the homepage yet. The plan sets the theme option, and the run reports "the seed has no theme option ga4_measurement_id" until theme change T13 |
| Scope checklist | Done: lift-and-shift, sitemap, redirects. Partial: branding (waits on the style guide), news/events/forms (2 subscription forms need a tool), navigation (T1), QA (theme issues), analytics (T13). n/a: hosting (the team's part) |

## Hosted seed run (Pantheon dev, 2026-10-15)

The team added the bridge plugin to the seed's Pantheon codebase and activated Redirection. Job `jha-dev` reused JHA's scan, with the hosted site saved as its target.
- **Approval:** Rohit Mehta approved plan v1 in chat, recorded as "Rohit Mehta (approved in chat)".
- **Demo content:** the plan trashed the seed's 34 demo items and kept the homepage and the News page.
- **Timezone:** changed from Los Angeles to New York.

| Check | Result |
|---|---|
| Migration (second pass) | 0 failures; 1,112 objects, all live; 0 block problems. A pass takes 9–28 minutes on Pantheon |
| Redirects | 1,167 of 1,167 answer 301 to the right page |
| Links and images | 1,018 checked; 10 broken, the same source dial-in links as locally |
| QA | 30 pages: `select-name` on the News page (critical), and The Events Calendar's `list` markup on 6 pages (serious). Sideways scrolling at 375 px on 5 pages: 4 news or content pages with long link text, and `/events/` |
| Post-launch check (against the dev site) | 1,242 of 1,242 legacy URLs OK. Of the 46 left out on purpose, 31 answer 404 and 15 answer 200 (rebuilt homepage and News paths). GA4 is not on the homepage yet (T13) |
| Rollback | Available: the first run saved `run/before.json` (title, timezone, 10 theme options, 13 homepage fields, 5 menus) |

The first pass found two problems. Both are fixed, and the second pass ran clean:
- **Uploads reported failed that weren't:** Pantheon answered 502 for 4 uploads that WordPress had saved, so they were marked failed and their links weren't rewritten. A 502/503/504 now means "outcome unknown": the executor looks for the item by its source key before failing.
- **QA checked Pantheon's notice, not the site:** Pantheon shows browsers a "Sandbox Environment Notice" on sandbox sites, so QA checked 30 copies of the notice and reported nothing. QA now sets the notice's bypass cookie, and a page that is still a hosting notice is an error, never a clean result.

**For the team (T1):** on the hosted theme, the seal logo also covers the first main-menu item ("About Us").

## Rollback, on a throwaway job

The `rb-test` job ran after JHA on the same local seed, from the fixture site in `e2e/fixtures/small-site`. Its plan:
- created 2 pages, 2 files and 1 redirect;
- replaced all five menus, three of them with empty ones;
- cleared the footer options and the homepage fields;
- renamed the site.

Rolling it back:
- deleted its own redirect and kept the 2 it shared with JHA;
- trashed its 2 pages and deleted its 2 files;
- restored the menus (every item and its nesting), the theme options, the title, the timezone and the homepage fields.

The site then matched a snapshot taken before the job, on every check: menus, options, title, timezone, homepage, and the page, post and media counts.

The test found two bugs, both fixed:
- **Shared redirects:** rollback would have deleted redirects JHA also uses. Redirects and content types that another job on the same target uses now stay. The site structure is restored only if no other job ran on that target since.
- **Empty repeaters:** ACF's REST check refuses an empty repeater sent as `null`. Snapshots now record field types, and restore sends `[]`.

## What was built

| Piece | Where |
|---|---|
| QA stage | `@wm/qa`: Playwright with axe-core. Pages are one per template plus a sample fixed per plan, rendered at 375/768/1280 px. Template pages get screenshots, every page gets a sideways-scrolling check. Every request Chromium makes goes through the SSRF check. Stage `qa` runs after each migration |
| Link check | `report` stage: each same-site link and image once |
| Post-launch check | Stage `postlaunch` against the job's live address (set on the job page), or the target before launch. Follows redirects hop by hop: not found, errors, wrong targets, chains, loops; lists the left-out URLs; checks the GA4 tag |
| Rollback | Stage `rollback`. The web form needs the job name typed (approvers only); the CLI needs `--confirm`. The job's first run saves `run/before.json`. Bridge: untrash, read theme options, trash forms and ACF items |
| Delta sync | Plan items record a content hash; the Changes tab lists pages whose content changed since the previous scan |
| Hardening | Approver permission (`can_approve`): approve, migrate and roll back. Login limits: 5 failures per email, or 20 per address behind a trusted proxy (`WM_TRUST_PROXY=1`), in 15 minutes |
| Scope checklist | Report page, from this migration's own results |
| Worker image | Chromium included. It runs without its own sandbox in the container, which can't start one (tested); the request guard still applies |

The code review of `m4...m5` found 15 issues; 13 are fixed. The main ones:
- QA's browser bypassed the SSRF guard (a page could put an internal address into a screenshot);
- a pre-M5 job's snapshot would have recorded its own changes as "before";
- the CLI applied one GA4 ID to every job;
- the per-address login limit trusted a spoofable header;
- the Chromium sandbox failed in Docker.

Two were left, as limits of rollback:
- **Retargeted redirects:** a redirect that another job had created, and that this job pointed at its own page, stays pointing at the trashed page.
- **Terms and venues:** terms (categories, event categories, community types), and any venues the job created, aren't removed.

The second schema request per run also stays: the snapshot has to come before the settings change, and step 3 has to read the schema again after creating content types.

## Theme changes for the team (add to T1–T12)

| # | Change | Why |
|---|---|---|
| T13 | A "GA4 measurement ID" field in the Website Theme options, printed in `header.php` | The seed has no analytics plugin or field, and the tool doesn't change the codebase. The plan already sets `ga4_measurement_id` |
| T14 | Link "All News" (`single.php`, `single-resource_library.php`) and the news breadcrumb (`functions.php`) to the News page's permalink, not hard-coded `/latest-news/` and `/current-news/` | Both were 404 on every post (281 and 256 pages). The tool redirects them for now |
| T15 | Label the News page's sort dropdown | axe: `select-name` (critical) |
| T16 | Let long words and URLs wrap in content (`overflow-wrap: anywhere`), and fix the events list cards' width at 375 px | Sideways scrolling on phones |

The Events Calendar's navigation markup (`list`, serious) comes from the plugin: update it, or override its template.

## Tests

123 tests pass (`pnpm test`). New in M5:
- QA page selection and rule summary;
- the QA request guard, with a real browser;
- post-launch classification and link collection;
- the other-jobs lookup and homepage restore for rollback;
- approver and login limits (Postgres);
- the scope checklist;
- the framework redirects and the delta-sync hash.

Each was checked by breaking the code it covers.

## Not done

- **M3 branding:** waits on the style guide PDF.
- **Hosted seed run:** needs the bridge in the seed's Pantheon codebase and Redirection activated.
- **Automatic accessibility fixes:** heading levels, table headers and empty links are reported, not changed. They'd change content after approval, so they belong in a reviewed plan step.
- **"Retry failed only":** re-running the migration updates everything in place, which is idempotent and about 10 minutes for JHA.
