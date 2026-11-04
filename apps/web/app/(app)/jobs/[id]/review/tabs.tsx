import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Plan, ReviewDecisions } from '@wm/planner';
import { Badge, Button, Card, Empty, inputClass, Stat } from '@/components/ui';
import { setExcluded, setIncluded, setKept, setSlug, setSlugTo, setType } from '@/lib/actions';
import { FilterBox } from './filter-box';

export interface TabProps {
  jobId: string;
  plan: Plan;
  decisions: ReviewDecisions;
  q: string;
  page: number;
  previous: Plan | null;
  /** The tab and filter, kept in pager links. */
  query: Record<string, string>;
}

const EXCLUDED = 'Excluded by the reviewer';
const PAGE_SIZE = 100;
const mb = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const matches = (q: string, ...fields: (string | null | undefined)[]) => !q || fields.some((f) => f?.toLowerCase().includes(q.toLowerCase()));

/** A one-button form running a bound server action. */
function Act({ action, children, variant = 'secondary' }: { action: () => Promise<void>; children: ReactNode; variant?: 'secondary' | 'danger' | 'ghost' | 'primary' }) {
  return (
    <form action={action}>
      <Button size="sm" variant={variant} type="submit">
        {children}
      </Button>
    </form>
  );
}

function Paged<T>({ rows, page, query, render, empty }: { rows: T[]; page: number; query: Record<string, string>; render: (rows: T[]) => ReactNode; empty: string }) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <>
      <div className="overflow-x-auto">{render(rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE))}</div>
      {pages > 1 && (
        <nav className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted" aria-label="Pages">
          <span>
            {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, rows.length)} of {rows.length}
          </span>
          <span className="flex gap-1">
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <Link key={n} href={`?${new URLSearchParams({ ...query, page: String(n) })}`} aria-current={n === current ? 'page' : undefined} className={`rounded px-2 py-0.5 ${n === current ? 'bg-brand text-brand-ink' : 'hover:bg-canvas'}`}>
                {n}
              </Link>
            ))}
          </span>
        </nav>
      )}
    </>
  );
}
function SourceLink({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
      {children ?? new URL(url).pathname + new URL(url).search}
    </a>
  );
}

// ---------------------------------------------------------------- Summary

export function SummaryTab({ plan }: TabProps) {
  const e = plan.expected;
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Pages" value={e.pages} />
        <Stat label="News posts" value={e.posts} />
        <Stat label="Events" value={e.events} />
        <Stat label="Documents" value={e.documents} hint={mb(plan.media.filter((m) => m.type === 'document').reduce((n, m) => n + m.bytes, 0))} />
        <Stat label="Images" value={e.images} />
        <Stat label="Redirects" value={e.redirects} />
        <Stat label="People" value={e.people} />
        <Stat label="Forms rebuilt" value={e.forms} hint={`${plan.forms.length - e.forms} flagged`} />
        <Stat label="Custom entries" value={e.records} />
        <Stat label="Tables" value={e.tables} />
        <Stat label="Trashed on the target" value={e.cleanup} />
        <Stat label="Not migrated" value={plan.notMigrated.length} />
      </div>
      <Card title="Source and target">
        <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-[160px_1fr]">
          <dt className="text-muted">Source</dt>
          <dd>
            {plan.source.origin} ({plan.source.profile} profile)
          </dd>
          <dt className="text-muted">Target</dt>
          <dd>
            {plan.target.name}: {plan.target.url} · WordPress {plan.target.wordpress} · theme {plan.target.theme} · Redirection {plan.target.redirection ? 'active' : 'not active'}
          </dd>
          <dt className="text-muted">Plan made</dt>
          <dd>{new Date(plan.createdAt).toLocaleString('en-US')}</dd>
          <dt className="text-muted">Options</dt>
          <dd>
            {[
              plan.options.incremental && `Only new content: ${plan.alreadyMigrated.length} objects already on the target are left as they are`,
              plan.options.contentOnly && 'Content only: no menus, theme options, homepage, branding or settings',
              plan.options.sideNavMenu && 'Side navigation added to the main menu',
            ]
              .filter(Boolean)
              .join(' · ') || 'None (full migration)'}
          </dd>
          {plan.settings.map((s) => (
            <SettingRow key={s.key} label={s.key} value={`${s.from} → ${s.to || '(cleared)'}`} note={s.reason} />
          ))}
        </dl>
      </Card>
    </div>
  );
}

function SettingRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <>
      <dt className="text-muted">Setting: {label}</dt>
      <dd>
        {value} <span className="text-muted">({note})</span>
      </dd>
    </>
  );
}

// ---------------------------------------------------------------- Pages & posts

export function PagesTab({ jobId, plan, decisions, q, page, query }: TabProps) {
  const rows = plan.items.filter((i) => matches(q, i.title, i.sourceUrl, i.targetPath));
  return (
    <Card title={`Pages and posts (${plan.items.length})`} actions={<FilterBox placeholder="Filter by title or URL" />}>
      <Paged
        rows={rows}
        page={page}
        query={query}
        empty="Nothing matches."
        render={(items) => (
          <table className="data">
            <thead>
              <tr>
                <th>Title</th>
                <th>Type</th>
                <th>New URL</th>
                <th>Redirects from</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const excluded = decisions.exclude.includes(i.sourceKey);
                const typeChoice = decisions.type[i.sourceKey];
                const slugChoice = decisions.slug[i.sourceKey];
                // Pending: the saved decision differs from the one this plan version applied.
                const typePending = typeChoice !== plan.decisions?.type[i.sourceKey];
                const slugPending = slugChoice !== plan.decisions?.slug[i.sourceKey];
                const pending = excluded || typePending || slugPending;
                const other = i.type === 'page' ? 'post' : 'page';
                return (
                  <tr key={i.sourceKey} className={pending ? 'pending' : undefined}>
                    <td className="max-w-xs">
                      <div className="font-medium">{i.title || '(no title)'}</div>
                      <SourceLink url={i.sourceUrl} />
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <Badge tone={i.type === 'post' ? 'info' : 'neutral'}>{i.type}</Badge>
                        <Act action={setType.bind(null, jobId, i.sourceKey, typeChoice ? null : other)} variant="ghost">
                          {typeChoice ? 'Undo' : `Make ${other}`}
                        </Act>
                      </div>
                      {typePending && <div className="mt-1 text-xs text-warn">→ {typeChoice ?? 'as on the source'} after re-plan</div>}
                    </td>
                    <td className="min-w-56">
                      <form action={setSlug.bind(null, jobId, i.sourceKey)} className="flex items-center gap-1">
                        <span className="text-muted">/</span>
                        <input name="slug" defaultValue={slugChoice ?? i.slug} aria-label={`Slug for ${i.title}`} className={`${inputClass} px-2 py-1 font-mono text-xs`} />
                        <Button size="sm" type="submit">
                          Save
                        </Button>
                      </form>
                      {slugPending && <div className="mt-1 text-xs text-warn">→ {slugChoice ? `/${slugChoice}/` : 'the source slug'} after re-plan</div>}
                    </td>
                    <td className="font-mono text-xs text-muted">{i.redirectFrom.length ? i.redirectFrom.join(' ') : '—'}</td>
                    <td className="max-w-xs text-xs text-muted">
                      {i.forms.length > 0 && <Badge tone="info">form</Badge>} {i.warnings.slice(0, 2).join('; ')}
                      {i.warnings.length > 2 && ` (+${i.warnings.length - 2})`}
                    </td>
                    <td className="text-right">
                      <Act action={setExcluded.bind(null, jobId, i.sourceKey, !excluded)} variant={excluded ? 'secondary' : 'danger'}>
                        {excluded ? 'Undo exclude' : 'Exclude'}
                      </Act>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- Not migrated

export function SkippedTab({ jobId, plan, decisions, q, page, query }: TabProps) {
  const rows = plan.notMigrated.filter((s) => matches(q, s.title, s.sourceUrl, s.reason));
  return (
    <Card title={`Not migrated (${plan.notMigrated.length})`} actions={<FilterBox placeholder="Filter by title, URL or reason" />}>
      <Paged
        rows={rows}
        page={page}
        query={query}
        empty="Nothing is left out."
        render={(skipped) => (
          <table className="data">
            <thead>
              <tr>
                <th>What</th>
                <th>Source</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {skipped.map((s) => {
                const byReviewer = s.reason === EXCLUDED;
                const included = decisions.include.includes(s.sourceKey);
                const stillExcluded = decisions.exclude.includes(s.sourceKey);
                // A page left out with the meeting or table it feeds is undone from the Decisions tab.
                const viaRecord = byReviewer && !stillExcluded && !plan.decisions?.exclude.includes(s.sourceKey);
                const pending = included || (byReviewer && !stillExcluded && !viaRecord);
                return (
                  <tr key={s.sourceKey} className={pending ? 'pending' : undefined}>
                    <td>
                      <Badge>{s.what}</Badge>
                    </td>
                    <td className="max-w-md">
                      <div className="font-medium">{s.title}</div>
                      <SourceLink url={s.sourceUrl} />
                    </td>
                    <td className="max-w-sm text-muted">{s.reason}</td>
                    <td className="text-right">
                      {byReviewer ? (
                        stillExcluded ? (
                          <Act action={setExcluded.bind(null, jobId, s.sourceKey, false)}>Undo exclude</Act>
                        ) : viaRecord ? (
                          <span className="text-xs text-muted">Excluded with its meeting or table (Decisions tab)</span>
                        ) : (
                          <span className="text-xs text-warn">Back in after re-plan</span>
                        )
                      ) : /login/i.test(s.reason) ? null : (
                        <Act action={setIncluded.bind(null, jobId, s.sourceKey, !included)} variant={included ? 'secondary' : 'primary'}>
                          {included ? 'Undo include' : 'Include'}
                        </Act>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- Files

export function FilesTab({ jobId, plan, decisions, q, page, query }: TabProps) {
  const rows = plan.media.filter((m) => matches(q, m.filename, m.sourceUrl, m.documentType));
  return (
    <Card title={`Documents and images to upload (${plan.media.length})`} actions={<FilterBox placeholder="Filter by name, URL or type" />}>
      <Paged
        rows={rows}
        page={page}
        query={query}
        empty="Nothing matches."
        render={(media) => (
          <table className="data">
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Size</th>
                <th>Used by</th>
                <th>Old URLs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {media.map((m) => {
                const excluded = decisions.exclude.includes(m.sourceKey);
                return (
                  <tr key={m.sourceKey} className={excluded ? 'pending' : undefined}>
                    <td className="max-w-xs">
                      <div className="font-medium break-all">{m.filename}</div>
                      <SourceLink url={m.sourceUrl} />
                    </td>
                    <td>
                      <Badge tone={m.type === 'document' ? 'info' : 'neutral'}>{m.documentType ?? m.type}</Badge>
                    </td>
                    <td className="tabular-nums">{mb(m.bytes)}</td>
                    <td className="tabular-nums">{m.usedBy.length}</td>
                    <td className="font-mono text-xs text-muted">{m.redirectFrom.length}</td>
                    <td className="text-right">
                      <Act action={setExcluded.bind(null, jobId, m.sourceKey, !excluded)} variant={excluded ? 'secondary' : 'danger'}>
                        {excluded ? 'Undo exclude' : 'Exclude'}
                      </Act>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- Meetings

export function MeetingsTab({ jobId, plan, decisions, q, page, query }: TabProps) {
  const rows = plan.events.filter((e) => matches(q, e.title, e.category, e.date)).sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Card title={`Meetings and events (${plan.events.length})`} actions={<FilterBox placeholder="Filter by title, category or date" />}>
      <Paged
        rows={rows}
        page={page}
        query={query}
        empty="No meetings in this plan."
        render={(events) => (
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Meeting</th>
                <th>Category</th>
                <th>Documents</th>
                <th>Merged from</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const excluded = decisions.exclude.includes(e.key);
                return (
                  <tr key={e.key} className={excluded ? 'pending' : undefined}>
                    <td className="whitespace-nowrap tabular-nums">
                      {e.date}
                      {e.startTime ? ` ${e.startTime}` : ''}
                    </td>
                    <td className="max-w-md">
                      <div className="font-medium">{e.title}</div>
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {e.cancelled && <Badge tone="bad">cancelled</Badge>}
                        {e.confidence === 'low' && <Badge tone="warn" title={e.warnings.join('; ')}>check date/kind</Badge>}
                        {e.location && <span className="text-xs text-muted">{e.location}</span>}
                      </div>
                    </td>
                    <td>{e.category}</td>
                    <td className="tabular-nums">{e.documents.length}</td>
                    <td className="tabular-nums">{e.sourceKeys.length} page(s)</td>
                    <td className="text-right">
                      <Act action={setExcluded.bind(null, jobId, e.key, !excluded)} variant={excluded ? 'secondary' : 'danger'}>
                        {excluded ? 'Undo exclude' : 'Exclude'}
                      </Act>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- Records

export function RecordsTab({ jobId, plan, decisions }: TabProps) {
  const ex = (key: string) => decisions.exclude.includes(key);
  const toggle = (key: string) => (
    <Act action={setExcluded.bind(null, jobId, key, !ex(key))} variant={ex(key) ? 'secondary' : 'danger'}>
      {ex(key) ? 'Undo exclude' : 'Exclude'}
    </Act>
  );
  return (
    <div className="grid gap-6">
      <Card title={`People (${plan.people.length})`}>
        {plan.people.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Group</th>
                <th>Contact</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plan.people.map((p) => (
                <tr key={p.key} className={ex(p.key) ? 'pending' : undefined}>
                  <td className="font-medium">{p.name}</td>
                  <td>{p.role}</td>
                  <td>{p.group}</td>
                  <td className="text-muted">{[p.email, p.phone].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="text-right">{toggle(p.key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No people.</Empty>
        )}
      </Card>
      {plan.contentTypes.map((ct) => {
        const entries = plan.records.filter((r) => r.postType === ct.postType);
        return (
          <Card key={ct.postType} title={`${ct.label} (${entries.length}): new content type, listing at ${ct.listing.targetPath}`}>
            <table className="data">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>{ct.taxonomy?.singular ?? 'Type'}</th>
                  <th>New URL</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((r) => (
                  <tr key={r.sourceKey} className={ex(r.sourceKey) ? 'pending' : undefined}>
                    <td>
                      <div className="font-medium">{r.title}</div>
                      <SourceLink url={r.sourceUrl} />
                    </td>
                    <td>{r.term ?? '—'}</td>
                    <td className="font-mono text-xs">{r.targetPath}</td>
                    <td className="text-right">{toggle(r.sourceKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        );
      })}
      {plan.tables.map((t) => (
        <Card key={t.key} title={`Table: ${t.title} (${t.rows.length} rows × ${t.columns.length} columns) at ${t.targetPath}`} actions={toggle(`table:${t.key}`)}>
          <div className="max-h-72 overflow-auto">
            <table className="data">
              <thead>
                <tr>
                  {t.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.slice(0, 20).map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className="tabular-nums">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Forms

export function FormsTab({ plan }: TabProps) {
  return (
    <Card title={`Forms (${plan.forms.length})`}>
      {plan.forms.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Form</th>
              <th>Action</th>
              <th>Fields</th>
              <th>Handling</th>
            </tr>
          </thead>
          <tbody>
            {plan.forms.map((f) => (
              <tr key={f.key}>
                <td className="font-medium">{f.title}</td>
                <td>
                  <Badge tone={f.action === 'rebuild' ? 'ok' : 'warn'}>{f.action === 'rebuild' ? 'rebuilt' : 'flagged'}</Badge>
                </td>
                <td className="tabular-nums">{f.fields.length}</td>
                <td className="max-w-lg text-muted">
                  {f.reason}
                  <div className="flex gap-1 pt-1">
                    {f.captcha && <Badge>CAPTCHA</Badge>}
                    {f.uploads && <Badge>file uploads</Badge>}
                    {f.sensitive.length > 0 && <Badge tone="warn">sensitive: {f.retentionDays}-day retention</Badge>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No forms.</Empty>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Site

export function SiteTab({ plan }: TabProps) {
  const site = plan.site;
  if (!site) return <Empty>This plan doesn’t set the site structure (run the analysis).</Empty>;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Menus (each replaced as a whole)">
        <div className="grid gap-4 p-4 text-sm">
          {site.menus.map((m) => (
            <div key={m.name}>
              <div className="mb-1 font-medium">
                {m.name} <span className="font-normal text-muted">({m.items.length ? `${m.items.length} items` : 'emptied'})</span>
              </div>
              <ul className="grid gap-0.5">
                {m.items.map((item, i) => (
                  <li key={i} style={{ paddingLeft: item.parent === null ? 0 : 16 }} className="flex gap-2">
                    <span>{item.title}</span>
                    <span className="truncate font-mono text-xs text-muted">{item.url}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>
      <div className="grid content-start gap-6">
        <Card title="Site and footer">
          <dl className="grid gap-x-4 gap-y-1.5 p-4 text-sm sm:grid-cols-[180px_1fr]">
            <dt className="text-muted">Site title</dt>
            <dd>{site.title ?? '(unchanged)'}</dd>
            {Object.entries(site.options).map(([k, v]) => (
              <OptionRow key={k} name={k} value={v} />
            ))}
          </dl>
        </Card>
        <Card title="Homepage">
          <div className="grid gap-3 p-4 text-sm">
            <div>
              <div className="font-medium">Slides</div>
              <ul className="mt-1 grid gap-1">
                {site.home.banner.map((b, i) => (
                  <li key={i}>
                    “{b.title}” <span className="font-mono text-xs text-muted">→ {b.linkUrl ?? 'no link'}</span>
                  </li>
                ))}
              </ul>
            </div>
            {site.home.quickLinks.length > 0 && (
              <div>
                <div className="font-medium">Quick links</div>
                <ul className="mt-1 grid gap-1">
                  {site.home.quickLinks.map((q, i) => (
                    <li key={i}>
                      “{q.title}” <span className="font-mono text-xs text-muted">→ {q.url}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {site.home.intro && (
              <div>
                <div className="font-medium">Introduction</div>
                <p className="mt-1 whitespace-pre-line">{htmlText(site.home.intro)}</p>
                <ul className="mt-1 grid gap-0.5">
                  {[...site.home.intro.matchAll(/href="([^"]+)"/g)].map(([, href], i) => (
                    <li key={i} className="font-mono text-xs text-muted break-all">
                      → {htmlText(href!)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {site.home.clearOthers && <p className="text-muted">The template’s other fields (the seed’s demo placeholders) are cleared.</p>}
            {(site.clearPages ?? []).map((p) => (
              <p key={p.pageId} className="text-muted">
                The kept “{p.title}” page’s own text fields ({p.template}: the seed’s demo content, e.g. a sign-up box) are cleared.
              </p>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** An HTML snippet's text, for review: paragraphs on their own lines, common entities decoded. */
function htmlText(html: string): string {
  return html
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function OptionRow({ name, value }: { name: string; value: string | string[] }) {
  const text = Array.isArray(value) ? value.join(', ') : htmlText(value);
  return (
    <>
      <dt className="font-mono text-xs text-muted">{name}</dt>
      <dd className="whitespace-pre-line">{text || <span className="text-muted">{Array.isArray(value) ? '(none)' : '(cleared)'}</span>}</dd>
    </>
  );
}

// ---------------------------------------------------------------- Design

/** The brand (wm brand): what the site's look comes from, to check against the guide before approving. */
export function DesignTab({ jobId, plan }: TabProps) {
  const d = plan.design;
  if (!d) return <Empty>This plan has no design: import the brand file with “wm brand”, then re-plan.</Empty>;
  const colors = d.variables.filter((v) => v.name.startsWith('color-'));
  const others = d.variables.filter((v) => !v.name.startsWith('color-'));
  const failing = d.checks.filter((c) => !c.passes);
  const footerColor = (d.variables.find((v) => v.name === 'color-footer') ?? d.variables.find((v) => v.name === 'color-primary'))?.value ?? '#202188';
  const source = (v: (typeof d.variables)[number]) => (
    <>
      {v.token ? (
        <>
          <span className="font-mono text-xs">{v.token}</span> <span className="text-muted">{v.evidence}</span>
        </>
      ) : (
        <span className="text-muted">—</span>
      )}
      {v.why && <div className="text-xs text-warn">{v.why}</div>}
    </>
  );
  return (
    <div className="grid gap-6">
      <Card title="Guide">
        <p className="p-4 text-sm">
          “{d.guide.title}”{d.guide.url && (
            <>
              {' '}
              (<a className="underline" href={d.guide.url} target="_blank" rel="noreferrer">open</a>)
            </>
          )}
          , transcribed by {d.guide.transcribedBy} on {d.guide.transcribedAt}. Check the values against the guide before approving: approval covers them.
        </p>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={`Colours (${colors.length})`}>
          <table className="data">
            <thead>
              <tr>
                <th />
                <th>Theme variable</th>
                <th>Value</th>
                <th>From the guide</th>
              </tr>
            </thead>
            <tbody>
              {colors.map((v) => (
                <tr key={v.name}>
                  <td>
                    <span className="inline-block h-6 w-6 rounded border border-line align-middle" style={{ background: v.value }} aria-hidden="true" />
                  </td>
                  <td className="font-mono text-xs">--pw-{v.name}</td>
                  <td className="font-mono text-xs">{v.value}</td>
                  <td className="text-sm">{source(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <div className="grid content-start gap-6">
          <Card title="Type, sizes and buttons">
            <table className="data">
              <tbody>
                {others.map((v) => (
                  <tr key={v.name}>
                    <td className="font-mono text-xs">--pw-{v.name}</td>
                    <td className="font-mono text-xs">{v.value}</td>
                    <td className="text-sm">{source(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Fonts (self-hosted through the Font Library)">
            <ul className="grid gap-1 p-4 text-sm">
              {d.fonts.map((f) => (
                <li key={f.slug}>
                  <span className="font-medium">{f.family}</span>{' '}
                  <span className="text-muted">{f.faces.map((x) => `${x.weight}${x.style === 'italic' ? ' italic' : ''}`).join(', ')}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Logos">
            <div className="grid gap-4 p-4 text-sm sm:grid-cols-2">
              {(['header', 'footer'] as const).map((role) => {
                const logo = d.logos[role];
                return (
                  <figure key={role} className="grid gap-2">
                    {/* The footer logo on the footer's colour, as the site shows it. */}
                    <div className="h-32 rounded border border-line bg-white p-3" style={role === 'footer' ? { background: footerColor } : undefined}>
                      {logo ? <img src={`/api/jobs/${jobId}/brand/${logo.file.split('/').pop()}`} alt={`${role} logo`} className="h-full w-full object-contain" /> : <span className="text-muted">none</span>}
                    </div>
                    <figcaption className="text-muted">
                      {role === 'header' ? 'Header' : 'Footer'}
                      {logo?.width ? ` · ${logo.width}×${logo.height}` : ''}
                    </figcaption>
                  </figure>
                );
              })}
              <p className="text-muted sm:col-span-2">
                {d.logos.evidence.replace(/([^.])$/, '$1.')}
                {d.logos.includesName && ' The logo shows the name, so the header doesn’t repeat it as text.'}
              </p>
            </div>
          </Card>
        </div>
      </div>
      <Card title={`Contrast (WCAG 2.1 AA): ${d.checks.length - failing.length} of ${d.checks.length} pass`}>
        <table className="data">
          <thead>
            <tr>
              <th>Where</th>
              <th>Colours</th>
              <th>Ratio</th>
              <th>Needs</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.checks.map((c) => (
              <tr key={c.what}>
                <td>{c.what}</td>
                <td>
                  <span className="inline-block rounded border border-line px-2 py-0.5 text-xs font-semibold" style={{ color: c.foreground, background: c.background }}>
                    {c.foreground} on {c.background}
                  </span>
                </td>
                <td>{c.ratio}:1</td>
                <td>{c.needs}:1</td>
                <td>{c.passes ? <Badge tone="ok">passes</Badge> : <Badge tone="bad">fails</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {d.deviations.length > 0 && (
        <Card title="Where the site differs from the guide">
          <table className="data">
            <thead>
              <tr>
                <th>What</th>
                <th>Guide</th>
                <th>Site</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {d.deviations.map((x) => (
                <tr key={x.what}>
                  <td>{x.what}</td>
                  <td>{x.guide}</td>
                  <td>{x.site}</td>
                  <td>{x.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Existing content

export function CleanupTab({ jobId, plan, decisions }: TabProps) {
  return (
    <div className="grid gap-6">
      <Card title={`Moved to the trash on the target (${plan.cleanup.length})`}>
        {plan.cleanup.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th>Type</th>
                <th>Why</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {plan.cleanup.map((c) => {
                const kept = decisions.keep.includes(c.id);
                return (
                  <tr key={c.id} className={kept ? 'pending' : undefined}>
                    <td>
                      <a href={c.link} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
                        {c.title || '(no title)'}
                      </a>{' '}
                      <span className="text-xs text-muted">#{c.id}</span>
                    </td>
                    <td>{c.type}</td>
                    <td className="text-muted">{c.reason ?? 'Seed demo content'}</td>
                    <td className="text-right">
                      <Act action={setKept.bind(null, jobId, c.id, !kept)}>{kept ? 'Undo keep' : 'Keep'}</Act>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing on the target is trashed.</Empty>
        )}
      </Card>
      <Card title={`Kept (${plan.keep.length})`}>
        <table className="data">
          <tbody>
            {plan.keep.map((k) => (
              <tr key={k.id}>
                <td className="font-medium">
                  {k.title} <span className="text-xs text-muted">#{k.id}</span>
                </td>
                <td>{k.type}</td>
                <td className="text-muted">{k.reason}</td>
                <td className="text-right">{k.reason === 'Kept by the reviewer' && <Act action={setKept.bind(null, jobId, k.id, false)}>Trash it</Act>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Warnings

export function WarningsTab({ plan }: TabProps) {
  const itemWarnings = new Map<string, number>();
  for (const i of plan.items) for (const w of i.warnings) itemWarnings.set(w.split(':')[0]!, (itemWarnings.get(w.split(':')[0]!) ?? 0) + 1);
  return (
    <div className="grid gap-6">
      <Card title={`Plan warnings (${plan.warnings.length})`}>
        {plan.warnings.length ? (
          <ul className="grid gap-2 p-4 text-sm">
            {plan.warnings.map((w, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-warn" aria-hidden>
                  !
                </span>
                {w}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No warnings.</Empty>
        )}
      </Card>
      <Card title="Warnings on pages and posts, by kind">
        <table className="data">
          <tbody>
            {[...itemWarnings].sort((a, b) => b[1] - a[1]).map(([w, n]) => (
              <tr key={w}>
                <td>{w}</td>
                <td className="text-right tabular-nums">{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Changes

export function ChangesTab({ plan, previous }: TabProps) {
  if (!previous) return <Empty>This is the first plan version.</Empty>;
  const keyed = <T,>(list: T[], key: (t: T) => string) => new Map(list.map((t) => [key(t), t]));
  const diff = <T,>(now: T[], before: T[], key: (t: T) => string) => {
    const a = keyed(now, key);
    const b = keyed(before, key);
    return { added: [...a.keys()].filter((k) => !b.has(k)), removed: [...b.keys()].filter((k) => !a.has(k)) };
  };
  const items = diff(plan.items, previous.items, (i) => i.sourceKey);
  const media = diff(plan.media, previous.media, (m) => m.sourceKey);
  const events = diff(plan.events, previous.events, (e) => e.key);
  const prevItems = keyed(previous.items, (i) => i.sourceKey);
  const moved = plan.items.filter((i) => prevItems.has(i.sourceKey) && (prevItems.get(i.sourceKey)!.targetPath !== i.targetPath || prevItems.get(i.sourceKey)!.type !== i.type));
  // Delta sync: pages whose content changed on the source since the previous version's scan.
  const changed = plan.items.filter((i) => {
    const before = prevItems.get(i.sourceKey)?.contentSha256;
    return before && i.contentSha256 && before !== i.contentSha256;
  });
  const counts = Object.entries(plan.expected).filter(([k, v]) => (previous.expected as Record<string, number>)[k] !== v);
  const list = (keys: string[]) => (keys.length ? <span className="font-mono text-xs break-all">{keys.slice(0, 30).join(', ')}{keys.length > 30 ? ` … (+${keys.length - 30})` : ''}</span> : <span className="text-muted">none</span>);
  return (
    <Card title={`Changes from v${previous.version} to v${plan.version}`}>
      <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-[200px_1fr]">
        <dt className="text-muted">Counts</dt>
        <dd>{counts.length ? counts.map(([k, v]) => `${k} ${(previous.expected as Record<string, number>)[k]} → ${v}`).join(' · ') : 'unchanged'}</dd>
        <dt className="text-muted">Pages and posts added</dt>
        <dd>{list(items.added)}</dd>
        <dt className="text-muted">Pages and posts removed</dt>
        <dd>{list(items.removed)}</dd>
        <dt className="text-muted">Content changed on the source</dt>
        <dd>{list(changed.map((i) => `${i.title} (${i.targetPath})`))}</dd>
        <dt className="text-muted">New URL or type</dt>
        <dd>{list(moved.map((i) => `${i.sourceKey} → ${i.type} ${i.targetPath}`))}</dd>
        <dt className="text-muted">Files added / removed</dt>
        <dd>
          {list(media.added)} / {list(media.removed)}
        </dd>
        <dt className="text-muted">Meetings added / removed</dt>
        <dd>
          {list(events.added)} / {list(events.removed)}
        </dd>
        <dt className="text-muted">Warnings</dt>
        <dd>
          {previous.warnings.length} → {plan.warnings.length}
        </dd>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------- Decisions

/** Every saved reviewer decision, with an undo for each (excluded people and meetings are only listed here). */
export function DecisionsTab({ jobId, plan, decisions }: TabProps) {
  const applied = plan.decisions;
  const status = (inPlan: boolean) => (inPlan ? <Badge tone="ok">in v{plan.version}</Badge> : <Badge tone="warn">after re-plan</Badge>);
  const name = (key: string) =>
    plan.items.find((i) => i.sourceKey === key)?.title ??
    plan.events.find((e) => e.key === key)?.title ??
    plan.people.find((p) => p.key === key)?.name ??
    plan.notMigrated.find((s) => s.sourceKey === key)?.title ??
    plan.media.find((m) => m.sourceKey === key)?.filename ??
    key;
  const rows: { what: string; key: string; detail: ReactNode; inPlan: boolean; undo: () => Promise<void> }[] = [
    ...decisions.exclude.map((k) => ({ what: 'Excluded', key: k, detail: name(k), inPlan: !!applied?.exclude.includes(k), undo: setExcluded.bind(null, jobId, k, false) })),
    ...decisions.include.map((k) => ({ what: 'Included', key: k, detail: name(k), inPlan: !!applied?.include.includes(k), undo: setIncluded.bind(null, jobId, k, false) })),
    ...Object.entries(decisions.type).map(([k, v]) => ({ what: `As a ${v}`, key: k, detail: name(k), inPlan: applied?.type[k] === v, undo: setType.bind(null, jobId, k, null) })),
    ...Object.entries(decisions.slug).map(([k, v]) => ({ what: 'New slug', key: k, detail: `${name(k)} → /${v}/`, inPlan: applied?.slug[k] === v, undo: setSlugTo.bind(null, jobId, k) })),
    ...decisions.keep.map((id) => ({ what: 'Kept on the target', key: `#${id}`, detail: plan.cleanup.find((c) => c.id === id)?.title ?? plan.keep.find((k) => k.id === id)?.title ?? `#${id}`, inPlan: !!applied?.keep.includes(id), undo: setKept.bind(null, jobId, id, false) })),
  ];
  return (
    <Card title={`Reviewer decisions (${rows.length})`}>
      {rows.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Decision</th>
              <th>Item</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.what}:${r.key}`} className={r.inPlan ? undefined : 'pending'}>
                <td className="font-medium">{r.what}</td>
                <td>
                  <div>{r.detail}</div>
                  <div className="font-mono text-xs text-muted">{r.key}</div>
                </td>
                <td>{status(r.inPlan)}</td>
                <td className="text-right">
                  <Act action={r.undo}>Undo</Act>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{applied ? `No decisions saved. Plan v${plan.version} still has the earlier ones: re-plan to go back to what the rules proposed.` : 'No decisions yet: the plan is exactly what the rules proposed.'}</Empty>
      )}
    </Card>
  );
}
