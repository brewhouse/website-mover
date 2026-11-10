/**
 * Frame ↔ page matching (PLAN "Flow" 2). Deterministic: a name score (frame name against the page's
 * file name) and a text score (the frame's text layers found in the page, shell text left out and
 * rarer strings counting more). A person confirms or corrects every match on review.
 */
import type { FigmaFrame } from './figma.js';
import type { MockupPage } from './pages.js';

export type FrameRole =
  /** A page's design (or one state of it: a modal, a filter open). */
  | 'page'
  /** Only the shared shell (header, sidebar, footer), e.g. the mobile menu open. */
  | 'shell'
  /** A style guide or spec sheet: tokens and components, not a page. */
  | 'reference'
  /** Nothing matched well enough: a person decides. */
  | 'unmatched';

export interface FrameMatch {
  frameId: string;
  frameName: string;
  kind: FigmaFrame['kind'];
  role: FrameRole;
  page: string | null;
  score: number;
  nameScore: number;
  textScore: number;
  /** The next best page and its score, when it's close enough to be worth a look. */
  runnerUp: { page: string; score: number } | null;
  /** proposed: needs a person; confirmed: a person agreed or set it. */
  status: 'proposed' | 'confirmed';
  /** Why, in a few words, for the review screen. */
  reason: string;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'v1', 'v2', 'v3', 'mobile', 'desktop', 'html', 'htm', 'copy', 'final']);
const REFERENCE = /style ?guide|\bspecs?\b|typography|colou?rs?\b|design tokens|components?\b/i;
/** The shell in a state of its own (the phone menu open), whatever page shows behind it. */
const SHELL_STATE = /\b(menu|nav|navigation|header|footer|sidebar)\b/i;
/** Below this a frame is left for a person. */
export const MIN_SCORE = 0.3;
/** A runner-up within this much of the best makes the match ambiguous. */
export const AMBIGUOUS = 0.1;

/** Words in a frame name or page file name: lower case, simple plurals dropped, trailing digits off words. */
export function nameTokens(s: string): Set<string> {
  const words = s
    .replace(/\.html?$/i, '')
    .replace(/([a-z])(\d+)$/gi, '$1')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => w.replace(/([a-z])\d+$/, '$1'))
    .filter((w) => w && !STOP.has(w) && (w.length > 1 || /\d/.test(w)))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  const set = new Set(words);
  // index.html is the home page by convention, and designers call it home or dashboard.
  if (set.has('index')) ['home', 'dashboard'].forEach((w) => set.add(w));
  return set;
}

/**
 * How well a frame name fits a page file name: the mean of the Dice coefficient (penalizes extra
 * words) and the overlap coefficient (a short file name like "404" fully inside "404 Error Page").
 */
export function nameScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return (dice(a, b) + common / Math.min(a.size, b.size)) / 2;
}

export function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const w of a) if (b.has(w)) common++;
  return (2 * common) / (a.size + b.size);
}

/** Strings on at least this share of the pages are the shell (header, sidebar, footer). */
export function shellTexts(pages: MockupPage[], share = 0.6): Set<string> {
  const df = new Map<string, number>();
  for (const p of pages) for (const t of new Set(p.texts)) df.set(t, (df.get(t) ?? 0) + 1);
  return new Set([...df].filter(([, n]) => n >= Math.max(2, Math.ceil(pages.length * share))).map(([t]) => t));
}

