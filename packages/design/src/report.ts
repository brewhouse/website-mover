/** inventory.md: the ingest result for people. */
import type { Inventory } from './ingest.js';

export function renderInventory(inv: Inventory): string {
  const frame = new Map(inv.frames.map((f) => [f.id, f]));
  const match = new Map(inv.matches.map((m) => [m.frameId, m]));
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(`# Design inventory: ${inv.jobId}`, '', `Ingested ${inv.ingestedAt.slice(0, 16).replace('T', ' ')} UTC.`, '');
  if (inv.intake) {
    const drops = Object.entries(inv.intake.dropped).map(([why, n]) => `${n} ${why}`);
    push(`- **Mockups:** ${inv.pages.length} pages; ${inv.intake.kept} files kept${drops.length ? `, dropped ${drops.join(', ')}` : ''}.`);
  }
  push(
    `- **Figma:** "${inv.figma.fileName}", node ${inv.figma.nodeId}, version ${inv.figma.version}: ${inv.frames.length} frames, ${inv.figma.styles} shared styles.`,
    `- **Shell:** ${inv.shell.landmarks.join(', ') || 'none found'}; ${inv.shell.texts.length} strings shared by most pages.`,
    ...(inv.commonErrors.length ? [`- **Script errors on every page** (the mockup's own scripts, not checked further): ${inv.commonErrors.map((e) => `\`${e}\``).join(', ')}.`] : []),
    `- **To confirm:** ${inv.gaps.unconfirmed} of ${inv.matches.length} matches (in \`review/design-matches.json\`).`,
    '',
    '## Pages',
    '',
    '| Page | Heading | Desktop frame | Phone frame | Height at 1440 / 375 | Notes |',
    '|---|---|---|---|---|---|',
  );
  for (const p of inv.pages) {
    const frames = p.frames.map((id) => frame.get(id)!);
    const cell = (kind: string) =>
      frames
        .filter((f) => f.kind === kind)
        .map((f) => `${f.name} (\`${f.id}\`)`)
        .join('<br>') || '—';
    const h = (w: number) => p.screenshots.find((s) => s.width === w)?.height ?? '—';
    const notes = [p.screenshots.some((s) => s.width === 375 && s.overflow) ? 'scrolls sideways at 375' : null, p.screenshots.some((s) => s.errors.length) ? 'script errors' : null].filter(Boolean).join('; ');
    push(`| ${p.file} | ${esc(p.h1 ?? p.title)} | ${cell('desktop')} | ${cell('mobile')} | ${h(1440)} / ${h(375)} | ${notes} |`);
  }

  push('', '## Frames', '', '| Frame | Size | Role | Page | Score (name / text) | Why | Status |', '|---|---|---|---|---|---|---|');
  for (const f of inv.frames) {
    const m = match.get(f.id)!;
    push(`| ${esc(f.name)} (\`${f.id}\`) | ${f.width}×${f.height} | ${m.role} | ${m.page ?? '—'} | ${m.score} (${m.nameScore} / ${m.textScore}) | ${esc(m.reason)} | ${m.status} |`);
  }

  const g = inv.gaps;
  push('', '## Gaps', '');
  push(`- **Pages without a desktop frame:** ${g.pagesWithoutDesktopFrame.join(', ') || 'none'}.`);
  push(`- **Pages without a phone frame:** ${g.pagesWithoutMobileFrame.length} of ${inv.pages.length}. The phone layout is checked against the page's own CSS at 375 px.`);
  push(`- **Unmatched frames:** ${g.unmatchedFrames.map((id) => frame.get(id)!.name).join(', ') || 'none'}.`);
  push(`- **Ambiguous (a close second page):** ${g.ambiguous.map((id) => `${frame.get(id)!.name} → ${match.get(id)!.page} or ${match.get(id)!.runnerUp!.page}`).join('; ') || 'none'}.`);
  push('', 'To confirm or correct a match, add it to `review/design-matches.json` (`{ "<frame id>": "page.html" | "shell" | "reference" | null }`) and run ingest again.', '');
  return lines.join('\n');
}

const esc = (s: string) => s.replace(/\|/g, '\\|');
