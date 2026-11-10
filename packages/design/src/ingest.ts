/**
 * B1 Ingest (docs/build/PLAN.md "Flow" 2): from the mockup zip and the Figma page to an inventory of
 * pages and frames with proposed matches. Writes, under the job's design/ folder:
 *   source/                the unpacked mockups
 *   pages.json             each page's text, headings, landmarks, classes, assets and links
 *   screenshots/           each page at 1440 and 375 px
 *   figma/nodes.json       the Figma page as the API returned it (cached; refresh re-reads it)
 *   figma/frames/          each frame rendered to PNG
 *   inventory.json         pages, frames, matches, shell text and what's missing
 *   inventory.md           the same for people
 * Reviewers confirm or correct matches in review/design-matches.json ({ "<frame id>": "page.html" |
 * "shell" | "reference" | null }); re-running ingest applies them.
 */
import { access, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jobPath, readJson, writeJson } from '@wm/core';
import { FigmaClient, parseFigmaUrl, summarizeFrames, type FigmaFrame, type FigmaNodesResponse, type FigmaStyle } from './figma.js';
import { unpackMockups, type IntakeResult } from './intake.js';
import { matchFrames, shellTexts, type FrameMatch } from './match.js';
import { readPages, type MockupPage } from './pages.js';
import { screenshotPages, type PageShot } from './screenshots.js';
import { renderInventory } from './report.js';

export interface IngestOptions {
  jobId: string;
  /** The mockup zip. Omitted: reuse what an earlier run unpacked. */
  zip?: string;
  /** Link to the Figma page holding the frames. Omitted: reuse the cached Figma read. */
  figmaUrl?: string;
  figmaToken?: string;
  /** Re-read Figma and re-render frames even if cached. */
  refresh?: boolean;
  /** Skip the page screenshots (faster; matching doesn't need them). */
  skipScreenshots?: boolean;
  log?: (msg: string) => void;
}

export interface Inventory {
  jobId: string;
  ingestedAt: string;
  intake: Omit<IntakeResult, 'root'> | null;
  figma: { fileKey: string; nodeId: string; fileName: string; version: string; lastModified: string; styles: number };
  pages: {
    file: string;
    title: string;
    h1: string | null;
    landmarks: string[];
    texts: number;
    images: number;
    links: string[];
    screenshots: Pick<PageShot, 'width' | 'image' | 'height' | 'overflow' | 'errors'>[];
    /** Frames matched to this page, desktop first. */
    frames: string[];
  }[];
  frames: (Pick<FigmaFrame, 'id' | 'name' | 'kind' | 'width' | 'height' | 'sections'> & { texts: number; image: string | null; scale: number | null })[];
  matches: FrameMatch[];
  /** Script errors every page logs: the mockup's own, listed once rather than per page. */
  commonErrors: string[];
  /** Text on most pages: the shared header, sidebar and footer. */
  shell: { texts: string[]; landmarks: string[] };
  gaps: {
    pagesWithoutDesktopFrame: string[];
    pagesWithoutMobileFrame: string[];
    unmatchedFrames: string[];
    ambiguous: string[];
    unconfirmed: number;
  };
}

