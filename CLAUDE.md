# Website Mover

Internal tool that migrates a website into a blank WordPress "seed" site: scans the source, proposes a migration plan for human approval, then rebuilds everything as Gutenberg content styled from a brand style guide PDF.

**The full design is in `docs/PLAN.md` — read it before starting work.** Status: M0–M5 pass on the local seed (`docs/m0/` … `docs/m5/` results). JHA is migrated to the hosted seed (Pantheon dev, job `jha-dev`), with theme changes T1–T16 applied there (`docs/theme-patches.md`). M3 branding (from JHA's Figma guide, `docs/m3/branding.md`) passes on the local seed and on Pantheon dev, with theme patches T17–T21 applied there. Build from design (`docs/build/PLAN.md`, pilot Newport Beach intranet): B0–B0.2 deployed on Newport dev; B1 ingest done (`packages/design`, `wm design ingest`).

## Key decisions (don't re-litigate)
- Flow: Scan → Plan (versioned JSON) → Approve → Execute → Verify → QA → Report. Execution only follows the approved plan, using scan-time snapshots.
- Gutenberg content built with WordPress's own block library (`@wordpress/blocks` `createBlock`/`serialize`, `rawHandler`), never hand-written block markup.
- Target theme: **Planeteria framework**. Template strategy depends on whether it's a block or classic theme — decide in M0.
- Seed codebase: the user's local git clone of the JHA seed site's Pantheon repo (path in `SEED_CODE_PATH`, e.g. `bases/jha-lift-shift`). It holds the framework theme and plugins. **Read-only: never edit, commit or push there** (a push deploys to Pantheon). Run local WordPress from a copy under `.local/`.
- Seed site has ACF + a forms plugin + our bridge plugin (`wp/bridge`). The bridge is build-time only: everything it creates is stored natively.
- Sources are never WordPress (only the target is). Source acquisition is an HTML crawl: robots.txt, sitemap.xml plus any HTML site map, same-site links, and Playwright for JS-rendered pages.
- AI = **OpenAI** (`openai` Node SDK, Responses API, Structured Outputs). Model from `OPENAI_MODEL`, key from `OPENAI_API_KEY`. AI never writes or rewrites content; extracted values must appear verbatim in the source.
- Keep source slugs where they're WordPress-safe; the approved sitemap can override. Every legacy URL that changes (including id/query-string page and file URLs) gets a 301.
- Public-sector profile (first client: Jacksonville Housing Authority, `https://www.jaxha.org/`): preset types for news, events, board meetings, board members, documents, quick links. See PLAN §6.4 and §13.
- TypeScript monorepo (pnpm workspaces), Next.js web app, Node worker with Playwright, Postgres + pg-boss, Docker Compose. Internal team tool.
- M4: Postgres holds users, sessions, targets (encrypted), jobs, stage runs, the log and the audit trail; job artifacts (plans, approval, reports) stay on disk. Reviewers' edits are planner input (`review/decisions.json`), never edits to plan JSON.

## Local setup
- Node 22+, pnpm, Docker (for the test WordPress and Postgres).
- Copy `.env.example` to `.env` and fill in `OPENAI_API_KEY` (never commit `.env`).
- Local seed site: `e2e/seed/setup.sh` copies `SEED_CODE_PATH` into `.local/seed` and runs it on `http://localhost:8088` (Docker).
- Client inputs (framework theme, style guides, sitemaps) go under `inputs/`. Everything there is gitignored except `inputs/README.md`, which lists exactly what's needed and where it goes.
- Web app (M4, `docs/m4/`):
  - `docker compose up -d postgres`.
  - Create a login with `pnpm --filter @wm/worker wm user add --email … --name …`. Save the local seed as a target with `wm target add --name local --url http://localhost:8088 --user wm-local --password-env SEED_LOCAL_APP_PASSWORD`.
  - Then run `pnpm --filter @wm/worker worker` and `pnpm --filter @wm/web dev` (http://localhost:3100).
  - Jobs the CLI ran: `wm job register … --rights-confirmed`.
  - Only approvers can approve, migrate or roll back: `wm user add --approver`, `wm user grant --email …`.
  - A job's GA4 ID goes with the job (intake form; CLI `--ga4` on plan and postlaunch), never from the environment.
  - Branding from a brand file: `wm brand --job … --file inputs/<client>/style-guide/brand.json`, then re-plan.
  - Behind a reverse proxy, set `WM_TRUST_PROXY=1` so login limits use the client's address.
- Job options (`jobs.options`, intake form and the job page's Options card; CLI `wm plan --incremental --content-only --side-nav-menu --side-nav-pages`). Each plan records them in `plan.options`, so the approval covers them and execution reads the plan, not the job:
  - **Incremental:** plans as usual, then drops everything whose source key is already tagged on the target (by any job) into `plan.alreadyMigrated`. The executor links new content and menus to those objects but never writes them, and nothing is trashed. "Already there" comes from the target itself (`_wm_source_key`), so it works for a job that a different machine migrated first. Items trashed on the target aren't listed by the bridge, so they count as new.
  - **Content only:** no `site`, `design`, `settings` or `siteRedirects` in the plan. Content types, forms, content redirects and demo-content cleanup still run.
  - **Side nav in main menu:** the analyzer reads every page's side menu into `site.sectionNav` (BJM: `#lm_main_page` + `.lm_sub_page`), and the planner merges it into the Main Menu breadth-first, each page once, at most `SIDE_NAV_MAX_DEPTH` (3) levels.
  - **Side nav on pages:** `plan.sideMenus` has one menu per `site.sectionNav` section, named `Side Navigation: <section>` (`SIDE_MENU_PREFIX`), which the executor writes like the framework menus (replaced as a whole, in the rollback snapshot). It is independent of content only, so with incremental + content only a run writes only these menus. Theme change T22 (`docs/theme-patches.md`) shows a side menu beside every page it links to; without T22 the menus exist but nothing shows them.
- SSRF guard (`@wm/net`): the tool refuses private addresses. `.env` sets `WM_ALLOW_PRIVATE_HOSTS=localhost` for the local seed (development only).
