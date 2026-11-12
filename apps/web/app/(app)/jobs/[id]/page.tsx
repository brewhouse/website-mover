import { notFound } from 'next/navigation';
import { getJob, listAudit, listRuns, recentEvents } from '@wm/db';
import { LiveLog } from '@/components/live-log';
import { RunStatus } from '@/components/run-status';
import { describe, RunsTable } from '@/components/job-parts';
import { Badge, Card, Empty, LinkButton, PageHeader, when, type Tone } from '@/components/ui';
import { loadReport, planState, stagesOnDisk } from '@/lib/job-files';
import { DesignJob } from './design-job';
import { JobOptionsForm, LiveUrlForm, RollbackForm, RunButtons, type RunChoice } from './run-buttons';
import { requireUser } from '@/lib/session';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: (await params).id };
}

const STEPS = ['scan', 'extract', 'analyze', 'plan', 'approve', 'execute', 'report', 'qa'] as const;

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();
  if (job.kind === 'design') return <DesignJob job={job} canApprove={user.canApprove} />;
  const [runs, events, plan, report, auditTrail, onDisk] = await Promise.all([listRuns(id), recentEvents(id), planState(id), loadReport(id), listAudit(id, 20), stagesOnDisk(id)]);
  const active = runs.find((r) => r.status === 'queued' || r.status === 'running');
  const lastOf = (stage: string) => runs.find((r) => r.stage === stage) ?? null;

  const step = (s: (typeof STEPS)[number]): { tone: Tone; text: string } => {
    if (s === 'approve') {
      if (!plan) return { tone: 'neutral', text: 'no plan yet' };
      return plan.approved ? { tone: 'ok', text: `v${plan.plan.version} by ${plan.approval!.approvedBy}` } : { tone: 'warn', text: `v${plan.plan.version} to review` };
    }
    const run = lastOf(s);
    if (!run) {
      if (s === 'plan' && plan) return { tone: 'ok', text: `v${plan.plan.version}` };
      return onDisk.has(s) ? { tone: 'ok', text: 'done (CLI)' } : { tone: 'neutral', text: 'not run' };
    }
    const tone: Tone = run.status === 'done' ? 'ok' : run.status === 'failed' ? 'bad' : 'info';
    return { tone, text: s === 'plan' && run.status === 'done' && plan ? `v${plan.plan.version}` : run.status };
  };

  const choices: RunChoice[] = [
    { run: 'through-plan', label: 'Scan → plan', help: 'Crawl the source again, extract, analyze and make a new plan version.' },
    { run: 'analyze', label: 'Analyze → plan', help: 'Re-run the analysis on the current scan, then plan.' },
    { run: 'plan', label: 'Re-plan', help: 'A new plan version with the reviewer decisions; the scan is unchanged.' },
    {
      run: 'execute',
      label: 'Run the migration',
      help: `Writes approved plan v${plan?.plan.version} to ${job.targetName}, then builds the report and runs QA.`,
      primary: true,
      disabled: !user.canApprove ? 'Only approvers can run a migration.' : !plan ? 'Needs a plan.' : !plan.approved ? `Plan v${plan.plan.version} needs approval first (Review).` : false,
    },
    { run: 'report', label: 'Rebuild the report', help: 'Re-check the target: live URLs, blocks, redirects.', disabled: lastOf('execute') || onDisk.has('execute') ? false : 'Run the migration first.' },
    {
      run: 'postlaunch',
      label: 'Post-launch check',
      help: `Every legacy URL and the GA4 tag on ${job.liveUrl ?? `the target (set the live address below once launched)`}.`,
      disabled: lastOf('execute') || onDisk.has('execute') ? false : 'Run the migration first.',
    },
    { run: 'qa', label: 'Run QA', help: 'Accessibility (WCAG 2.1 AA) and phone/tablet/desktop checks with screenshots.', disabled: lastOf('execute') || onDisk.has('execute') ? false : 'Run the migration first.' },
  ];

  return (
    <>
      <PageHeader
        title={job.id}
        subtitle={
          <>
            {job.sourceUrl} → {job.targetName} · {job.profile} profile{job.timezone ? ` · ${job.timezone}` : ''}
            {job.options.incremental ? ' · incremental' : ''}
            {job.options.contentOnly ? ' · content only' : ''}
            {job.options.sideNavMenu ? ' · side nav in main menu' : ''}
            {job.options.sideNavPages ? ' · side nav on pages' : ''}
          </>
        }
        actions={
          <>
            {plan && (
              <LinkButton href={`/jobs/${id}/review`} variant={plan.approved ? 'secondary' : 'primary'}>
                Review plan v{plan.plan.version}
              </LinkButton>
            )}
            {report && <LinkButton href={`/jobs/${id}/report`}>Report</LinkButton>}
          </>
        }
      />

      <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {STEPS.map((s, i) => {
          const st = step(s);
          return (
            <li key={s} className="rounded-lg border border-line bg-panel px-3 py-2">
              <div className="text-xs text-muted">
                {i + 1}. {s === 'approve' ? 'Review & approve' : s === 'qa' ? 'QA' : s[0]!.toUpperCase() + s.slice(1)}
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
            <RunButtons jobId={id} choices={choices} busy={!!active} />
          </Card>
          <Card title="Options">
            <JobOptionsForm jobId={id} options={job.options} planned={plan?.plan.options ?? null} />
          </Card>
          <Card title="Live address">
            <LiveUrlForm jobId={id} liveUrl={job.liveUrl} />
          </Card>
          {user.canApprove && (lastOf('execute') || onDisk.has('execute')) && (
            <Card title="Roll back">
              <RollbackForm jobId={id} targetName={job.targetName} busy={!!active} />
            </Card>
          )}
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
