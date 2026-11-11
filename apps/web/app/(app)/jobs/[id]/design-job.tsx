import { stat } from 'node:fs/promises';
import { jobPath } from '@wm/core';
import { listAudit, listRuns, recentEvents, type Job } from '@wm/db';
import { designState } from '@wm/design/review';
import { ReplaceInput } from '@/components/design-upload';
import { describe, RunsTable } from '@/components/job-parts';
import { LiveLog } from '@/components/live-log';
import { RunStatus } from '@/components/run-status';
import { Badge, Card, Empty, LinkButton, PageHeader, when, type Tone } from '@/components/ui';
import { DESIGN_INPUTS, type DesignInput } from '@/lib/design-inputs';
import { DesignRunButtons } from './design-run-buttons';

const STEPS = [
  ['ingest', 'Ingest'],
  ['model', 'Model'],
  ['design_plan', 'Plan'],
  ['approve', 'Review & approve'],
  ['build', 'Theme & build'],
] as const;

/** The job page of a build-from-design job (docs/build/PLAN.md). */
export async function DesignJob({ job }: { job: Job }) {
  const id = job.id;
  const [runs, events, state, auditTrail] = await Promise.all([listRuns(id), recentEvents(id), designState(id).catch(() => null), listAudit(id, 20)]);
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
    if (s === 'build') return { tone: 'neutral', text: 'B3–B4, coming' };
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

      <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-5">
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
              ]}
            />
          </Card>
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
