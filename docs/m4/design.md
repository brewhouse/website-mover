# M4 design: review UI and approval gate

M4 turns the CLI pipeline into the internal web tool from PLAN §6.11. People log in, start a job, watch it run, review the plan, change it, approve it, run the migration and read the report. The CLI keeps working, and both run the same stage code.

## Scope

**In M4**
- Login (per-user accounts) and a job list.
- Intake: source URL, site profile, target, timezone, GA4 id, a rights confirmation, and an optional style guide PDF.
- Targets: WordPress URL, user and Application Password. The password is stored encrypted, and a "test connection" button checks the bridge.
- Stages run in the worker through a queue, with a live log.
- The review screen, with tabs for Summary, Pages & posts, Not migrated, Files, Meetings, Records, Forms, Site, Cleanup, Warnings and Changes.
- **Reviewer decisions:** exclude, include, page ↔ post, new slug, keep existing content. Re-planning with them makes a new plan version.
- **Approve & run** records the approver, time, plan version and plan hash. Then the report view.
- An SSRF guard for every URL the tool fetches.
- Docker Compose for web, worker and Postgres.

**Not in M4**
- **Sitemap mapping tab:** JHA has no separate sitemap (PLAN §6.6). It comes with the first client that has one.
- **Design tab:** waits on the style guide (M3 part 2).
- **Extra-type inference:** for JHA, presets covered every type.
- **Editing menus:** menus come from the source. Excluding a page drops its menu items, and the plan reports that.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Storage | **Postgres** holds users, sessions, targets (encrypted credentials), the job registry, stage runs, the live log and the audit trail. **Job artifacts stay on disk** under `WM_DATA_DIR`: snapshots, extracts, analyses, plan versions, approval, run state, reports | The artifacts are large, immutable files that the planner and executor already read and write. The plan file is the contract, and the approval binds its sha256. Moving them into tables would add risk without changing what anyone sees. This amends the PLAN §7 data model |
| Edits | Reviewers never edit plan JSON. Their choices go in `review/decisions.json`, which the planner reads, and every re-plan is a new version. The plan records the decisions it applied | Derived parts stay consistent: slugs, redirects, menu links, file usage, demo cleanup. The CLI produces the same plan from the same decisions |
| Auth | Accounts created from the CLI (`wm user add`); no sign-up. Passwords hashed with scrypt. Sessions are a random token in an httpOnly, SameSite=Lax cookie, stored as a hash in Postgres, valid 12 hours | An internal tool with few users. The approver's name comes from the session, not a text field |
| Credentials | App Passwords encrypted with AES-256-GCM using `CREDENTIALS_ENCRYPTION_KEY`, decrypted only in the worker and in "test connection". Never sent to the browser | PLAN §8 |
| Queue | pg-boss, one `stage-runs` queue. A job runs one stage at a time: a unique index on `stage_runs` refuses a second queued or running stage for the same job. "Run through to the plan" chains scan → extract → analyze → plan, queuing each stage when the previous one succeeds | Long work never runs in a request handler (PLAN §7). A pg-boss singleton key held chained stages back for up to two minutes, so the database enforces it instead |
| Live log | The worker writes log lines to `events`. The web streams them over SSE, polling Postgres once a second | Simple, and fine for a handful of users |
| SSRF | The crawler, and every target the tool connects to, refuse loopback, private, link-local and metadata addresses, after DNS resolution. `WM_ALLOW_PRIVATE_HOSTS` lists exceptions (the local seed: `localhost:8088`) | PLAN §8. Anyone logged in can type a URL the worker will fetch |
| UI | Next.js (App Router) with server components and server actions; Tailwind. Tabs are links (`?tab=`), so the review screen works without client JavaScript, apart from the live log | Fewer moving parts. The few shadcn-style components (button, badge, table) are written in the repo rather than generated |

## Reviewer decisions (`review/decisions.json`)

```jsonc
{
  "exclude": ["jaxha.org/old-page", "meeting:2026-05-11:finance-committee-meeting", "jaxha.org/plugins/show_image.php?id=7"],
  "include": ["jaxha.org/quick-links", "jaxha.org/plugins/show_image.php?id=999"],
  "type": { "jaxha.org/news-view?id=12": "page" },
  "slug": { "jaxha.org/upages.php?id=9": "resident-handbook" },
  "keep": [713]
}
```

| Decision | Applies to | Effect |
|---|---|---|
| `exclude` | Pages, posts, meetings, community entries, people, tables, files | Left out and listed under "Not migrated" with "Excluded by the reviewer". Its URL gets no redirect, and menu links to it are dropped (with a warning) |
| `include` | Pages the rules left out (utility, listing, unanalyzed), and files nothing links to | Migrated as a page, or uploaded |
| `type` | Pages and posts | Migrated as the other type |
| `slug` | Pages and posts | New URL; the source URL redirects to it. If the slug is taken, it gets a suffix and a warning |
| `keep` | Existing target content the plan would trash | Kept, and listed with "Kept by the reviewer" |

A decision whose key no longer matches anything gives a plan warning. Every change to the decisions is written to the audit trail with the user and time.

## Flow in the UI

1. **New job:** fill in the intake form and confirm the rights to copy the content. Creating the job queues "scan → plan".
2. **Job page:** the stages with their status, buttons to run each one, and the live log.
3. **Review:** tabs and toggles; changes are saved as decisions. "Re-plan with these changes" queues a new version. The Changes tab compares it with the previous version.
4. **Approve:** "Approve plan vN" requires ticking "I reviewed this plan". It records who, when, the version and the hash, so execution refuses any other bytes.
5. **Run the migration:** queues execute → report. The report tab shows the counts, failures, redirects and warnings.

## Data model (Postgres)

`users`, `sessions`, `targets`, `jobs`, `stage_runs`, `events`, `audit`. Migrations are plain SQL files in `packages/db/migrations`, applied in order at worker and web start-up.
