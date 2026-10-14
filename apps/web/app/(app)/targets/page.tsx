import { listTargets } from '@wm/db';
import { Card, Empty, PageHeader, when } from '@/components/ui';
import { AddTargetForm, TestTargetButton } from './target-forms';

export const metadata = { title: 'Targets' };

export default async function TargetsPage() {
  const targets = await listTargets();
  return (
    <>
      <PageHeader title="Targets" subtitle="WordPress seed sites the tool writes to. Each needs the Website Mover Bridge plugin and an administrator’s Application Password." />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card title="Saved targets">
          {targets.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Site</th>
                  <th>User</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => (
                  <tr key={t.id}>
                    <td className="font-medium">{t.name}</td>
                    <td className="text-muted">{t.url}</td>
                    <td>{t.wpUser}</td>
                    <td className="text-muted">{when(t.createdAt)}</td>
                    <td className="text-right">
                      <TestTargetButton targetId={t.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No targets yet.</Empty>
          )}
        </Card>
        <Card title="Add a target">
          <AddTargetForm />
        </Card>
      </div>
    </>
  );
}
