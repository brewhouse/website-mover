import Link from 'next/link';
import { notFound } from 'next/navigation';
import { jobPath, readJson } from '@wm/core';
import { getJob, listRuns } from '@wm/db';
import { Binding, designState, PageKind, partKey, type DesignState, type PlanField, type Proposal } from '@wm/design/review';
import { Badge, Button, Card, Empty, inputClass, LinkButton, Notice, PageHeader, Stat, when } from '@/components/ui';
import { clearDesignDecision, setFrameMatch, setPageDecision, setPartDecision } from '@/lib/design-actions';
import { requireUser } from '@/lib/session';
import { DesignApproveForm, DesignReplanButton } from './design-forms';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  return { title: `Design plan ${(await params).id}` };
}

const TABS = { summary: 'Summary', templates: 'Templates', types: 'Content types', fields: 'Fields', blocks: 'Blocks', menus: 'Menus', content: 'Sample content', frames: 'Frames', warnings: 'Warnings' } as const;
type Tab = keyof typeof TABS;

export default async function DesignReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; page?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const job = await getJob(id);
  if (!job || job.kind !== 'design') notFound();
  const state = await designState(id);
  if (!state) {
    return (
      <>
        <PageHeader title={`Design plan ${id}`} actions={<LinkButton href={`/jobs/${id}`}>Job page</LinkButton>} />
        <Notice tone="warn">There’s no design plan yet. Run “Ingest → plan” on the job page.</Notice>
      </>
    );
  }
  const { plan } = state;
  const tab: Tab = sp.tab && sp.tab in TABS ? (sp.tab as Tab) : 'summary';
  const runs = await listRuns(id, 1);
  const busy = runs[0]?.status === 'queued' || runs[0]?.status === 'running';
  const proposal = await readJson<{ draft: Proposal; proposal: Proposal | null }>(jobPath(id, 'design', 'plan', `proposal.v${plan.version}.json`))
    .then((p) => p.proposal ?? p.draft)
    .catch(() => null);
  const counts: Partial<Record<Tab, number>> = {
    templates: plan.templates.length,
    types: plan.postTypes.length + plan.taxonomies.length,
    fields: plan.expected.fields,
    blocks: plan.blocks.length,
    menus: plan.menus.length,
    content: plan.entries.length,
    frames: state.inventory?.frames.length,
    warnings: plan.warnings.length,
  };

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link href={`/jobs/${id}`} className="text-muted hover:text-ink">
              {id}
            </Link>
            <span className="text-muted">/</span> Design plan v{plan.version}
            {state.approved ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">not approved</Badge>}
          </span>
        }
        subtitle={
          <>
            {plan.inputs.targetUrl} · made {when(plan.createdAt)} by the rules{plan.proposedBy.ai ? ` and ${plan.proposedBy.ai}` : ' (no AI)'} · <span className="font-mono">{state.sha256.slice(0, 12)}</span>
          </>
        }
        actions={<LinkButton href={`/jobs/${id}`}>Job page</LinkButton>}
      />

      <div className="mb-6 grid gap-4">
        {state.pendingDecisions && (
          <Notice tone="warn">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>There are changes that aren’t in plan v{plan.version} yet. Re-plan to see their effect; the new version needs its own approval.</span>
              <DesignReplanButton jobId={id} />
            </div>
          </Notice>
        )}
        <Card title="Approval">
          <div className="p-4">
            {state.approved ? (
              <p className="text-sm">
                Approved by <strong>{state.approval!.approvedBy}</strong> on {when(state.approval!.approvedAt)}. The theme and the build follow exactly this plan.
              </p>
            ) : (
              <>
                {state.approval && <p className="mb-3 text-sm text-muted">The last approval was for v{state.approval.planVersion}; this version needs its own.</p>}
                <DesignApproveForm
                  jobId={id}
                  version={plan.version}
                  sha256={state.sha256}
                  disabled={!user.canApprove ? 'Only approvers can approve.' : busy ? 'A stage is running.' : state.pendingDecisions ? 'Re-plan first: your changes aren’t in this version.' : undefined}
                />
              </>
            )}
          </div>
        </Card>
      </div>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line" aria-label="Plan sections">
        {(Object.keys(TABS) as Tab[]).map((name) => (
          <Link
            key={name}
            href={`?tab=${name}`}
            aria-current={name === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${name === tab ? 'border-brand font-medium text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {TABS[name]}
            {counts[name] !== undefined && <span className="ml-1.5 text-xs text-muted tabular-nums">{counts[name]}</span>}
          </Link>
        ))}
      </nav>

      {tab === 'summary' && <Summary state={state} />}
      {tab === 'templates' && <Templates id={id} state={state} proposal={proposal} only={sp.page} />}
      {tab === 'types' && <Types state={state} />}
      {tab === 'fields' && <Fields state={state} />}
      {tab === 'blocks' && <Blocks state={state} />}
      {tab === 'menus' && <Menus state={state} />}
      {tab === 'content' && <Content state={state} />}
      {tab === 'frames' && <Frames id={id} state={state} />}
      {tab === 'warnings' && (
        <Card title="Warnings">{plan.warnings.length ? <ul className="list-disc space-y-1 py-3 pr-4 pl-8 text-sm">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : <Empty>None.</Empty>}</Card>
      )}
    </>
  );
}

