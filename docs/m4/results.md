# M4 results: review UI and approval gate (2026-10-14)

**Result: PASS on the local seed.** The JHA job went through the whole loop in the web app: review, changes, re-plan, approval, migration run and report. Everything ran through the queue worker, against the local seed. The approvals came from a local test account ("Claude (local test user)"), not from the client.

## What was built

| Piece | What it does |
|---|---|
| Web app (`apps/web`) | Next.js, built with webpack. Login; jobs list; intake (source URL, profile, target, timezone, GA4 id, optional style guide PDF, rights confirmation); targets with a connection test. Job page: the pipeline steps, run buttons, live log over SSE, stage runs, activity. Review screen with 12 tabs. Report page with CSV and Markdown downloads |
| Reviewer decisions | Exclude, include, page ↔ post, new slug, keep existing content. They're saved to `review/decisions.json` (a per-job lock serializes reviewers) and applied by the planner, so slugs, redirects, menus and file usage stay consistent. Rows waiting for a re-plan are highlighted, and the Decisions tab can undo any of them |
| Approval gate | Approval binds the exact plan version and sha256 the reviewer saw. `approvePlan` refuses anything else before writing, and "Run the migration" is only offered for an approved plan. The executor checks again |
| Queue worker (`apps/worker/src/worker.ts`) | pg-boss. A job runs one stage at a time, enforced by a unique index on `stage_runs`. Runs are claimed atomically and send a heartbeat. A sweep fails runs whose worker stopped and re-queues runs that lost their queue job. The CLI and the worker share the same stage code (`stages.ts`) |
| Postgres (`@wm/db`) | Users (scrypt passwords), sessions (hashed tokens, 12 h), targets (Application Passwords encrypted with AES-256-GCM), jobs, stage runs, the log, the audit trail. Plans, approvals and reports stay on disk |
| SSRF guard (`@wm/net`) | Every source and target fetch refuses loopback, private, link-local and metadata addresses. The check runs when the connection is made, so redirects and DNS rebinding are covered too. `WM_ALLOW_PRIVATE_HOSTS` lists development exceptions |
| Deployment | `Dockerfile` with `web` and `worker` targets, plus `compose.yaml` (`--profile app`). Each container gets only the settings it needs |

## The loop on JHA, through the UI

1. **Review plan v14:** 343 pages and posts, 479 files, 244 meetings, 40 records, 7 forms.
2. **Three changes:**
   - excluded "2020 Union Meetings";
   - made "30th Anniversary" a post;
   - gave it the slug `jha-30th-anniversary`.

   The rows were highlighted, and the banner offered a re-plan.
3. **Re-plan → v15.** The Changes tab was exactly what was expected:
   - pages 89 → 87, posts 256 → 257;
   - one more redirect (the old URL → the new slug);
   - existing content to trash 0 → 2: the excluded page, and the earlier page object, now that it's a post.
4. **Undid all three (Decisions tab) → v16.** v16 was byte-for-byte the same content as v14, so the round trip is deterministic.
5. **Approved v16, then "Run the migration."** Execute took 5.5 minutes, then the report:

| Type | Planned | Created | Failed | Live (200) | Block problems |
|---|---|---|---|---|---|
| Pages | 89 | 89 | 0 | 89 | 0 |
| News posts | 256 | 256 | 0 | 256 | 0 |
| Documents | 335 | 335 | 0 | 335 | 0 |
| Images | 144 | 144 | 0 | 144 | 0 |
| Events | 244 | 244 | 0 | 244 | 0 |
| People | 10 | 10 | 0 | 10 | 0 |
| Forms | 5 | 5 | 0 | 5 | 0 |
| Community entries | 29 | 29 | 0 | 29 | 0 |

All 1,165 redirects answer 301 to the right page.

Other checks:
- **Intake guard:** a source on `169.254.169.254` (cloud metadata) is refused with a clear message, and the form keeps what was typed.
- **Phone width:** every page fits at 375 px without sideways scrolling.
- **Docker:** both images build (web 299 MB, worker 1.32 GB). The stack serves the app, shares sessions with the dev server, and runs stages on the shared job files. A target the container can't reach fails with the cause, e.g. "connect ECONNREFUSED 127.0.0.1:8088".

## Problems found, and fixes

| Problem | Fix |
|---|---|
| Turbopack can't resolve the packages' `.js` import specifiers for `.ts` files | The web app builds with webpack (`resolve.extensionAlias`) |
| Migrations read from `.sql` files broke once bundled | Migrations live in code (`migrations.ts`) |
| A chained stage waited about 100 s for pg-boss's singleton key | A standard queue; one active stage per job is enforced by `stage_runs` |
| Log lines arrived out of order (writes in parallel) | Each run's lines are written one after another |
| React resets a form after a failed submit, so the intake lost everything typed | Actions return the submitted values, minus secrets and files |
| Cards in grid layouts widened the page on phones | Cards shrink and scroll wide tables inside |
| Build-time prerendering needed a database | App routes always render per request |
| "fetch failed" didn't say why | Stage errors include their causes |

The code review of `m3...m4` found 15 issues, all fixed and tested:
- **Security:** pages relied only on the layout's session check; the post-login redirect accepted `/\host`.
- **Queue:** a stage was queued before its row was committed; stuck runs had no way out; start-up failed other workers' running stages; a failure to queue the next stage marked the finished one failed.
- **Data:** a damaged decisions file read as "no decisions" (JSON writes are now atomic).
- **Deployment:** the session cookie was Secure on plain http; compose passed the development allowlist into the containers.
- **Smaller issues:** two efficiency problems, the CLI rights confirmation, the queue start-up race, and a silently dropped slug.

## Tests

110 tests, all passing (`pnpm test`; Postgres is needed for the `@wm/db` suite):
- planner decisions;
- the approval guard;
- the SSRF guard (blocked ranges, literal IPs, allowlist, redirect to a private address);
- Postgres (sessions, encrypted targets, one stage per job, claim, stale heartbeat, re-queue);
- web (post-login redirect, Secure cookie, approval state).

Each new test was checked by breaking the code it covers.

## Not in M4

| Item | Where it goes |
|---|---|
| Sitemap mapping tab | JHA has no separate sitemap (PLAN §6.6). Built with the first client that has one |
| Design tab (swatches, fonts, logo preview) | M3 branding, once the style guide PDF arrives |
| Extra-type inference | Not needed for JHA (presets cover every type) |
| Editing menus | Menus come from the source; excluding a page drops its menu links, with a warning |
| Roles (who may approve), login rate limiting | M5 hardening. Today any logged-in user can approve, and the audit trail records who did |

## Running it

```bash
docker compose up -d postgres
pnpm --filter @wm/worker wm user add --email you@example.org --name "Your Name"
pnpm --filter @wm/worker wm target add --name local --url http://localhost:8088 --user wm-local --password-env SEED_LOCAL_APP_PASSWORD
pnpm --filter @wm/worker worker      # one terminal
pnpm --filter @wm/web dev            # another: http://localhost:3100
```

`wm job register --job jha … --rights-confirmed` makes a job the CLI ran visible in the web app. For everything in Docker, run `docker compose --profile app up -d --build`.