export function matchFrames(frames: FigmaFrame[], pages: MockupPage[], overrides: Record<string, string | null> = {}): FrameMatch[] {
  const shell = shellTexts(pages);
  const content = new Map(pages.map((p) => [p.file, new Set(p.texts.filter((t) => !shell.has(t)))]));
  const df = new Map<string, number>();
  for (const set of content.values()) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + pages.length / Math.max(1, df.get(t) ?? 1));
  const pageNames = new Map(pages.map((p) => [p.file, nameTokens(p.file)]));

  const scored = frames.map((f) => {
    const own = f.texts.filter((t) => !shell.has(t));
    const shellShare = f.texts.length ? 1 - own.length / f.texts.length : 0;
    const total = own.reduce((s, t) => s + idf(t), 0);
    const fName = nameTokens(f.name);
    const candidates = pages
      .map((p) => {
        const set = content.get(p.file)!;
        const textScore = total ? own.filter((t) => set.has(t)).reduce((s, t) => s + idf(t), 0) / total : 0;
        const name = nameScore(fName, pageNames.get(p.file)!);
        return { page: p.file, nameScore: name, textScore, score: 0.4 * name + 0.6 * textScore };
      })
      .sort((a, b) => b.score - a.score);
    return { f, own, shellShare, candidates };
  });

  // Two designs of one page are normal (a list and its modal), but when two frames of the same kind
  // prefer one page and the second has a free alternative nearly as good, the second moves there.
  const chosen = new Map(scored.map((s) => [s.f.id, s.candidates[0]]));
  for (const s of [...scored].sort((a, b) => (a.candidates[0]?.score ?? 0) - (b.candidates[0]?.score ?? 0))) {
    const best = chosen.get(s.f.id);
    if (!best) continue;
    const rivals = scored.filter((o) => o !== s && o.f.kind === s.f.kind && chosen.get(o.f.id)?.page === best.page && (chosen.get(o.f.id)?.score ?? 0) >= best.score);
    if (!rivals.length) continue;
    const taken = new Set(scored.filter((o) => o.f.kind === s.f.kind && o !== s).map((o) => chosen.get(o.f.id)?.page));
    const alt = s.candidates.find((c) => c.page !== best.page && !taken.has(c.page) && c.score >= best.score - AMBIGUOUS && c.score >= MIN_SCORE);
    if (alt) chosen.set(s.f.id, alt);
  }

  return scored.map(({ f, own, shellShare, candidates }): FrameMatch => {
    const best = chosen.get(f.id);
    const runner = candidates.find((c) => c.page !== best?.page);
    const base = { frameId: f.id, frameName: f.name, kind: f.kind, nameScore: round(best?.nameScore ?? 0), textScore: round(best?.textScore ?? 0), score: round(best?.score ?? 0) };
    const runnerUp = best && runner && runner.score >= best.score - AMBIGUOUS && runner.score >= MIN_SCORE ? { page: runner.page, score: round(runner.score) } : null;

    if (f.id in overrides) {
      const v = overrides[f.id];
      const role: FrameRole = v === 'shell' || v === 'reference' ? v : v ? 'page' : 'unmatched';
      return { ...base, role, page: role === 'page' ? v! : null, runnerUp: null, status: 'confirmed', reason: 'set by a reviewer' };
    }
    if (REFERENCE.test(f.name) || f.kind === 'other') {
      return { ...base, role: 'reference', page: null, runnerUp: null, status: 'proposed', reason: REFERENCE.test(f.name) ? 'named as a style guide or spec' : `${f.width} px wide: not a desktop or phone page` };
    }
    // A state of the shell (a menu open): named so, or nearly all shell text with no page in its name.
    if ((best?.nameScore ?? 0) < 0.5 && (SHELL_STATE.test(f.name) || (shellShare >= 0.8 && own.length <= 5))) {
      return { ...base, role: 'shell', page: null, runnerUp: null, status: 'proposed', reason: SHELL_STATE.test(f.name) ? 'named as a menu or other shell part' : `${Math.round(shellShare * 100)}% of its text is the shared header, sidebar and footer` };
    }
    // A clear name match carries a page whose text the mockup didn't finish (403.html is a copy of 404.html).
    const nameOnly = best && best.nameScore >= 0.6 && !candidates.some((c) => c.page !== best.page && c.nameScore >= best.nameScore - AMBIGUOUS);
    if (!best || (best.score < MIN_SCORE && !nameOnly)) {
      return { ...base, role: 'unmatched', page: null, runnerUp: null, status: 'proposed', reason: best ? `best guess ${best.page} scored only ${round(best.score)}` : 'no pages' };
    }
    const why = [best.nameScore >= 0.5 ? 'name' : null, best.textScore >= 0.3 ? `${Math.round(best.textScore * 100)}% of its text` : null].filter(Boolean).join(' and ') || 'weak evidence';
    return { ...base, role: 'page', page: best.page, runnerUp, status: 'proposed', reason: runnerUp ? `${why}; close to ${runnerUp.page}` : why };
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