const img = (id: string, kind: 'frame' | 'shot', name: string) => `/api/jobs/${encodeURIComponent(id)}/design/${kind}/${encodeURIComponent(name)}`;

function Summary({ state }: { state: DesignState }) {
  const { plan } = state;
  const e = plan.expected;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Templates" value={plan.templates.length} hint={`${e.templates.update} framework files restyled, ${e.templates.create} new`} />
      <Stat label="Post types" value={plan.postTypes.length} hint={`${e.postTypes} new; ${plan.taxonomies.length} taxonomies (${e.taxonomies} new)`} />
      <Stat label="New fields" value={e.fields} hint={`in ${e.fieldGroups.extend} existing groups and ${e.fieldGroups.create} new ones`} />
      <Stat label="Blocks" value={plan.blocks.length} hint={`${e.blocks.update} restyled, ${e.blocks.create} new`} />
      <Stat label="Sample pages and entries" value={e.entries} hint="filled with the mockups’ own text" />
      <Stat label="Images" value={e.media} hint="resized before upload" />
      <Stat label="Frames" value={state.inventory?.frames.length ?? '—'} hint={state.inventory ? `${state.inventory.gaps.unconfirmed} matches to confirm` : ''} />
      <Stat label="Warnings" value={plan.warnings.length} />
    </div>
  );
}

const BINDING_HELP: Record<string, string> = {
  theme: 'template markup, nothing to edit',
  core: 'WordPress’s own fields',
  fields: 'fields on the page or entry',
  repeater: 'a repeater on the page or entry',
  query: 'entries of a post type',
  filter: 'terms as filter links',
  block: 'an ACF block',
  menu: 'a WordPress menu',
};