export async function ingestDesign(opts: IngestOptions): Promise<Inventory> {
  const log = opts.log ?? (() => {});
  const dir = (...p: string[]) => jobPath(opts.jobId, 'design', ...p);
  const source = dir('source');

  // 1. Mockups
  let intake: IntakeResult | null = null;
  if (opts.zip) {
    intake = await unpackMockups(path.resolve(opts.zip), source);
    const drops = Object.entries(intake.dropped).map(([why, n]) => `${n} ${why}`).join(', ');
    log(`Unpacked ${intake.kept} files (${mb(intake.bytes)})${drops ? `; dropped ${drops}` : ''}`);
    await writeJson(dir('intake.json'), { ...intake, root: undefined, zip: path.basename(opts.zip) });
  } else {
    if (!(await exists(source))) throw new Error('No mockups yet: give the zip (--zip)');
    intake = await readJson<IntakeResult>(dir('intake.json')).catch(() => null);
  }
  const pages = await readPages(source);
  if (!pages.length) throw new Error('The zip has no .html pages at its top level');
  await writeJson(dir('pages.json'), pages);
  log(`Read ${pages.length} pages`);

  // 2. Figma
  const nodesFile = dir('figma', 'nodes.json');
  const metaFile = dir('figma', 'ref.json');
  let ref = opts.figmaUrl ? parseFigmaUrl(opts.figmaUrl) : await readJson<{ fileKey: string; nodeId: string }>(metaFile).catch(() => null);
  if (!ref) throw new Error('No Figma read yet: give the Figma link (--figma)');
  const cached = await readJson<{ fileKey: string; nodeId: string }>(metaFile).catch(() => null);
  const sameRef = cached?.fileKey === ref.fileKey && cached.nodeId === ref.nodeId;
  const client = () => new FigmaClient(opts.figmaToken ?? process.env.FIGMA_ACCESS_TOKEN ?? '', log);
  let nodes: FigmaNodesResponse;
  if (sameRef && !opts.refresh && (await exists(nodesFile))) {
    nodes = await readJson<FigmaNodesResponse>(nodesFile);
    log(`Figma: using the cached read of "${nodes.name}" (version ${nodes.version}); --refresh re-reads it`);
  } else {
    log(`Figma: reading ${ref.fileKey} node ${ref.nodeId}`);
    nodes = await client().nodes(ref);
    await writeJson(nodesFile, nodes);
    await writeJson(metaFile, ref);
  }
  const { frames, styles } = summarizeFrames(nodes, ref.nodeId);
  await writeJson(dir('figma', 'frames.json'), frames);
  await writeJson(dir('figma', 'styles.json'), styles satisfies FigmaStyle[]);
  log(`Figma: ${frames.length} frames (${count(frames, 'desktop')} desktop, ${count(frames, 'mobile')} phone, ${count(frames, 'other')} other), ${styles.length} shared styles`);

  const framesDir = dir('figma', 'frames');
  const renders = await readJson<Record<string, { file: string; scale: number }>>(dir('figma', 'renders.json')).catch(() => ({}) as Record<string, { file: string; scale: number }>);
  const missing = frames.filter((f) => opts.refresh || !sameRef || !renders[f.id]);
  const present = await readdir(framesDir).catch(() => [] as string[]);
  const toRender = missing.length ? missing : frames.filter((f) => !present.includes(renders[f.id]?.file ?? ''));
  if (toRender.length) {
    log(`Figma: rendering ${toRender.length} frames`);
    Object.assign(renders, await client().render(ref.fileKey, toRender, framesDir));
    await writeJson(dir('figma', 'renders.json'), renders);
  }

  // 3. Screenshots
  let shots: PageShot[] = await readJson<PageShot[]>(dir('screenshots.json')).catch(() => []);
  if (!opts.skipScreenshots) {
    log('Screenshots:');
    shots = await screenshotPages(source, pages.map((p) => p.file), dir('screenshots'), log);
    await writeJson(dir('screenshots.json'), shots);
  }

  // 4. Matching
  const overrides = await readJson<Record<string, string | null>>(jobPath(opts.jobId, 'review', 'design-matches.json')).catch(() => ({}));
  const unknown = Object.entries(overrides).filter(([id, v]) => !frames.some((f) => f.id === id) || (v && !['shell', 'reference'].includes(v) && !pages.some((p) => p.file === v)));
  if (unknown.length) throw new Error(`review/design-matches.json names frames or pages that don't exist: ${unknown.map(([id, v]) => `${id} → ${v}`).join(', ')}`);
  const matches = matchFrames(frames, pages, overrides);

  const inventory = buildInventory(opts.jobId, intake, ref, nodes, styles.length, pages, frames, renders, shots, matches);
  await writeJson(dir('inventory.json'), inventory);
  const md = renderInventory(inventory);
  await writeFile(dir('inventory.md'), md);
  const g = inventory.gaps;
  log(`Matched ${matches.filter((m) => m.role === 'page').length} frames to pages, ${matches.filter((m) => m.role === 'shell').length} to the shell, ${matches.filter((m) => m.role === 'reference').length} references; ${g.unmatchedFrames.length} unmatched, ${g.ambiguous.length} ambiguous, ${g.unconfirmed} to confirm`);
  if (g.pagesWithoutDesktopFrame.length) log(`Pages without a desktop frame: ${g.pagesWithoutDesktopFrame.join(', ')}`);
  return inventory;
}

function buildInventory(
  jobId: string,
  intake: IntakeResult | null,
  ref: { fileKey: string; nodeId: string },
  nodes: FigmaNodesResponse,
  styleCount: number,
  pages: MockupPage[],
  frames: FigmaFrame[],
  renders: Record<string, { file: string; scale: number }>,
  shots: PageShot[],
  matches: FrameMatch[],
): Inventory {
  const shell = shellTexts(pages);
  const byPage = (file: string) => matches.filter((m) => m.role === 'page' && m.page === file);
  const commonErrors = [...new Set(shots.flatMap((s) => s.errors))].filter((e) => pages.every((p) => shots.some((s) => s.file === p.file && s.errors.includes(e))));
  const landmarkCounts = new Map<string, number>();
  for (const p of pages) for (const l of p.landmarks) landmarkCounts.set(l, (landmarkCounts.get(l) ?? 0) + 1);
  return {
    jobId,
    ingestedAt: new Date().toISOString(),
    intake: intake ? { kept: intake.kept, bytes: intake.bytes, dropped: intake.dropped, strippedPrefix: intake.strippedPrefix } : null,
    figma: { ...ref, fileName: nodes.name, version: nodes.version, lastModified: nodes.lastModified, styles: styleCount },
    pages: pages.map((p) => ({
      file: p.file,
      title: p.title,
      h1: p.h1,
      landmarks: p.landmarks,
      texts: p.texts.length,
      images: p.images.length,
      links: p.links,
      screenshots: shots.filter((s) => s.file === p.file).map(({ width, image, height, overflow, errors }) => ({ width, image, height, overflow, errors: errors.filter((e) => !commonErrors.includes(e)) })),
      frames: byPage(p.file)
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'desktop' ? -1 : 1))
        .map((m) => m.frameId),
    })),
    frames: frames.map((f) => ({ id: f.id, name: f.name, kind: f.kind, width: f.width, height: f.height, sections: f.sections, texts: f.texts.length, image: renders[f.id]?.file ?? null, scale: renders[f.id]?.scale ?? null })),
    matches,
    commonErrors,
    shell: { texts: [...shell], landmarks: [...landmarkCounts].filter(([, n]) => n >= pages.length * 0.6).map(([l]) => l) },
    gaps: {
      pagesWithoutDesktopFrame: pages.filter((p) => !byPage(p.file).some((m) => m.kind === 'desktop')).map((p) => p.file),
      pagesWithoutMobileFrame: pages.filter((p) => !byPage(p.file).some((m) => m.kind === 'mobile')).map((p) => p.file),
      unmatchedFrames: matches.filter((m) => m.role === 'unmatched').map((m) => m.frameId),
      ambiguous: matches.filter((m) => m.runnerUp && m.status === 'proposed').map((m) => m.frameId),
      unconfirmed: matches.filter((m) => m.status === 'proposed').length,
    },
  };
}

const count = (frames: FigmaFrame[], kind: FigmaFrame['kind']) => frames.filter((f) => f.kind === kind).length;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}
