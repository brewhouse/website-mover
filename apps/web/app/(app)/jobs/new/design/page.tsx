import { listTargets } from '@wm/db';
import { LinkButton, Notice, PageHeader } from '@/components/ui';
import { requireUser } from '@/lib/session';
import { DesignJobForm } from './design-job-form';

export const metadata = { title: 'New design job' };

export default async function NewDesignJobPage() {
  await requireUser();
  const targets = await listTargets();
  return (
    <>
      <PageHeader
        title="Build from design"
        subtitle="The tool reads the mockups and the Figma file, matches them to the framework theme and the target’s content types, and proposes a plan. Nothing is written to WordPress until someone approves it."
        actions={<LinkButton href="/jobs/new">Migrate a site instead</LinkButton>}
      />
      {targets.length ? <DesignJobForm targets={targets.map((t) => ({ id: t.id, label: `${t.name} (${t.url})` }))} /> : <Notice tone="warn">Add a target first (Targets).</Notice>}
    </>
  );
}
