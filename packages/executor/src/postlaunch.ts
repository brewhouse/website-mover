/**
 * Post-launch check (docs/m5/design.md §3): every legacy URL against the live domain. Redirects are
 * followed one hop at a time, so chains and wrong targets show; kept URLs must answer 200; the
 * homepage must carry the GA4 tag. Re-runnable during stabilization; before launch, run it against
 * the target.
 */
import { jobPath, writeJson } from '@wm/core';
import { safeFetch } from '@wm/net';
import { loadPlan } from '@wm/planner';
import { loadRunState, mapLimit } from './execute.js';

export interface PostLaunchProblem {
  /** The legacy path requested. */
  url: string;
  problem: 'not-found' | 'error' | 'wrong-target' | 'chain' | 'loop';
  /** Every hop: status and where it pointed. */
  hops: { status: number; location: string | null }[];
  expected: string;
}

export interface PostLaunchReport {
  jobId: string;
  base: string;
  ranAt: string;
  checked: number;
  ok: number;
  problems: PostLaunchProblem[];
  ga4: { expected: string | null; found: string[] };
}

const MAX_HOPS = 5;

export async function runPostLaunch({ jobId, base, ga4Id, log = console.log }: { jobId: string; base: string; ga4Id?: string | null; log?: (msg: string) => void }): Promise<PostLaunchReport> {
  const origin = new URL(base).origin;
  const state = await loadRunState(jobId);
  const { plan } = await loadPlan(jobId, state.planVersion);

  // Legacy URLs: every redirect source (it must reach its page in one hop), and every source URL the
  // new site keeps as it is (it must answer 200).
  const checks = new Map<string, string>();
  for (const r of state.redirects) checks.set(r.from, r.to);
  for (const i of plan.items) {
    const source = new URL(i.sourceUrl);
    const path = source.pathname + source.search;
    if (!checks.has(path) && state.entities[i.sourceKey]) checks.set(path, state.entities[i.sourceKey]!.path || i.targetPath);
  }
  log(`Post-launch check: ${checks.size} legacy URLs on ${origin}`);

  const problems: PostLaunchProblem[] = [];
  let ok = 0;
  await mapLimit([...checks], 6, async ([path, expected]) => {
    const hops: PostLaunchProblem['hops'] = [];
    let url = origin + path;
    const seen = new Set<string>();
    for (let i = 0; i < MAX_HOPS; i++) {
      let status = 0;
      let location: string | null = null;
      try {
        const res = await safeFetch(url, { method: 'GET', redirect: 'manual' });
        status = res.status;
        location = res.headers.get('location');
        await res.body?.cancel();
      } catch {
        status = 0;
      }
      hops.push({ status, location });
      if (status < 300 || status >= 400 || !location) break;
      const next = new URL(location, url).href;
      if (seen.has(next)) break;
      seen.add(url);
      url = next;
    }
    const final = hops.at(-1)!;
    const landed = new URL(url).pathname;
    const redirects = hops.filter((h) => h.status >= 300 && h.status < 400).length;
    const problem: PostLaunchProblem['problem'] | null =
      final.status >= 300 && final.status < 400 ? 'loop'
      : final.status === 404 || final.status === 410 ? 'not-found'
      : final.status !== 200 ? 'error'
      : normalize(landed) !== normalize(expected) ? 'wrong-target'
      : redirects > 1 ? 'chain'
      : null;
    if (problem) problems.push({ url: path, problem, hops, expected });
    else ok++;
  });
  problems.sort((a, b) => a.problem.localeCompare(b.problem) || a.url.localeCompare(b.url));

  // GA4: the tag's measurement IDs on the homepage.
  const home = await safeFetch(origin + '/', { redirect: 'follow' }).then((r) => r.text()).catch(() => '');
  const found = [...new Set([...home.matchAll(/\b(G-[A-Z0-9]{4,12})\b/g)].map((m) => m[1]!))];

  const report: PostLaunchReport = { jobId, base: origin, ranAt: new Date().toISOString(), checked: checks.size, ok, problems, ga4: { expected: ga4Id ?? null, found } };
  await writeJson(jobPath(jobId, 'postlaunch', 'postlaunch.json'), report);
  const by = (p: string) => problems.filter((x) => x.problem === p).length;
  log(`Post-launch: ${ok} of ${checks.size} OK; not found ${by('not-found')}, errors ${by('error')}, wrong target ${by('wrong-target')}, chains ${by('chain')}, loops ${by('loop')}`);
  log(ga4Id ? (found.includes(ga4Id) ? `GA4 ${ga4Id}: on the homepage` : `  ! GA4 ${ga4Id}: not on the homepage${found.length ? ` (found ${found.join(', ')})` : ''}`) : 'GA4: no measurement ID for this job');
  return report;
}

/** Paths compare without case, a trailing slash or percent-encoding differences. */
function normalize(path: string): string {
  try {
    return decodeURIComponent(path).toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return path.toLowerCase().replace(/\/+$/, '') || '/';
  }
}
