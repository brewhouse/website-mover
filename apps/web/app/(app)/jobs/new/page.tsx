import { listTargets } from '@wm/db';
import { LinkButton, Notice, PageHeader } from '@/components/ui';
import { NewJobForm } from './new-job-form';
import { requireUser } from '@/lib/session';

export const metadata = { title: 'New job' };

export default async function NewJobPage() {
  await requireUser();
  const targets = await listTargets();
  return (
    <>
      <PageHeader
        title="New job"
        subtitle="The tool scans the source, analyzes it and proposes a plan. Nothing is written to WordPress until someone approves the plan."
        actions={<LinkButton href="/jobs/new/design">Build from design instead</LinkButton>}
      />
      {targets.length ? <NewJobForm targets={targets.map((t) => ({ id: t.id, label: `${t.name} (${t.url})` }))} timezones={Intl.supportedValuesOf('timeZone')} /> : <Notice tone="warn">Add a target first (Targets).</Notice>}
    </>
  );
}
