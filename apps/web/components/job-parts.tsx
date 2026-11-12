/** Pieces of the job page shared by migration and design jobs. */
import type { StageRun } from '@wm/db';
import { RunStatus } from './run-status';
import { when } from './ui';

export function RunsTable({ runs }: { runs: StageRun[] }) {
  const took = (r: StageRun) => (r.startedAt && r.finishedAt ? `${Math.max(1, Math.round((+new Date(r.finishedAt) - +new Date(r.startedAt)) / 1000))} s` : '—');
  return (
    <div className="max-h-80 overflow-y-auto">
      <table className="data">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Requested</th>
            <th>Took</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <RunStatus run={r} />
              </td>
              <td className="text-muted">
                {when(r.queuedAt)}
                {r.requestedBy ? ` · ${r.requestedBy}` : ''}
              </td>
              <td className="tabular-nums">{took(r)}</td>
              <td className="max-w-md text-muted">{r.error ? <span className="text-bad">{r.error}</span> : summarize(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarize(r: StageRun): string {
  const s = (r.summary ?? {}) as Record<string, unknown>;
  if (r.stage === 'plan' && s.version) return `Plan v${s.version}, ${s.warnings} warnings`;
  if (r.stage === 'execute' && 'objects' in s) return `${s.objects} objects, ${s.failures} failures, ${s.redirects} redirects`;
  if (r.stage === 'report' && 'failures' in s) return `${s.failures} failures`;
  if (r.stage === 'scan' && 'pages' in s) return `${s.pages} pages`;
  if (r.stage === 'design_plan' && s.version) return `Design plan v${s.version}, ${s.warnings} warnings`;
  if (r.stage === 'design_build' && s.version) return `Built plan v${s.version}: ${s.entries} pages and entries, ${s.media} images, ${s.menus} menus, ${s.failures} failed, ${s.warnings} warnings`;
  if (r.stage === 'design_rollback' && s.trashed !== undefined) return `Rolled back: ${s.trashed} trashed, ${s.groupsRestored} field groups restored, ${s.problems} problems`;
  if (r.stage === 'design_theme' && s.version) return `Theme change set v${s.version}: ${s.files} files, lint ${s.lint}, ${s.warnings} warnings`;
  if (r.stage === 'ingest' && 'pages' in s) return `${s.pages} pages, ${s.frames} frames${s.unmatched ? `, ${s.unmatched} unmatched` : ''}`;
  if (r.stage === 'model' && 'components' in s) return `${s.components} components in ${s.sections} sections`;
  return '';
}

export function describe(action: string, detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  switch (action) {
    case 'job.create':
      return d.kind === 'design' ? 'created the design job (use of the designs confirmed)' : 'created the job (rights confirmed)';
    case 'design.theme_download':
      return `downloaded theme change set v${d.version} (${d.name})`;
    case 'design.upload':
      return `uploaded ${d.name} (${Math.round(Number(d.bytes) / 1024 / 1024)} MB)`;
    case 'job.register':
      return `registered the job on ${d.target}`;
    case 'run':
      return `ran ${(d.stages as string[]).join(' → ')}`;
    case 'plan.approve':
      return `approved plan v${d.version}`;
    case 'job.options':
      return `set options: ${Object.entries(d).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`;
    default:
      if (action.startsWith('design.')) return `changed the design plan: ${action.slice(7)} ${d.page ?? d.key ?? d.frameId ?? ''}`;
      return action.startsWith('decision.') ? `${action.slice(9)} ${d.key ?? d.id ?? ''}${d.slug !== undefined ? ` → ${d.slug ?? '(source slug)'}` : ''}${d.type !== undefined ? ` → ${d.type ?? '(as source)'}` : ''}` : action;
  }
}
