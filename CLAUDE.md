# Website Mover

Internal tool that migrates a website into a blank WordPress "seed" site: scans the source, proposes a migration plan for human approval, then rebuilds everything as Gutenberg content styled from a brand style guide PDF.

**The full design is in `docs/PLAN.md` — read it before starting work.** Status: plan approved, nothing implemented yet. **Next: M0** (see PLAN §10).

## Key decisions (don't re-litigate)
- Flow: Scan → Plan (versioned JSON) → Approve → Execute → Verify → QA → Report. Execution only follows the approved plan, using scan-time snapshots.
- Gutenberg content built with WordPress's own block library (`@wordpress/blocks` `createBlock`/`serialize`, `rawHandler`), never hand-written block markup.
- Target theme: **Planeteria framework** (user is providing it). Template strategy depends on whether it's a block or classic theme — decide in M0.
- Seed site has ACF + a forms plugin + our bridge plugin (`wp/bridge`). The bridge is build-time only: everything it creates is stored natively.
- Sources are mostly WordPress: use the source's public WP REST API first, HTML crawl as fallback.
- AI = **OpenAI** (`openai` Node SDK, Responses API, Structured Outputs). Model from `OPENAI_MODEL`, key from `OPENAI_API_KEY`. AI never writes or rewrites content; extracted values must appear verbatim in the source.
- Keep source slugs and document upload paths; the approved sitemap can override (then 301).
- Public-sector profile (first client: Jacksonville Housing Authority, `https://www.jaxha.org/`): preset types for news, events, board meetings, board members, documents, quick links. See PLAN §6.4 and §13.
- TypeScript monorepo (pnpm workspaces), Next.js web app, Node worker with Playwright, Postgres + pg-boss, Docker Compose. Internal team tool.

## Local setup
- Node 22+, pnpm, Docker (for the test WordPress and Postgres).
- Copy `.env.example` to `.env` and fill in `OPENAI_API_KEY` (never commit `.env`).
- Client inputs (style guide PDFs, sitemaps, framework theme) go under `inputs/` — gitignored, may be confidential.
