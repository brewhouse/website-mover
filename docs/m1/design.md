# M1 design: thin end-to-end

**Goal (PLAN §10).** Migrate JHA's ordinary pages, news and the documents and images they use into the local seed. Content is Gutenberg blocks, internal links are rewritten, old URLs get redirects, and every step follows an approved plan and ends in a count report.

**Out of M1:**
- meetings, board members, events, forms and quick links (M2)
- branding, menus, header/footer and homepage (M3)
- the review UI (M4)
- the hosted seed: M1 runs against the local Docker seed only

## How it runs

M1 is a CLI in `apps/worker`. Each stage reads the previous stage's files from the job directory, so any stage can be re-run.

```
pnpm --filter @wm/worker wm <command> --job jha
  scan     crawl the source (polite, cached) → snapshot
  extract  main content + metadata per page → extracted pages
  plan     extracted pages + target capabilities → versioned plan (JSON + readable Markdown)
  approve  record approver, time, plan version and plan hash
  execute  refuses unless the approval matches the current plan; then cleanup → media → content → links → redirects → publish
  report   counts per type (planned / created / updated / skipped / failed), warnings, URL map, redirects
```

**Job directory** (`data/jobs/<job>/`, gitignored; `WM_DATA_DIR` overrides the root):

| Path | Written by | Contents |
|---|---|---|
| `job.json` | scan | source origin, platform profile, created at |
| `snapshot/pages.jsonl`, `snapshot/html/*` | scan | `SnapshotPage` rows + raw HTML |
| `snapshot/files.jsonl`, `snapshot/files/*` | scan | `SnapshotFile` rows + downloaded bodies (referenced files only) |
| `extract/pages.jsonl` | extract | `ExtractedPage` rows |
| `plan/plan.v<N>.json`, `plan/plan.v<N>.md` | plan | the plan (schema in `@wm/planner`) and a readable rendering |
| `plan/approval.json` | approve | approver, approved at, plan version, plan sha256 |
| `run/entities.json`, `run/events.jsonl` | execute | source key → WordPress object, plus a structured log |
| `report/report.json`, `report.md`, `url-map.csv`, `redirects.csv` | report | the outcome |

**Storage.** Job state lives in files for M1. Postgres and pg-boss (PLAN §7) arrive with the web app in M4. The stage boundaries above become queue jobs then.

## Contracts

- `@wm/core`: `SnapshotPage`, `SnapshotFile`, `ExtractedPage`, `sourceKey()`, job-directory helpers.
- **Source keys:** host without `www.` + lowercased path + sorted non-tracking query (`jaxha.org/hcv-landlords`, `jaxha.org/news-view?id=263`). Stored on every created object as `_wm_source_key` (with `_wm_job_id`). Re-runs update in place.
- **Platform profiles** (`@wm/extractor`) know a CMS's content selectors and URL patterns. `bjm` covers jaxha.org; a generic profile handles unknown sites with `<main>`/`<article>`/density heuristics.

## Decisions for JHA in M1

| Topic | Decision |
|---|---|
| Pages | `kind: page` → WordPress pages, **flat** (`/{slug}/`). The source's slug pages keep their exact path. Id-only pages (`upages.php?id=N`) get a slug from their title plus a 301 |
| News | `kind: post` → posts with the source date and category (16 categories created as needed). The source URL `news-view?id=N` → `/{slug}/` + 301 |
| Not migrated in M1 | home, listings, utility, meetings, records. Listed in the plan with a reason |
| Documents | Files linked from migrated content → media library, with the seed's Media Library fields (`index_for_library`, `publication_date` when known). `show_image.php?id=N` → 301 to the new file URL. Files nothing links to: skipped (decided 2026-10-13) |
| Images | Same-site images are uploaded and the block gets the attachment `id`. Third-party images stay hotlinked, with a warning |
| Blocks | `@wm/blocks`, H1s demoted, restricted to blocks the seed allows |
| Links | Internal links → new URLs. File-library links → new media URLs. Dead links are left in place and listed |
| Seed demo content | Listed in the plan. Moved to the trash on execute (decided 2026-10-13) |
| Redirects | Always `redirects.csv`. Imported into Redirection when it's active on the target |
| Target | `local` only. `--target seed` is refused until the bridge is installed there |
