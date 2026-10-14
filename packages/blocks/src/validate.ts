/**
 * Validate serialized block markup the way the block editor does when it opens
 * a post: `parse()` runs every block's `save()` against the stored HTML.
 */
import { format } from 'node:util';
import type { Block } from './wp-types.js';
import { loadWordPress } from './env.js';

export type IssueKind =
  /** The editor would show "This block contains unexpected or invalid content". */
  | 'invalid'
  /** Only valid through a deprecation: the editor silently rewrites it on save. */
  | 'deprecated'
  /** Valid, but parse() migrates or fixes its attributes, so it re-serializes differently. */
  | 'drift'
  /** Undelimited HTML → Classic block. */
  | 'freeform'
  /** Block type not registered (e.g. a plugin block we didn't register). */
  | 'missing'
  /** core/html fallback: valid, but content we couldn't map to a real block. */
  | 'html';

export interface BlockIssue {
  kind: IssueKind;
  name: string;
  /** Position in the tree, e.g. "3.0.1" (top-level index, then inner indexes). */
  path: string;
  messages: string[];
}

export interface ValidationReport {
  /** No errors and the markup survives parse → serialize unchanged. */
  ok: boolean;
  blockCount: number;
  /** Every block name in document order (depth-first). */
  names: string[];
  errors: BlockIssue[];
  /** core/html fallbacks; allowed, but counted as warnings in the report. */
  warnings: BlockIssue[];
  /** serialize(parse(markup)) === markup */
  roundTrip: boolean;
}

export function validateSerialized(markup: string): ValidationReport {
  const wp = loadWordPress();
  const blocks = quietly(() => wp.parse(markup));
  const report: ValidationReport = {
    ok: false,
    blockCount: 0,
    names: [],
    errors: [],
    warnings: [],
    roundTrip: wp.serialize(blocks) === markup,
  };

  const visit = (block: Block, path: string) => {
    report.blockCount++;
    report.names.push(block.name);
    const issue = (kind: IssueKind, messages: string[] = []) => ({ kind, name: block.name, path, messages });

    if (block.name === 'core/freeform') report.errors.push(issue('freeform'));
    else if (block.name === 'core/missing') {
      report.errors.push(issue('missing', [`unregistered block ${String(block.attributes.originalName ?? '(none)')}`]));
    } else if (block.isValid === false) {
      report.errors.push(issue('invalid', formatIssues(block.validationIssues)));
    } else {
      // parse() quietly migrates blocks that match a deprecated save(); re-check
      // the stored HTML against the current save() to catch that.
      const type = wp.getBlockType(block.name);
      if (type && block.originalContent !== undefined) {
        const [valid, issues] = quietly(() => wp.validateBlock(block, type));
        if (!valid) report.errors.push(issue('deprecated', formatIssues(issues)));
      }
      if (block.name === 'core/html') report.warnings.push(issue('html'));
    }
    block.innerBlocks.forEach((inner, i) => visit(inner, `${path}.${i}`));
  };
  blocks.forEach((block, i) => {
    visit(block, String(i));
    // Pinpoint which top-level block breaks the round trip (if no error explains it yet).
    const again = wp.serialize([block]);
    const explained = report.errors.some((e) => e.path === String(i) || e.path.startsWith(`${i}.`));
    if (!report.roundTrip && !markup.includes(again) && !explained) {
      report.errors.push({ kind: 'drift', name: block.name, path: String(i), messages: [`re-serializes as ${again.split('\n')[0]}`] });
    }
  });

  report.ok = report.errors.length === 0 && report.roundTrip;
  return report;
}

type LoggedIssue = { log?: unknown; args?: unknown[] };

function formatIssues(issues: unknown): string[] {
  return ((issues as LoggedIssue[] | undefined) ?? []).map(({ args = [] }) =>
    // args[0] is a printf-style template; the block type object is noise.
    format(...args.map((a) => (a && typeof a === 'object' && 'save' in a ? '<blockType>' : a))),
  );
}

/** parse()/validateBlock() log each problem (with the whole block type) to the console. */
function quietly<T>(fn: () => T): T {
  const saved = { error: console.error, warn: console.warn, info: console.info, group: console.groupCollapsed, end: console.groupEnd };
  console.error = console.warn = console.info = console.groupCollapsed = console.groupEnd = () => {};
  try {
    return fn();
  } finally {
    Object.assign(console, { error: saved.error, warn: saved.warn, info: saved.info, groupCollapsed: saved.group, groupEnd: saved.end });
  }
}
