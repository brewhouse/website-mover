/**
 * Schema migrations, applied once each in order (migrate.ts). Kept in code rather than .sql files so
 * they're bundled with the web app. Names are permanent: never edit an applied migration, add one.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001_init.sql',
    sql: `
-- M4: users and sessions, saved targets, the job registry, stage runs, the live log, the audit trail.
-- Job artifacts (snapshots, plans, approval, run state, reports) stay on disk under WM_DATA_DIR.

create table users (
  id serial primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- The cookie holds a random token; only its sha256 is stored.
create table sessions (
  token_hash text primary key,
  user_id int not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user on sessions (user_id);

-- WordPress targets. The Application Password is encrypted (AES-256-GCM, CREDENTIALS_ENCRYPTION_KEY).
create table targets (
  id serial primary key,
  name text not null unique check (name ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  url text not null,
  wp_user text not null,
  app_password_enc text not null,
  created_by int references users (id),
  created_at timestamptz not null default now()
);

create table jobs (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  source_url text not null,
  profile text not null,
  target_id int not null references targets (id),
  timezone text,
  ga4_id text,
  -- File name of the style guide PDF in the job's inputs folder, if one was uploaded.
  style_guide text,
  rights_confirmed_by int not null references users (id),
  rights_confirmed_at timestamptz not null default now(),
  created_by int not null references users (id),
  created_at timestamptz not null default now()
);

create table stage_runs (
  id serial primary key,
  job_id text not null references jobs (id) on delete cascade,
  stage text not null check (stage in ('scan', 'extract', 'analyze', 'plan', 'execute', 'report')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- Stages to queue after this one succeeds ("run through to the plan").
  then_stages text[] not null default '{}',
  requested_by int references users (id),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  summary jsonb
);
create index stage_runs_job on stage_runs (job_id, id desc);
-- A job runs one stage at a time.
create unique index stage_runs_one_active on stage_runs (job_id) where status in ('queued', 'running');

create table events (
  id bigserial primary key,
  job_id text not null references jobs (id) on delete cascade,
  run_id int references stage_runs (id) on delete cascade,
  at timestamptz not null default now(),
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  message text not null
);
create index events_job on events (job_id, id);

create table audit (
  id bigserial primary key,
  job_id text references jobs (id) on delete cascade,
  user_id int references users (id),
  action text not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index audit_job on audit (job_id, id);
`,
  },
  {
    name: '002_run_heartbeat.sql',
    sql: `
-- The worker running a stage updates this every 30 s; a stale heartbeat means the worker stopped.
alter table stage_runs add column heartbeat_at timestamptz;
`,
  },
  {
    name: '003_m5_stages.sql',
    sql: `
-- M5: accessibility/responsive QA, the post-launch check, and rollback run as stages too.
alter table stage_runs drop constraint stage_runs_stage_check;
alter table stage_runs add constraint stage_runs_stage_check
  check (stage in ('scan', 'extract', 'analyze', 'plan', 'execute', 'report', 'qa', 'postlaunch', 'rollback'));
`,
  },
  {
    name: '004_live_url.sql',
    sql: `
-- The site's live address, for the post-launch check (the target's URL until launch).
alter table jobs add column live_url text;
`,
  },
  {
    name: '005_approvers_and_login_limits.sql',
    sql: `
-- Only approvers may approve a plan, run a migration or roll one back. Accounts that existed before
-- this could already do all of that, so they keep it.
alter table users add column can_approve boolean not null default false;
update users set can_approve = true;

-- Login attempts, for rate limiting (kept a day).
create table login_attempts (
  id bigserial primary key,
  email text not null,
  ip text,
  ok boolean not null,
  at timestamptz not null default now()
);
create index login_attempts_email on login_attempts (email, at);
create index login_attempts_ip on login_attempts (ip, at);
`,
  },
  {
    name: '006_job_options.sql',
    sql: `
-- How a job migrates: incremental (only content not on the target yet), content only (no menus, theme
-- options, homepage or branding), and the side navigation added to the main menu. The plan stage reads
-- them; each plan records the options it was made with.
alter table jobs add column options jsonb not null default '{}';
`,
  },
  {
    name: '007_design_jobs.sql',
    sql: `
-- Build from design (docs/build/PLAN.md): a job either migrates a site or builds one from mockups.
-- A design job's source_url is its Figma link; its stages are ingest, model and design_plan.
alter table jobs add column kind text not null default 'migrate' check (kind in ('migrate', 'design'));
alter table stage_runs drop constraint stage_runs_stage_check;
alter table stage_runs add constraint stage_runs_stage_check
  check (stage in ('scan', 'extract', 'analyze', 'plan', 'execute', 'report', 'qa', 'postlaunch', 'rollback', 'ingest', 'model', 'design_plan'));
`,
  },
];
