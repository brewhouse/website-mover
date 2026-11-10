/**
 * Figma ingest (PLAN "Flow" 2): reads one Figma page's frames, their text and layer names, and the
 * file's shared styles, and renders each frame to PNG. Read-only REST API with a personal access
 * token (FIGMA_ACCESS_TOKEN).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeFetch } from '@wm/net';
import { normText } from './pages.js';

const API = 'https://api.figma.com';
type FetchResponse = Awaited<ReturnType<typeof safeFetch>>;

export interface FigmaRef {
  fileKey: string;
  /** The page (canvas) or frame to read, "8173:34". */
  nodeId: string;
}

/** Reads a figma.com/design (or /file) link, e.g. ".../design/<key>/<name>?node-id=8173-34". */
export function parseFigmaUrl(input: string): FigmaRef {
  const url = new URL(input);
  if (url.hostname !== 'figma.com' && !url.hostname.endsWith('.figma.com')) throw new Error('Not a Figma link');
  const m = url.pathname.match(/^\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error('The Figma link has no file key (expected figma.com/design/<key>/…)');
  const node = url.searchParams.get('node-id');
  if (!node) throw new Error('The Figma link has no node-id: open the page with the frames and copy its link');
  return { fileKey: m[1]!, nodeId: node.replace('-', ':') };
}

export interface FigmaFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  /** desktop (1200–1700 px wide), mobile (320–480 px), or other. */
  kind: 'desktop' | 'mobile' | 'other';
  /** Visible text layers, normalized (normText), without repeats. */
  texts: string[];
  /** Distinct names of the frame's direct children: often the designer's section names. */
  sections: string[];
  /** Shared styles the frame uses, by style id. */
  styleIds: string[];
}

export interface FigmaStyle {
  id: string;
  name: string;
  type: string;
  description: string;
}

interface Node {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  characters?: string;
  children?: Node[];
  styles?: Record<string, string>;
  absoluteBoundingBox?: { width: number; height: number };
}

export interface FigmaNodesResponse {
  name: string;
  lastModified: string;
  version: string;
  nodes: Record<string, { document: Node; styles?: Record<string, { name: string; styleType: string; description?: string }> } | null>;
}

export class FigmaClient {
  constructor(private token: string, private log: (msg: string) => void = () => {}) {
    if (!token) throw new Error('FIGMA_ACCESS_TOKEN is not set');
  }

  async nodes(ref: FigmaRef): Promise<FigmaNodesResponse> {
    return (await this.get(`/v1/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}`)).json() as Promise<FigmaNodesResponse>;
  }

  /**
   * Renders frames to PNG files in dir, named "<id with - for :>.png". Frames taller than maxHeight
   * pixels are rendered at a smaller scale, so the image stays within Figma's render limits.
   */
  async render(fileKey: string, frames: Pick<FigmaFrame, 'id' | 'height'>[], dir: string, maxHeight = 10_000): Promise<Record<string, { file: string; scale: number }>> {
    await mkdir(dir, { recursive: true });
    const out: Record<string, { file: string; scale: number }> = {};
    const byScale = new Map<number, string[]>();
    for (const f of frames) {
      const scale = f.height > maxHeight ? 0.5 : 1;
      byScale.set(scale, [...(byScale.get(scale) ?? []), f.id]);
    }
    for (const [scale, ids] of byScale) {
      // A few at a time: Figma renders each request in one go, and big frames time out together.
      for (let i = 0; i < ids.length; i += 4) {
        const batch = ids.slice(i, i + 4);
        const res = (await (await this.get(`/v1/images/${fileKey}?ids=${encodeURIComponent(batch.join(','))}&format=png&scale=${scale}`)).json()) as { err: string | null; images: Record<string, string | null> };
        if (res.err) throw new Error(`Figma render failed: ${res.err}`);
        for (const id of batch) {
          const src = res.images[id];
          if (!src) {
            this.log(`  ! Figma did not render frame ${id}`);
            continue;
          }
          const file = `${id.replace(/:/g, '-')}.png`;
          await writeFile(path.join(dir, file), Buffer.from(await (await this.fetchRetry(src)).arrayBuffer()));
          out[id] = { file, scale };
          this.log(`  frame ${id} rendered at ${scale}x`);
        }
      }
    }
    return out;
  }

  private get(pathAndQuery: string): Promise<FetchResponse> {
    return this.fetchRetry(`${API}${pathAndQuery}`, { 'X-Figma-Token': this.token });
  }

  /** Retries rate limits, server errors and dropped connections (seen on large renders). */
  private async fetchRetry(url: string, headers: Record<string, string> = {}): Promise<FetchResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await safeFetch(url, { headers });
        if (res.ok) return res;
        if (res.status === 403) throw new Error('Figma refused the token (403): check FIGMA_ACCESS_TOKEN and that it can read this file');
        if (res.status === 404) throw new Error('Figma file or node not found (404)');
        if ((res.status !== 429 && res.status < 500) || attempt >= 5) throw new Error(`Figma answered ${res.status} for ${url.split('?')[0]}`);
        const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * attempt;
        this.log(`  Figma answered ${res.status}; retrying in ${Math.round(wait / 1000)} s`);
        await new Promise((r) => setTimeout(r, Math.min(wait, 60_000)));
      } catch (err) {
        const msg = (err as Error).message;
        if (attempt >= 5 || /^Figma (refused|file|answered)/.test(msg)) throw err;
        this.log(`  ${msg}; retrying`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
}

export function frameKind(width: number): FigmaFrame['kind'] {
  if (width >= 1200 && width <= 1700) return 'desktop';
  if (width >= 320 && width <= 480) return 'mobile';
  return 'other';
}

/** The frames on the page (or the one frame) the reference points at, with their text. */
export function summarizeFrames(res: FigmaNodesResponse, nodeId: string): { frames: FigmaFrame[]; styles: FigmaStyle[] } {
  const entry = res.nodes[nodeId];
  if (!entry) throw new Error(`Figma node ${nodeId} not found in the file`);
  const root = entry.document;
  const tops = root.type === 'CANVAS' || root.type === 'SECTION' ? (root.children ?? []).flatMap((c) => (c.type === 'SECTION' ? c.children ?? [] : [c])) : [root];
  const frames = tops
    .filter((n) => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(n.type) && n.visible !== false)
    .map((n): FigmaFrame => {
      const texts = new Set<string>();
      const styleIds = new Set<string>();
      const walk = (node: Node) => {
        if (node.visible === false) return;
        if (node.type === 'TEXT' && node.characters) {
          // A text layer with line breaks is several lines in the HTML.
          for (const line of node.characters.split(/\n+/)) {
            const t = normText(line);
            if (t.length > 1 && /\p{L}|\d/u.test(t)) texts.add(t);
          }
          const whole = normText(node.characters);
          if (whole.length > 1) texts.add(whole);
        }
        for (const s of Object.values(node.styles ?? {})) styleIds.add(s);
        for (const c of node.children ?? []) walk(c);
      };
      walk(n);
      const box = n.absoluteBoundingBox ?? { width: 0, height: 0 };
      return {
        id: n.id,
        name: n.name.trim(),
        width: Math.round(box.width),
        height: Math.round(box.height),
        kind: frameKind(box.width),
        texts: [...texts],
        sections: [...new Set((n.children ?? []).filter((c) => c.visible !== false).map((c) => c.name.trim()))],
        styleIds: [...styleIds].sort(),
      };
    });
  const styles = Object.entries(entry.styles ?? {}).map(([id, s]) => ({ id, name: s.name, type: s.styleType, description: s.description ?? '' }));
  return { frames, styles };
}