function Templates({ id, state, proposal, only }: { id: string; state: DesignState; proposal: Proposal | null; only?: string }) {
  const { plan, inventory, decisions } = state;
  const frameImage = (frameId: string) => inventory?.frames.find((f) => f.id === frameId)?.image ?? null;
  const shot = (page: string) => inventory?.pages.find((p) => p.file === page)?.screenshots.find((s) => s.width === 1440)?.image ?? null;
  const fieldsByKey = new Map(plan.fieldGroups.flatMap((g) => g.fields.flatMap((f) => [f, ...f.subFields]).map((f) => [f.key, f] as const)));
  const list = only ? plan.templates.filter((t) => t.page === only) : plan.templates;
  return (
    <div className="grid gap-6">
      {only && (
        <Link href="?tab=templates" className="text-sm text-brand hover:underline">
          ← All templates
        </Link>
      )}
      {list.map((t) => {
        const pageProposal = proposal?.pages.find((p) => p.page === t.page);
        const decided = decisions.pages[t.page];
        const frame = t.frames.map(frameImage).find(Boolean);
        const screenshot = shot(t.page);
        return (
          <Card
            key={t.page}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <Link href={`?tab=templates&page=${encodeURIComponent(t.page)}`} className="hover:underline">
                  {t.page}
                </Link>
                <Badge tone="info">
                  {t.kind}
                  {t.postType ? ` · ${t.postType}` : ''}
                </Badge>
                {t.file ? <Badge tone={t.action === 'update' ? 'neutral' : 'warn'}>{`${t.file} ${t.action === 'update' ? 'restyled' : 'new'}`}</Badge> : <Badge>plugin views</Badge>}
                {decided && <Badge tone="warn">changed</Badge>}
              </span>
            }
          >
            <div className="grid gap-4 p-4 lg:grid-cols-[280px_1fr]">
              <div className="grid content-start gap-3">
                {frame && (
                  <a href={img(id, 'frame', frame)} target="_blank" rel="noreferrer" title="Figma frame">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img(id, 'frame', frame)} alt={`Figma frame for ${t.page}`} className="max-h-72 w-full rounded border border-line object-cover object-top" loading="lazy" />
                  </a>
                )}
                {screenshot && (
                  <a href={img(id, 'shot', screenshot)} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
                    Mockup screenshot (1440 px)
                  </a>
                )}
                {pageProposal && (
                  <form action={setPageDecision.bind(null, id, t.page)} className="grid gap-2 rounded border border-line p-3 text-sm">
                    <label className="grid gap-1 text-xs text-muted">
                      Title
                      <input name="title" defaultValue={decided?.title ?? pageProposal.title} className={inputClass} />
                    </label>
                    <label className="grid gap-1 text-xs text-muted">
                      Kind
                      <select name="kind" defaultValue={decided?.kind ?? pageProposal.kind} className={inputClass}>
                        {PageKind.options.map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-xs text-muted">
                      Post type (single and archive)
                      <input name="postType" defaultValue={decided?.postType ?? pageProposal.postType ?? ''} className={inputClass} />
                    </label>
                    <div className="flex gap-2">
                      <Button size="sm" type="submit">
                        Save
                      </Button>
                      {decided && (
                        <Button size="sm" variant="ghost" formAction={clearDesignDecision.bind(null, id, 'page', t.page)}>
                          Undo
                        </Button>
                      )}
                    </div>
                  </form>
                )}
              </div>
              <table className="data">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>How it gets its content</th>
                    <th>Fields</th>
                  </tr>
                </thead>
                <tbody>
                  {t.parts.map((part) => {
                    const key = partKey({ page: t.page, path: part.path, collection: part.collection });
                    const proposed = proposal?.parts.find((p) => partKey(p) === key);
                    const changed = !!decisions.parts[key];
                    return (
                      <tr key={key} className={changed ? 'pending' : undefined}>
                        <td className="align-top">
                          <div className="font-medium">{part.component}</div>
                          <div className="text-xs text-muted">
                            {part.collection !== null ? 'list' : 'section'}
                            {part.heading ? ` · “${part.heading}”` : ''}
                            {part.framework ? ` · ${part.framework.file} (${Math.round(part.framework.share * 100)}%)` : ''}
                          </div>
                        </td>
                        <td className="align-top">
                          <div>
                            <strong>{part.binding}</strong>
                            {part.postType ? ` ${part.postType}` : ''}
                            {part.taxonomy ? ` ${part.taxonomy}` : ''}
                            {part.block ? ` acf/${part.block}` : ''}
                          </div>
                          <div className="text-xs text-muted">{BINDING_HELP[part.binding]}</div>
                        </td>
                        <td className="align-top">
                          <div className="text-xs">{part.fields.map((k) => (k.startsWith('core:') ? k.slice(5) : (fieldsByKey.get(k)?.name ?? k))).join(', ') || '—'}</div>
                          {proposed && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs text-brand">Change</summary>
                              <form action={setPartDecision.bind(null, id, key)} className="mt-2 grid gap-2 text-xs">
                                <div className="grid grid-cols-2 gap-2">
                                  <label className="grid gap-1 text-muted">
                                    Binding
                                    <select name="binding" defaultValue={proposed.binding} className={inputClass}>
                                      {Binding.options.map((b) => (
                                        <option key={b}>{b}</option>
                                      ))}
                                    </select>
                                  </label>
                                  <label className="grid gap-1 text-muted">
                                    Post type
                                    <input name="postType" defaultValue={proposed.postType ?? ''} className={inputClass} />
                                  </label>
                                  <label className="grid gap-1 text-muted">
                                    Taxonomy
                                    <input name="taxonomy" defaultValue={proposed.taxonomy ?? ''} className={inputClass} />
                                  </label>
                                  <label className="grid gap-1 text-muted">
                                    Block
                                    <input name="block" defaultValue={proposed.block ?? ''} className={inputClass} />
                                  </label>
                                </div>
                                {proposed.fields.map((f, i) => (
                                  <div key={`${f.path}-${i}`} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                                    <input name={`name.${i}`} defaultValue={f.name} aria-label="Field name" className={inputClass} />
                                    <input name={`label.${i}`} defaultValue={f.label} aria-label="Field label" className={inputClass} />
                                    <span className="text-muted">{f.core ? `WP ${f.core}` : f.type}</span>
                                  </div>
                                ))}
                                <div className="flex gap-2">
                                  <Button size="sm" type="submit">
                                    Save
                                  </Button>
                                  {changed && (
                                    <Button size="sm" variant="ghost" formAction={clearDesignDecision.bind(null, id, 'part', key)}>
                                      Undo
                                    </Button>
                                  )}
                                </div>
                              </form>
                            </details>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Types({ state }: { state: DesignState }) {
  const { plan } = state;
  return (
    <div className="grid gap-6">
      <Card title="Post types">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Label</th>
              <th />
              <th>Taxonomies</th>
              <th>Shown on</th>
            </tr>
          </thead>
          <tbody>
            {plan.postTypes.map((p) => (
              <tr key={p.name}>
                <td className="font-mono">{p.name}</td>
                <td>{p.label}</td>
                <td>{p.action === 'create' ? <Badge tone="warn">new</Badge> : <Badge>existing</Badge>}</td>
                <td>{p.taxonomies.join(', ') || '—'}</td>
                <td className="text-xs text-muted">{p.from.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Taxonomies">
        {plan.taxonomies.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Label</th>
                <th />
                <th>Post types</th>
                <th>Terms (from the mockups)</th>
              </tr>
            </thead>
            <tbody>
              {plan.taxonomies.map((t) => (
                <tr key={t.name}>
                  <td className="font-mono">{t.name}</td>
                  <td>{t.label}</td>
                  <td>{t.action === 'create' ? <Badge tone="warn">new</Badge> : <Badge>existing</Badge>}</td>
                  <td>{t.postTypes.join(', ')}</td>
                  <td className="text-xs">{t.terms.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>None.</Empty>
        )}
      </Card>
    </div>
  );
}

function FieldRows({ f, sub = false }: { f: PlanField | Omit<PlanField, 'subFields'>; sub?: boolean }) {
  return (
    <tr>
      <td className="font-mono text-xs">
        {sub ? '↳ ' : ''}
        {f.name}
      </td>
      <td>{f.label}</td>
      <td className="text-xs">{f.type}</td>
      <td>{f.action === 'add' ? <Badge tone="warn">new</Badge> : <Badge>existing</Badge>}</td>
      <td className="max-w-xs truncate text-xs text-muted" title={f.sample ?? ''}>
        {f.sample}
      </td>
      <td className="text-xs text-muted">{f.source ? `${f.source.page} ${f.source.component}` : ''}</td>
    </tr>
  );
}

function Fields({ state }: { state: DesignState }) {
  return (
    <div className="grid gap-6">
      {state.plan.fieldGroups.map((g) => (
        <Card
          key={g.key}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {g.title} <span className="font-mono text-xs text-muted">{g.key}</span>
              <Badge tone={g.action === 'create' ? 'warn' : g.action === 'extend' ? 'info' : 'neutral'}>{g.action === 'create' ? 'new group' : g.action === 'extend' ? 'fields added' : 'unchanged'}</Badge>
              <span className="text-xs font-normal text-muted">
                where {g.location.param} = {g.location.value}
              </span>
            </span>
          }
        >
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Label</th>
                <th>Type</th>
                <th />
                <th>Mockup sample</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {g.fields.flatMap((f) => [<FieldRows key={f.key} f={f} />, ...f.subFields.map((sf) => <FieldRows key={`${f.key}/${sf.key}`} f={sf} sub />)])}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function Blocks({ state }: { state: DesignState }) {
  return (
    <Card title="ACF blocks">
      {state.plan.blocks.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Block</th>
              <th>Title</th>
              <th />
              <th>Template</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {state.plan.blocks.map((b) => (
              <tr key={b.name}>
                <td className="font-mono text-xs">acf/{b.name}</td>
                <td>{b.title}</td>
                <td>{b.action === 'create' ? <Badge tone="warn">new</Badge> : <Badge>restyled</Badge>}</td>
                <td className="font-mono text-xs">{b.template}</td>
                <td className="text-xs text-muted">
                  {b.from.page} {b.from.component}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>None.</Empty>
      )}
    </Card>
  );
}

type MenuItem = { label: string; href: string; target: string | null; children: MenuItem[] };
function MenuTree({ items }: { items: MenuItem[] }) {
  return (
    <ul className="ml-4 list-disc space-y-0.5">
      {items.map((i, n) => (
        <li key={`${i.label}-${n}`}>
          {i.label} <span className="text-xs text-muted">{i.target ? `→ ${i.target}` : i.href && i.href !== '#' ? `→ ${i.href} (custom link)` : ''}</span>
          {i.children.length > 0 && <MenuTree items={i.children} />}
        </li>
      ))}
    </ul>
  );
}

function Menus({ state }: { state: DesignState }) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {state.plan.menus.map((m) => (
        <Card key={m.name} title={`${m.name} (from ${m.source})`}>
          <div className="p-4 text-sm">
            <MenuTree items={m.items} />
          </div>
        </Card>
      ))}
    </div>
  );
}

function Content({ state }: { state: DesignState }) {
  return (
    <Card title="Sample pages and entries">
      <table className="data">
        <thead>
          <tr>
            <th>Type</th>
            <th>Title</th>
            <th>Slug</th>
            <th>Template</th>
            <th>From</th>
            <th>Values</th>
          </tr>
        </thead>
        <tbody>
          {state.plan.entries.map((e, i) => (
            <tr key={`${e.postType}-${e.slug}-${i}`}>
              <td className="font-mono text-xs">{e.postType}</td>
              <td>
                {e.title}
                {e.frontPage ? ' (front page)' : ''}
              </td>
              <td className="font-mono text-xs">{e.slug || '/'}</td>
              <td className="font-mono text-xs">{e.template ?? ''}</td>
              <td className="text-xs text-muted">
                {e.source.page}
                {e.source.component ? ` ${e.source.component}` : ''}
              </td>
              <td className="text-xs text-muted">
                {Object.keys(e.core).length + Object.keys(e.fields).length} values{e.blocks.length ? `, ${e.blocks.length} blocks` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Frames({ id, state }: { id: string; state: DesignState }) {
  const inv = state.inventory;
  if (!inv) return <Empty>No inventory yet.</Empty>;
  const pages = inv.pages.map((p) => p.file);
  return (
    <>
      <Notice tone="info">Corrections apply at the next “Ingest → plan” (the frames are matched during ingest).</Notice>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {inv.frames.map((f) => {
          const m = inv.matches.find((x) => x.frameId === f.id)!;
          const saved = state.matches[f.id];
          return (
            <Card
              key={f.id}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {f.name}
                  <Badge tone={m.status === 'confirmed' ? 'ok' : m.runnerUp || m.role === 'unmatched' ? 'warn' : 'neutral'}>{m.status === 'confirmed' ? 'confirmed' : m.runnerUp ? 'close call' : m.role === 'unmatched' ? 'unmatched' : 'proposed'}</Badge>
                </span>
              }
            >
              <div className="grid gap-3 p-3 text-sm">
                {f.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img(id, 'frame', f.image)} alt={`Figma frame ${f.name}`} className="h-48 w-full rounded border border-line object-cover object-top" loading="lazy" />
                )}
                <div className="text-xs text-muted">
                  {f.width}×{f.height} · {m.role}
                  {m.page ? ` → ${m.page}` : ''} · {m.reason}
                </div>
                <form action={async (form: FormData) => {
                  'use server';
                  await setFrameMatch(id, f.id, String(form.get('value') ?? ''));
                }} className="flex gap-2">
                  <select name="value" defaultValue={saved === undefined ? '' : (saved ?? 'none')} className={inputClass} aria-label={`Match for ${f.name}`}>
                    <option value="">Let the tool decide</option>
                    {pages.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                    <option value="shell">shell (header, sidebar, footer)</option>
                    <option value="reference">reference (style guide)</option>
                    <option value="none">no page</option>
                  </select>
                  <Button size="sm" type="submit">
                    Save
                  </Button>
                </form>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
