import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getJob, listRuns } from '@wm/db';
import { Badge, Card, LinkButton, Notice, PageHeader, when } from '@/components/ui';
import { planState, previousPlan } from '@/lib/job-files';
import { ApproveForm, ReplanButton } from './approve-form';
import { ChangesTab, CleanupTab, DecisionsTab, FilesTab, FormsTab, MeetingsTab, PagesTab, RecordsTab, SiteTab, SkippedTab, SummaryTab, WarningsTab, type TabProps } from './tabs';
import { requireUser } from '@/lib/session';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: `Review ${(await params).id}` };
}

const TABS = {
  summary: { label: 'Summary', render: SummaryTab },
  pages: { label: 'Pages & posts', render: PagesTab },
  skipped: { label: 'Not migrated', render: SkippedTab },
  files: { label: 'Files', render: FilesTab },
  meetings: { label: 'Meetings', render: MeetingsTab },
  records: { label: 'Records', render: RecordsTab },
  forms: { label: 'Forms', render: FormsTab },
  site: { label: 'Site & menus', render: SiteTab },
  cleanup: { label: 'Existing content', render: CleanupTab },
  warnings: { label: 'Warnings', render: WarningsTab },
  decisions: { label: 'Decisions', render: DecisionsTab },
  changes: { label: 'Changes', render: ChangesTab },
} as const;
type TabName = keyof typeof TABS;

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; q?: string; page?: string }> }) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const job = await getJob(id);
  if (!job) notFound();
  const state = await planState(id);
  if (!state) {
    return (
      <>
        <PageHeader title={`Review ${id}`} />
        <Notice tone="warn">There’s no plan yet. Run the job through to the plan first.</Notice>
      </>
    );
  }
  const { plan, decisions, approved, approval, pendingDecisions } = state;
  const tab: TabName = sp.tab && sp.tab in TABS ? (sp.tab as TabName) : 'summary';
  // Only the Changes tab compares with the previous version (a plan can be megabytes).
  const [previous, runs] = await Promise.all([tab === 'changes' ? previousPlan(id, plan.version) : null, listRuns(id, 1)]);
  const busy = runs[0]?.status === 'queued' || runs[0]?.status === 'running';
  const props: TabProps = { jobId: id, plan, decisions, q: sp.q ?? '', page: Number(sp.page) || 1, previous, query: { tab, ...(sp.q ? { q: sp.q } : {}) } };
  const Tab = TABS[tab].render;
  const counts: Partial<Record<TabName, number>> = {
    pages: plan.items.length,
    skipped: plan.notMigrated.length,
    files: plan.media.length,
    meetings: plan.events.length,
    records: plan.people.length + plan.records.length + plan.tables.length,
    forms: plan.forms.length,
    cleanup: plan.cleanup.length,
    warnings: plan.warnings.length,
    decisions: decisions.exclude.length + decisions.include.length + Object.keys(decisions.type).length + Object.keys(decisions.slug).length + decisions.keep.length,
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link href={`/jobs/${id}`} className="text-muted hover:text-ink">
              {id}
            </Link>
            <span className="text-muted">/</span> Plan v{plan.version}
            {approved ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">not approved</Badge>}
          </span>
        }
        subtitle={
          <>
            {plan.source.origin} → {plan.target.name} ({plan.target.url}) · made {when(plan.createdAt)} · <span className="font-mono">{state.sha256.slice(0, 12)}</span>
          </>
        }
        actions={<LinkButton href={`/jobs/${id}`}>Job page</LinkButton>}
      />

      <div className="mb-6 grid gap-4">
        {pendingDecisions && (
          <Notice tone="warn">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>You have changes that aren’t in plan v{plan.version} yet (highlighted rows). Re-plan to see their effect; the new version needs its own approval.</span>
              <ReplanButton jobId={id} />
            </div>
          </Notice>
        )}
        <Card title="Approval">
          <div className="p-4">
            {approved ? (
              <p className="text-sm">
                Approved by <strong>{approval!.approvedBy}</strong> on {when(approval!.approvedAt)}. Execution follows exactly this plan.{' '}
                <Link href={`/jobs/${id}`} className="text-brand hover:underline">
                  Run the migration from the job page.
                </Link>
              </p>
            ) : (
              <>
                {approval && <p className="mb-3 text-sm text-muted">The last approval was for v{approval.planVersion}; this version needs its own.</p>}
                <ApproveForm
                  jobId={id}
                  version={plan.version}
                  sha256={state.sha256}
                  disabled={busy ? 'A stage is running.' : pendingDecisions ? 'Re-plan first: your changes aren’t in this version.' : undefined}
                />
              </>
            )}
          </div>
        </Card>
      </div>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line" aria-label="Plan sections">
        {(Object.keys(TABS) as TabName[]).map((name) => (
          <Link
            key={name}
            href={`?tab=${name}`}
            aria-current={name === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${name === tab ? 'border-brand font-medium text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {TABS[name].label}
            {counts[name] !== undefined && <span className="ml-1.5 text-xs text-muted tabular-nums">{counts[name]}</span>}
          </Link>
        ))}
      </nav>
      <Tab {...props} />
    </>
  );
}
