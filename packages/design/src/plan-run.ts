/**
 * `wm design plan` and `wm design approve`. Plans are versioned under design/plan/ (plan.vN.json and
 * .md, with the proposal it was built from); the approval names the exact bytes approved, as for
 * migration plans.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { jobPath, readJson, writeJson } from '@wm/core';
import type { FigmaFrame } from './figma.js';
import { indexFramework } from './framework.js';
import type { Inventory } from './ingest.js';
import type { DesignModel } from './model.js';
import type { MockupPage } from './pages.js';
import { buildDesignPlan, vocabulary, type Vocabulary } from './plan.js';
import { DesignPlan } from './plan-schema.js';
import { draftProposal, partKey, Proposal, ProposalPart } from './propose.js';
import { renderDesignPlan } from './plan-render.js';
import type { TargetSchema } from './schema.js';

/** A reviewer's changes to the proposal (written by the review screen), applied before each plan. */
export const DesignDecisions = z.object({
  pages: z.record(z.string(), Proposal.shape.pages.element.partial()).default({}),
  /** By part key "page#path#collection". */
  parts: z.record(z.string(), ProposalPart.partial()).default({}),
  postTypes: Proposal.shape.postTypes.default([]),
  taxonomies: Proposal.shape.taxonomies.default([]),
});
export type DesignDecisions = z.infer<typeof DesignDecisions>;

export const DesignApproval = z.object({ jobId: z.string(), planVersion: z.number(), planSha256: z.string(), approvedBy: z.string(), approvedAt: z.string() });
export type DesignApproval = z.infer<typeof DesignApproval>;

const dir = (jobId: string, ...p: string[]) => jobPath(jobId, 'design', ...p);
const planFile = (jobId: string, v: number) => dir(jobId, 'plan', `plan.v${v}.json`);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export async function latestDesignPlanVersion(jobId: string): Promise<number> {
  const names = await readdir(dir(jobId, 'plan')).catch(() => [] as string[]);
  return Math.max(0, ...names.map((n) => Number(/^plan\.v(\d+)\.json$/.exec(n)?.[1] ?? 0)));
}

export async function loadDesignPlan(jobId: string, version?: number): Promise<{ plan: DesignPlan; sha256: string }> {
  const v = version ?? (await latestDesignPlanVersion(jobId));
  if (!v) throw new Error(`Job ${jobId} has no design plan yet: run "wm design plan"`);
  const raw = await readFile(planFile(jobId, v));
  return { plan: DesignPlan.parse(JSON.parse(raw.toString())), sha256: sha256(raw) };
}

export async function approveDesignPlan(jobId: string, approvedBy: string, expect?: { version: number; sha256: string }): Promise<DesignApproval> {
  const { plan, sha256: planSha256 } = await loadDesignPlan(jobId);
  if (expect && (plan.version !== expect.version || planSha256 !== expect.sha256)) throw new Error(`The latest design plan is v${plan.version}, not the one reviewed (v${expect.version}): review it again`);
  if (plan.warnings.some((w) => /can't be created/.test(w))) throw new Error('The plan has blocking warnings (post types that can\'t be created): fix them on review first');
  const approval = DesignApproval.parse({ jobId, planVersion: plan.version, planSha256, approvedBy, approvedAt: new Date().toISOString() });
  await writeJson(dir(jobId, 'plan', 'approval.json'), approval);
  return approval;
}

export async function loadApprovedDesignPlan(jobId: string): Promise<{ plan: DesignPlan; approval: DesignApproval }> {
  const approval = DesignApproval.parse(
    await readJson(dir(jobId, 'plan', 'approval.json')).catch(() => {
      throw new Error(`The design plan for ${jobId} is not approved: run "wm design approve"`);
    }),
  );
  const { plan, sha256: current } = await loadDesignPlan(jobId);
  if (plan.version !== approval.planVersion || current !== approval.planSha256) throw new Error(`Approval is for design plan v${approval.planVersion}, but the current plan is v${plan.version}: review and approve it again`);
  return { plan, approval };
}

export async function loadDesignDecisions(jobId: string): Promise<DesignDecisions> {
  const raw = await readJson(jobPath(jobId, 'review', 'design-decisions.json')).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Can't read review/design-decisions.json: ${err.message}`);
  });
  return DesignDecisions.parse(raw);
}

/** Applies a reviewer's decisions to a proposal. */
export function applyDecisions(p: Proposal, d: DesignDecisions): Proposal {
  return {
    pages: p.pages.map((x) => ({ ...x, ...(d.pages[x.page] ?? {}) })),
    postTypes: [...p.postTypes.filter((t) => !d.postTypes.some((x) => x.name === t.name)), ...d.postTypes],
    taxonomies: [...p.taxonomies.filter((t) => !d.taxonomies.some((x) => x.name === t.name)), ...d.taxonomies],
    parts: p.parts.map((x) => ({ ...x, ...(d.parts[partKey(x)] ?? {}) })),
  };
}

export interface DesignPlanOptions {
  jobId: string;
  themeRoot: string;
  /** Ask the AI to refine the rules' draft (needs OPENAI_API_KEY and OPENAI_MODEL). */
  ai?: boolean;
  log?: (msg: string) => void;
}

