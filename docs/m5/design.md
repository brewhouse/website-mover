# M5 design: verification, QA, launch support, rollback, hardening

M5 makes a migration launch-ready (PLAN §10 and §6.13–6.15). In order of launch value:

## 1. QA stage: accessibility and responsive (new stage `qa`, after `report`)

- **Pages checked:**
  - One page per template the site uses: the homepage; a page; a news post; the News listing; an event; the events listing; a community entry; the communities listing; the table page; a form page; a person.
  - A sample of 20 other migrated pages. The sample is fixed per plan (seeded by the plan hash), so re-runs compare like with like.
- **Accessibility:** axe-core through Playwright (Chromium) at desktop width, with the WCAG 2.0/2.1 A and AA rules. Each violation is recorded with its rule, impact, the pages it's on and a sample element. A violation on every checked page is reported as **site-wide (theme)**. One that appears only on some pages is reported as **content**, linked to the source page.
- **Responsive:** each checked page is rendered at 375, 768 and 1280 px. Each render gets a screenshot (top of the page), and the check flags any page wider than the viewport.
- **No automatic fixes in M5.** PLAN §6.13 allows "safe auto-fixes" (heading levels, table headers, empty links). They change content after approval, so they belong in a reviewed plan step, not in QA. QA reports them, with a count, and missing alt text is flagged, never invented.
- **Output:** `qa/qa.json` and `qa/screenshots/`. The report page gets a QA section and a screenshot gallery.

## 2. Verification additions (`report` stage)

- **Broken links and images:** collects the same-site links and image sources from every migrated page on the target and checks each unique one once. It reports those that don't answer 200 (after redirects), with the pages linking to them.
- **Scope checklist:** each JHA SOW line (PLAN §13) is marked done, partial or n/a, with the reason from this job's results.
- **Retry failed only:** `execute --only-failed` re-runs only the objects that failed in the last run (plus anything that depends on them).

## 3. Post-launch check (new stage `postlaunch`, with `--base <live domain>`)

- Re-requests every legacy URL (the URL map: kept URLs and redirect sources) against the live domain, following redirects by hand.
- Reports:
  - 404s and other errors;
  - redirect chains of more than one hop;
  - redirects that land somewhere other than the planned page;
  - document links that don't resolve to a file.
- Checks for the GA4 tag (`G-…`) on the homepage.
- It can be re-run during stabilization. Before launch it runs against the target URL.

## 4. GA4

- The seed has no analytics plugin or theme field, and the tool can't change the codebase. New theme change **T13**: a "GA4 measurement ID" field in the Website Theme options, printed in `header.php`.
- The plan sets `ga4_measurement_id` from the job. Until T13 exists, the executor reports "the seed has no theme option ga4_measurement_id", and the post-launch check reports the tag as missing.

## 5. Rollback (new action, web and CLI)

- **Before first touching the site structure,** a job saves what it will change (`run/before.json`): the theme options it sets, the homepage template fields, the named menus with their items, and the site title and settings. Re-runs never overwrite it.
- **Rollback, in order:**
  1. Deletes the redirects the job imported.
  2. Trashes the pages, posts, events, people and entries it created (found by `_wm_job_id` through the bridge).
  3. Deletes the files it uploaded. WordPress can't trash attachments.
  4. Deletes the forms it built and the content types and field groups it created.
  5. Restores `before.json`.
  6. Untrashes the seed content the job had trashed.
- **Safeguards:** it needs a confirmation that types the job name, it's recorded in the audit trail, and it's refused while a stage runs.
- **Tested** on a small throwaway job against the local seed, not on JHA's content.

## 6. Delta sync

The pipeline is already idempotent: scan → plan → approve → execute updates in place. M5 makes changes visible. Each plan item records a content hash, and the Changes tab lists pages whose content changed since the previous version (new agendas, edited news). A pre-launch re-scan then gets a focused review rather than a full one.

## 7. Hardening

- **Approver permission:** users get `can_approve`. Only approvers can approve a plan, run a migration or roll back; everyone else can review and record decisions. Set with `wm user add --approver` / `wm user grant`.
- **Login rate limiting:** after 5 failed attempts for an email or IP address in 15 minutes, logins are refused for 15 minutes. Attempts are kept in Postgres, so the limit holds across restarts.
- **Worker image:** Chromium for QA (`playwright install --with-deps chromium`).

## Theme changes for the team

T13 (GA4 field) adds to T1–T12. QA results that come from the theme (e.g. contrast in the header, landmark structure) are listed with the report, for the team.
