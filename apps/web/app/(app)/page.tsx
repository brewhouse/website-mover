import Link from 'next/link';
import { listJobs } from '@wm/db';
import { RunStatus } from '@/components/run-status';
import { Badge, Card, Empty, LinkButton, PageHeader, when } from '@/components/ui';
import { planHeadline } from '@/lib/job-files';
import { requireUser } from '@/lib/session';

export const metadata = { title: 'Jobs' };

export default async function JobsPage() {
  await requireUser();
  const jobs = await listJobs();
  const plans = await Promise.all(jobs.map((j) => planHeadline(j.id).catch(() => null)));
  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Each job moves one source site into one WordPress target."
        actions={
          <LinkButton href="/jobs/new" variant="primary">
            New job
          </LinkButton>
        }
      />
      <Card>
        {jobs.length ? (
          <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Source</th>
                  <th>Target</th>
                  <th>Last stage</th>
                  <th>Plan</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, i) => {
                  const plan = plans[i];
                  return (
                    <tr key={job.id}>
                      <td>
                        <Link href={`/jobs/${job.id}`} className="font-medium text-brand hover:underline">
                          {job.id}
                        </Link>
                      </td>
                      <td className="text-muted">{new URL(job.sourceUrl).host}</td>
                      <td>{job.targetName}</td>
                      <td>
                        <RunStatus run={job.lastRun} />
                      </td>
                      <td>
                        {plan ? (
                          <span className="flex items-center gap-2">
                            v{plan.version}
                            {plan.approved ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">to review</Badge>}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="text-muted">
                        {when(job.createdAt)} · {job.createdBy}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No jobs yet. Start one with “New job”.</Empty>
        )}
      </Card>
    </>
  );
}