export async function planDesign(opts: DesignPlanOptions): Promise<{ plan: DesignPlan; sha256: string }> {
  const log = opts.log ?? (() => {});
  const { jobId } = opts;
  const read = async <T>(file: string, hint: string): Promise<T> =>
    readJson<T>(dir(jobId, file)).catch(() => {
      throw new Error(hint);
    });
  const model = await read<DesignModel>('model.json', 'Run "wm design model" first');
  const inventory = await read<Inventory>('inventory.json', 'Run "wm design ingest" first');
  const target = await read<{ url: string; readAt: string; schema: TargetSchema }>('target/schema.json', 'Run "wm design model --target …" first');
  const pages = await read<MockupPage[]>('pages.json', 'Run "wm design ingest" first');
  const frames = await read<FigmaFrame[]>('figma/frames.json', 'Run "wm design ingest" first');
  const framework = await indexFramework(path.resolve(opts.themeRoot));

  const vocab = await buildVocabulary(jobId, pages, frames, model);
  const frameNames = Object.fromEntries(inventory.frames.map((f) => [f.id, f.name]));
  const draft = draftProposal(model, target.schema, frameNames);
  let proposal = draft;
  let ai: string | null = null;
  if (opts.ai) {
    // Only the worker and CLI plan; the web app's bundle leaves the AI client out.
    const { refineProposal } = (await import(/* webpackIgnore: true */ './ai.js')) as typeof import('./ai.js');
    log(`AI: refining the draft with ${process.env.OPENAI_MODEL}`);
    proposal = await refineProposal({ model, schema: target.schema, draft, frames: inventory.frames, log });
    ai = process.env.OPENAI_MODEL ?? null;
  }
  const decisions = await loadDesignDecisions(jobId);
  const decided = Object.keys(decisions.pages).length + Object.keys(decisions.parts).length + decisions.postTypes.length + decisions.taxonomies.length;
  if (decided) {
    proposal = applyDecisions(proposal, decisions);
    log(`Review: applied ${decided} decisions`);
  }

  const version = (await latestDesignPlanVersion(jobId)) + 1;
  const fileSha = async (f: string) => sha256(await readFile(dir(jobId, f)));
  const sizes = new Map<string, number>();
  for (const src of new Set(model.pages.flatMap((p) => p.sections.flatMap((s) => [...s.leaves.map((l) => l.src), ...s.collections.flatMap((c) => c.samples.flatMap((r) => Object.entries(r).filter(([k]) => k.endsWith('@src')).map(([, v]) => v)))]))).values()) {
    if (!src || /^(https?:|data:)/.test(src)) continue;
    const st = await stat(dir(jobId, 'source', src)).catch(() => null);
    if (st) sizes.set(src, st.size);
  }
  const plan = buildDesignPlan({
    jobId,
    version,
    model,
    schema: target.schema,
    proposal,
    draft,
    vocabulary: vocab,
    themeFiles: framework.files.map((f) => f.file),
    inputs: { modelSha256: await fileSha('model.json'), inventorySha256: await fileSha('inventory.json'), schemaReadAt: target.readAt, targetUrl: target.url, theme: path.basename(path.resolve(opts.themeRoot)) },
    ai,
    mediaBytes: (src) => sizes.get(src) ?? null,
  });
  const file = planFile(jobId, version);
  await writeJson(file, plan);
  await writeJson(dir(jobId, 'plan', `proposal.v${version}.json`), { draft, proposal: proposal === draft ? null : proposal, decisions: decided ? decisions : null });
  await writeFile(file.replace(/\.json$/, '.md'), renderDesignPlan(plan));
  const e = plan.expected;
  log(`Design plan v${version}: ${plan.templates.length} templates (${e.templates.update} framework files restyled, ${e.templates.create} new), ${e.postTypes} new post types, ${e.taxonomies} new taxonomies, ${e.fields} new fields in ${e.fieldGroups.extend} existing and ${e.fieldGroups.create} new groups, ${e.blocks.update + e.blocks.create} blocks, ${e.entries} sample pages and entries, ${e.media} images`);
  if (plan.warnings.length) log(`${plan.warnings.length} warnings (see the plan)`);
  return { plan, sha256: sha256(await readFile(file)) };
}

/** Words a label may use: the mockups' text, Figma's text and layer names, and class names. */
async function buildVocabulary(jobId: string, pages: MockupPage[], frames: FigmaFrame[], model: DesignModel): Promise<Vocabulary> {
  const layerNames: string[] = [];
  const nodes = await readJson<{ nodes: Record<string, { document: Node } | null> }>(dir(jobId, 'figma', 'nodes.json')).catch(() => ({ nodes: {} }));
  type Node = { name: string; type: string; visible?: boolean; children?: Node[] };
  const walk = (n: Node) => {
    if (n.visible === false) return;
    if (n.type !== 'TEXT') layerNames.push(n.name);
    n.children?.forEach(walk);
  };
  for (const e of Object.values(nodes.nodes)) if (e) walk(e.document);
  return vocabulary({
    pageTexts: pages.flatMap((p) => [...p.texts, ...p.headings.map((h) => h.text)]),
    figmaTexts: frames.flatMap((f) => f.texts),
    layerNames: [...layerNames, ...frames.map((f) => f.name)],
    classNames: [...new Set([...pages.flatMap((p) => p.classes), ...model.components.map((c) => c.id)])],
  });
}
