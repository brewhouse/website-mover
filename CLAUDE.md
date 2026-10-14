# Website Mover

Internal tool that migrates a website into a blank WordPress "seed" site: scans the source, proposes a migration plan for human approval, then rebuilds everything as Gutenberg content styled from a brand style guide PDF.

**The full design is in `docs/PLAN.md` — read it before starting work.** Status: M0 done (`docs/m0/`). M1, M2 and M3's site structure pass on the local seed (`docs/m1/results.md`, `docs/m2/results.md`, `docs/m3/results.md`); next: M3 branding (needs the style guide PDF), M4 (review UI), and running on the hosted seed once the bridge is installed there (see PLAN §10).

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

## Local setup
- Node 22+, pnpm, Docker (for the test WordPress and Postgres).
- Copy `.env.example` to `.env` and fill in `OPENAI_API_KEY` (never commit `.env`).
- Local seed site: `e2e/seed/setup.sh` copies `SEED_CODE_PATH` into `.local/seed` and runs it on `http://localhost:8088` (Docker).
- Client inputs (framework theme, style guide PDFs, sitemaps) go under `inputs/`. Everything there is gitignored except `inputs/README.md`, which lists exactly what's needed and where it goes.
