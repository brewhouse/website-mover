import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getJob } from '@wm/db';
import { Badge, Card, Empty, LinkButton, Notice, PageHeader, Stat, when } from '@/components/ui';
import { DOWNLOADS, loadReport } from '@/lib/job-files';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: `Report ${(await params).id}` };
}

const LABELS: Record<string, string> = { page: 'Pages', post: 'News posts', document: 'Documents', image: 'Images', event: 'Events', person: 'People', form: 'Forms', record: 'Custom entries' };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getJob(id))) notFound();
  const r = await loadReport(id);
  if (!r) {
    return (
      <>
        <PageHeader title={`Report ${id}`} />
        <Notice tone="warn">No report yet: it’s built after the migration runs.</Notice>
      </>
    );
  }
  const rows = Object.entries(r.counts).filter(([, c]) => c.planned || c.created || c.failed);
  const failed = rows.reduce((n, [, c]) => n + c.failed, 0);
  const notLive = r.notLive.length;
  const broken = r.redirects.broken.length;
  const ok = !failed && !notLive && !broken && !r.invalid.length;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link href={`/jobs/${id}`} className="text-muted hover:text-ink">
              {id}
            </Link>
            <span className="text-muted">/</span> Report
            {ok ? <Badge tone="ok">all verified</Badge> : <Badge tone="bad">needs attention</Badge>}
          </span>
        }
        subtitle={`Plan v${r.planVersion}, approved by ${r.approvedBy} · ran ${when(r.ranAt)} against ${r.target}`}
        actions={Object.keys(DOWNLOADS).map((name) => (
          <LinkButton key={name} href={`/api/jobs/${id}/files/${name}`} prefetch={false}>
            {name}
          </LinkButton>
        ))}
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Failures" value={failed} />
        <Stat label="Not answering 200" value={notLive} />
        <Stat label="Redirects working" value={r.redirects.working ?? '—'} hint={`of ${r.redirects.total}${r.redirects.imported === null ? ' (CSV only)' : ''}`} />
        <Stat label="Block problems" value={r.invalid.length} />
      </div>
      <div className="grid gap-6">
        <Card title="Counts">
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th className="text-right">Planned</th>
                <th className="text-right">Created</th>
                <th className="text-right">Updated</th>
                <th className="text-right">Failed</th>
                <th className="text-right">Live (200)</th>
                <th className="text-right">Block problems</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([kind, c]) => (
                <tr key={kind}>
                  <td className="font-medium">{LABELS[kind] ?? kind}</td>
                  {[c.planned, c.created, c.updated, c.failed, c.live, c.invalidBlocks].map((n, i) => (
                    <td key={i} className={`text-right tabular-nums ${i === 3 && n ? 'text-bad' : ''}`}>
                      {n}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-line px-4 py-2 text-xs text-muted">
            Existing content trashed: {r.cleanup.trashed} of {r.cleanup.planned}.
          </p>
        </Card>
        {r.failures.length > 0 && (
          <Card title={`Failures (${r.failures.length})`}>
            <ul className="divide-y divide-line text-sm">
              {r.failures.map((f, i) => (
                <li key={i} className="px-4 py-2">
                  <Badge tone="bad">{f.kind}</Badge> <span className="font-mono text-xs">{f.sourceKey}</span> at {f.step}: <span className="text-muted">{f.error}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        {r.site && (
          <Card title="Site structure">
            <div className="grid gap-2 p-4 text-sm">
              <p>
                Homepage slides: {r.site.homeSlides} · quick links: {r.site.homeQuickLinks ?? 0} · menus:{' '}
                {Object.entries(r.site.menus)
                  .map(([n, c]) => `${n} (${c})`)
                  .join(', ') || 'none'}
              </p>
              {r.site.warnings.map((w, i) => (
                <p key={i} className="text-warn">
                  ! {w}
                </p>
              ))}
            </div>
          </Card>
        )}
        {(notLive > 0 || broken > 0 || r.invalid.length > 0) && (
          <Card title="To check">
            <ul className="grid gap-1 p-4 font-mono text-xs">
              {r.notLive.map((n) => (
                <li key={n.path}>
                  {n.path} → {n.status}
                </li>
              ))}
              {r.redirects.broken.map((b) => (
                <li key={b.from}>
                  {b.from} → expected {b.to}, got {b.got}
                </li>
              ))}
              {r.invalid.map((i) => (
                <li key={i.sourceKey}>
                  {i.sourceKey}: {i.errors.join('; ')}
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card title="Warnings">
          {Object.keys(r.warnings).length ? (
            <table className="data">
              <tbody>
                {Object.entries(r.warnings)
                  .sort((a, b) => b[1] - a[1])
                  .map(([w, n]) => (
                    <tr key={w}>
                      <td>{w}</td>
                      <td className="text-right tabular-nums">{n}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <Empty>No warnings.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
