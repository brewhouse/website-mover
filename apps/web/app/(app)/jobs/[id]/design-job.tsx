import { stat } from 'node:fs/promises';
import { jobPath } from '@wm/core';
import { listAudit, listRuns, recentEvents, type Job } from '@wm/db';
import { designState, latestBuildState, latestThemeManifest, type BuildState, type ThemeManifest } from '@wm/design/review';
import { ReplaceInput } from '@/components/design-upload';
import { describe, RunsTable } from '@/components/job-parts';
import { LiveLog } from '@/components/live-log';
import { RunStatus } from '@/components/run-status';
import { Badge, Card, Empty, LinkButton, Notice, PageHeader, when, type Tone } from '@/components/ui';
import { DESIGN_INPUTS, type DesignInput } from '@/lib/design-inputs';
import { DesignRunButtons } from './design-run-buttons';

const STEPS = [
  ['ingest', 'Ingest'],
  ['model', 'Model'],
  ['design_plan', 'Plan'],
  ['approve', 'Review & approve'],
  ['design_theme', 'Theme change set'],
  ['build', 'Build'],
] as const;

/** The job page of a build-from-design job (docs/build/PLAN.md). */
export async function DesignJob({ job, canApprove }: { job: Job; canApprove: boolean }) {
  const id = job.id;
  const [runs, events, state, auditTrail, theme, build] = await Promise.all([listRuns(id), recentEvents(id), designState(id).catch(() => null), listAudit(id, 20), latestThemeManifest(id), latestBuildState(id)]);
  const inputs = Object.fromEntries(
    await Promise.all(
      (Object.keys(DESIGN_INPUTS) as DesignInput[]).map(async (name) => {
        const s = await stat(jobPath(id, 'inputs', name)).catch(() => null);
        return [name, s ? `${(s.size / 1024 / 1024).toFixed(1)} MB, uploaded ${when(s.mtime)}` : null] as const;
      }),
    ),
  ) as Record<DesignInput, string | null>;
  const active = runs.find((r) => r.status === 'queued' || r.status === 'running');
  const lastOf = (stage: string) => runs.find((r) => r.stage === stage) ?? null;
  const step = (s: (typeof STEPS)[number][0]): { tone: Tone; text: string } => {
    if (s === 'approve') {
      if (!state) return { tone: 'neutral', text: 'no plan yet' };
      return state.approved ? { tone: 'ok', text: `v${state.plan.version} by ${state.approval!.approvedBy}` } : { tone: 'warn', text: `v${state.plan.version} to review` };
    }
    if (s === 'build') {
      const run = lastOf('design_build');
      if (build?.rolledBackAt) return { tone: 'neutral', text: 'rolled back' };
      if (run?.status === 'done' && build) return { tone: build.failures.length ? 'warn' : 'ok', text: `v${build.planVersion} on target` };
      return run ? { tone: run.status === 'failed' ? 'bad' : 'info', text: run.status } : { tone: 'neutral', text: 'not run' };
    }
    if (s === 'design_theme' && lastOf(s)?.status === 'done' && theme) return { tone: theme.lint === 'errors' ? 'warn' : 'ok', text: `v${theme.planVersion}` };
    const run = lastOf(s);
    if (!run) return { tone: 'neutral', text: 'not run' };
    const tone: Tone = run.status === 'done' ? 'ok' : run.status === 'failed' ? 'bad' : 'info';
    return { tone, text: s === 'design_plan' && run.status === 'done' && state ? `v${state.plan.version}` : run.status };
  };
  const missing = (Object.keys(DESIGN_INPUTS) as DesignInput[]).filter((n) => !inputs[n]);

  return (
    <>
      <PageHeader
        title={job.id}
        subtitle={
          <>
            Build from design ·{' '}
            <a href={job.sourceUrl} className="text-brand hover:underline" target="_blank" rel="noreferrer">
              Figma
            </a>{' '}
            → {job.targetName}
          </>
        }
        actions={
          state && (
            <LinkButton href={`/jobs/${id}/design`} variant={state.approved ? 'secondary' : 'primary'}>
              Review design plan v{state.plan.version}
            </LinkButton>
          )
        }
      />

      <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {STEPS.map(([s, label], i) => {
          const st = step(s);
          return (
            <li key={s} className="rounded-lg border border-line bg-panel px-3 py-2">
              <div className="text-xs text-muted">
                {i + 1}. {label}
              </div>
              <div className="mt-1">
                <Badge tone={st.tone}>{st.text}</Badge>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="grid min-w-0 gap-6">
          <Card title="Live log" actions={active && <RunStatus run={active} />}>
            <LiveLog jobId={id} initial={events.map((e) => ({ ...e, at: new Date(e.at).toISOString() }))} />
          </Card>
          <Card title="Stage runs">{runs.length ? <RunsTable runs={runs} /> : <Empty>Nothing has run yet.</Empty>}</Card>
        </div>
        <div className="grid content-start gap-6">
          <Card title="Run">
            <DesignRunButtons
              jobId={id}
              busy={!!active}
              choices={[
                { run: 'all', label: 'Ingest → plan', help: 'Unpack the uploads, read Figma, screenshot the mockups, model them and make a new plan version.', disabled: missing.length ? `Upload first: ${missing.map((n) => DESIGN_INPUTS[n]).join(', ')}.` : false },
                { run: 'model', label: 'Model → plan', help: 'Read the target’s content types again and re-model, then plan.', disabled: lastOf('ingest')?.status === 'done' ? false : 'Ingest first.' },
                { run: 'plan', label: 'Re-plan', help: 'A new plan version with the reviewers’ decisions (and the AI, when it’s set up).', disabled: lastOf('model')?.status === 'done' ? false : 'Model first.' },
                { run: 'theme', label: 'Theme change set', help: 'The theme files for the approved plan: templates, blocks, header, sidebar, footer and the mockup’s assets, linted, as a zip and a patch.', disabled: state?.approved ? false : 'Approve the design plan first.' },
                { run: 'build', label: `Build on ${job.targetName}`, help: 'Creates the post types, taxonomies and fields, uploads the images, and makes the sample pages, entries and menus on the target. Running it again updates what it made.', disabled: !canApprove ? 'Only approvers can build on the target.' : state?.approved ? false : 'Approve the design plan first.' },
                ...(build && !build.rolledBackAt ? [{ run: 'rollback', label: 'Roll back the build', help: 'Trashes what the build created and puts back the field groups, menus and front page it changed. The theme is reverted with git.', disabled: (!canApprove ? 'Only approvers can roll back.' : false) as string | false }] : []),
              ]}
            />
          </Card>
          <ThemeCard jobId={id} theme={theme} approvedVersion={state?.approved ? state.plan.version : null} />
          <BuildCard build={build} approvedVersion={state?.approved ? state.plan.version : null} />
          <Card title="Inputs">
            <div className="grid gap-4 p-4">
              {(Object.keys(DESIGN_INPUTS) as DesignInput[]).map((name) => (
                <ReplaceInput key={name} jobId={id} name={name} present={inputs[name]} />
              ))}
            </div>
          </Card>
          <Card title="Activity">
            {auditTrail.length ? (
              <ul className="divide-y divide-line text-sm">
                {auditTrail.map((a) => (
                  <li key={a.id} className="px-4 py-2">
                    <div>
                      <span className="font-medium">{a.user ?? 'system'}</span> <span className="text-muted">{describe(a.action, a.detail)}</span>
                    </div>
                    <div className="text-xs text-muted">{when(a.at)}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No activity yet.</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

/** What the last build did on the target. */
function BuildCard({ build, approvedVersion }: { build: BuildState | null; approvedVersion: number | null }) {
  if (!build) return null;
  const targetUrl = build.targetUrl ?? null;
  const entries = Object.values(build.entities).filter((e) => e.kind === 'entry');
  const media = Object.values(build.entities).length - entries.length;
  const pages = entries.filter((e) => e.postType === 'page');
  return (
    <Card title={`Build v${build.planVersion}`}>
      <div className="grid gap-3 p-4 text-sm">
        {build.rolledBackAt && <Notice tone="info">Rolled back {when(new Date(build.rolledBackAt))}.</Notice>}
        {!build.rolledBackAt && approvedVersion !== null && approvedVersion !== build.planVersion && <Notice tone="warn">Built from plan v{build.planVersion}; v{approvedVersion} is approved now. Build again.</Notice>}
        {!build.finishedAt && !build.rolledBackAt && <Notice tone="warn">The last build didn’t finish; run it again to complete it.</Notice>}
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">{entries.length} pages and entries</Badge>
          <Badge tone="neutral">{media} images</Badge>
          <Badge tone="neutral">{Object.keys(build.menus).length} menus</Badge>
          {build.failures.length > 0 && <Badge tone="bad">{build.failures.length} failed</Badge>}
          {build.warnings.length > 0 && <Badge tone="warn">{build.warnings.length} to check</Badge>}
        </div>
        {targetUrl && pages.length > 0 && !build.rolledBackAt && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">Pages on the target</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {pages.map((p) => (
                <li key={p.id}>
                  <a className="text-brand hover:underline" href={new URL(p.path, targetUrl).toString()} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        )}
        {build.failures.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-bad">
            {build.failures.map((f, i) => (
              <li key={i}>
                {f.step}: {f.error}
              </li>
            ))}
          </ul>
        )}
        {build.warnings.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">What to check</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {build.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-xs text-muted">{build.finishedAt ? `Finished ${when(new Date(build.finishedAt))}` : `Started ${when(new Date(build.startedAt))}`} · approved by {build.approvedBy}.</p>
      </div>
    </Card>
  );
}

/** The latest theme change set: downloads, lint and what to check. */
function ThemeCard({ jobId, theme, approvedVersion }: { jobId: string; theme: ThemeManifest | null; approvedVersion: number | null }) {
  if (!theme) return null;
  const href = (name: string) => `/api/jobs/${jobId}/theme/${theme.planVersion}/${name}`;
  const replaced = theme.files.filter((f) => f.action === 'replace').length;
  const lintErrors = theme.files.filter((f) => f.lint === 'error');
  return (
    <Card title={`Theme change set v${theme.planVersion}`}>
      <div className="grid gap-3 p-4 text-sm">
        {approvedVersion !== null && approvedVersion !== theme.planVersion && <Notice tone="warn">Made from plan v{theme.planVersion}; v{approvedVersion} is approved now. Run “Theme change set” again.</Notice>}
        <div className="flex flex-wrap gap-2">
          <Badge tone={theme.lint === 'ok' ? 'ok' : theme.lint === 'errors' ? 'bad' : 'neutral'}>{theme.lint === 'ok' ? 'PHP lint passes' : theme.lint === 'errors' ? `${lintErrors.length} lint errors` : 'not linted'}</Badge>
          <Badge tone="neutral">{replaced} replaced, {theme.files.length - replaced} new</Badge>
          {(theme.removals?.length ?? 0) > 0 && <Badge tone="warn">{theme.removals!.length} to delete</Badge>}
          {theme.warnings.length > 0 && <Badge tone="warn">{theme.warnings.length} to check</Badge>}
        </div>
        {(theme.removals?.length ?? 0) > 0 && (
          <p className="text-xs text-muted">
            Delete with git (the zip can’t): {theme.removals!.map((r) => r.path).join(', ')}. The README has the command.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {/* Plain links: these are file downloads, not pages. */}
          <a href={href('zip')} download className="rounded-md border border-brand bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
            Download zip
          </a>
          {theme.patch && (
            <a href={href('patch')} download className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:bg-canvas">
              Patch
            </a>
          )}
          <a href={href('readme')} download className="rounded-md border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:bg-canvas">
            README
          </a>
        </div>
        <p className="text-xs text-muted">For the team to review and commit to the site’s repo ({theme.theme}); the README says how. Copy the files over the theme, never replace a folder. Made {when(new Date(theme.createdAt))}.</p>
        {lintErrors.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-bad">
            {lintErrors.map((f) => (
              <li key={f.path}>
                {f.path}: {f.lintMessage}
              </li>
            ))}
          </ul>
        )}
        {theme.warnings.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">What to check</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {theme.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}
