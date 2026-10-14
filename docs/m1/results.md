# M1 results: thin end-to-end on the local seed (2026-10-13)

**Result: PASS on the local copy of the seed** (seed DB imported, the seed's own plugin and block settings, Redirection switched on locally). JHA's ordinary pages, news, and the documents and images they use were migrated through scan → extract → plan → approve → execute → report. The report checks every object on the site rather than trusting the run log.

| Type | Planned | Created | Failed | Live (200) | Block problems |
|---|---|---|---|---|---|
| Pages | 64 | 64 | 0 | 64 | 0 |
| News posts | 256 | 256 | 0 | 256 | 0 |
| Documents | 93 (83 MB) | 93 | 0 | 93 | — |
| Images | 87 | 87 | 0 | 87 | — |

- **Categories:** 16 news categories created; every post has its source date and category.
- **Redirects:** 454 legacy URLs (`news-view?id=N`, `upages.php?id=N`, `plugins/show_image.php?id=N`, unsafe slugs, source-side aliases). All 454 are imported into Redirection, and all 454 answer 301 to the right page or file.
- **Seed demo content:** 34 items moved to the trash. The Home page (homepage template) and the framework's News page are kept.
- **Real editor:** 6 migrated pages (140 blocks: link lists, documents, a 71-block FAQ, a news post with images) open in the WordPress 7.0.4 editor with 0 invalid or unsupported blocks and no changes on open (`e2e/editor-check.ts --post …`).
- **Front end:** pages render in the framework's PHP templates (title band, breadcrumbs), and news posts show their category and date.
- **Re-runs** update in place: objects are found again by `_wm_source_key`, nothing is duplicated, and redirects already present are skipped.
- **Not migrated in M1 (listed in the plan with reasons):**
  - 285 meeting pages (M2 events)
  - 76 community/ZIP records (M2)
  - 42 listings
  - 10 utility pages
  - the homepage (M3)
  - files used only by those pages

**Timings (local):**
- scan: page HTML came from the inventory cache, plus about 2.5 minutes to download 545 files
- extract: seconds
- first execute: about 5 minutes; re-runs: about 2 minutes
- report with full verification: about 3 minutes

## How to run

```bash
pnpm --filter @wm/worker wm scan    --job jha --origin https://www.jaxha.org --profile bjm --cache snapshots/jha/http
pnpm --filter @wm/worker wm extract --job jha
pnpm --filter @wm/worker wm plan    --job jha                     # review data/jobs/jha/plan/plan.vN.md
pnpm --filter @wm/worker wm approve --job jha --by "Your Name"
pnpm --filter @wm/worker wm execute --job jha
pnpm --filter @wm/worker wm report  --job jha                     # data/jobs/jha/report/
```

This run's approval was recorded as "Claude (M1 local test run, not a client approval)". `execute` refuses a plan that changed after approval, and that refusal is covered by a test.

## Problems found while running, and fixes

| Problem | Fix |
|---|---|
| Two news items dated 2026-10-19, after the run date, were scheduled by WordPress instead of published (404) | Future-dated posts are published with the migration time, sent as GMT (`date` is read in the site's timezone). The plan flags them |
| The same 4 pages failed every run with "other side closed" | Loading the block library blocks Node for about 4 s. Pooled connections the server closed in the meantime were then reused for writes. The library now loads before any request. A dropped create is also re-checked by source key before retrying, so it can't make a duplicate |
| Redirection's tables didn't exist after activating it with WP-CLI | Locally: `wp redirection database install`. On the hosted seed, activating Redirection in wp-admin runs its setup. A failed import no longer stops the run (redirects stay in `redirects.csv`) |
| Image files have no filename on BJM (served by a script) | Images are named after their alt text |

## Known gaps

- **Header lists every page.** The seed's menus pointed at demo pages, which are now trashed. Empty menus fall back to listing all pages. Fixed when M3 builds the menus from the current navigation.
- **Placeholder logo.** The logo is the seed's leftover "City of Pinole" image (theme change T1, plus M3).
- **Links to unmigrated content.** 57 migrated items link to content that isn't migrated yet (mostly meeting pages). Those links still point at jaxha.org until M2.
- **Separators.** 45 items had a horizontal rule. The seed disables `core/separator`, so those are dropped, as decided.
- **Hotlinked images.** 2 news posts use images hotlinked from jacksonville.com, flagged `external-image`. They show broken when the third party blocks hotlinking.
- **Board page.** `/board-of-commissioners` is migrated as a plain page. It becomes `people` plus a people grid in M2.
- **Hosted seed.** M1 hasn't run against the Pantheon Dev site. That needs the bridge in the seed's Pantheon codebase, Redirection activated there, `--target seed` enabled, and a real approval.
- **Storage.** Job state is on disk (`data/jobs/`). Postgres and the review UI come in M4, as designed.
