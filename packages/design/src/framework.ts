/**
 * The framework theme (planeteriaweb) as class sets per file, so a mockup component can be matched
 * to the template or block it restyles (docs/build/PLAN.md "The mockups are a restyle of planeteriaweb").
 * Reads the site's own clone; never writes to it.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface FrameworkFile {
  /** Path from the theme root, e.g. "template-parts/blocks/general_list/image_text_card.php". */
  file: string;
  classes: string[];
  /** ACF block name, when functions.php registers this file as a block's render template. */
  block: string | null;
}

export interface FrameworkIndex {
  root: string;
  files: FrameworkFile[];
  /** The file holding the largest share of the given classes (at least `min`), smaller files winning ties. */
  best(classes: string[], min?: number, only?: (file: string) => boolean): { file: string; block: string | null; share: number } | null;
}

const UTILITY = /^(row|container(-fluid)?|col(-\w+)*|[mp][trblxy]?-\d|d-\w+|flex-\w+|justify-content-\w+|align-items-\w+|text-\w+|btn|btn-\w+|img-fluid|w-100|h-100|clearfix|active|show|fade|collapse|sr-only|visually-hidden)$/;

/** Class names in PHP templates: literal class="…" values with any PHP inside left out. */
export function phpClasses(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/class\s*=\s*(["'])([\s\S]*?)\1/g)) {
    const value = m[2]!.replace(/<\?(php|=)[\s\S]*?\?>/g, ' ');
    for (const c of value.split(/\s+/)) if (/^[a-zA-Z_][\w-]*$/.test(c) && !UTILITY.test(c)) out.add(c);
  }
  return [...out].sort();
}

/** Block name → render template, from acf_register_block_type calls in functions.php and inc/. */
export function blockRegistry(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of source.matchAll(/'name'\s*=>\s*'([\w-]+)'[\s\S]{0,400}?'render_template'\s*=>\s*'([^']+)'/g)) map.set(m[2]!.replace(/^\//, ''), m[1]!);
  return map;
}

export async function indexFramework(themeRoot: string): Promise<FrameworkIndex> {
  const files: { file: string; source: string }[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.php')) files.push({ file: path.relative(themeRoot, full).split(path.sep).join('/'), source: await readFile(full, 'utf8') });
    }
  };
  await walk(themeRoot);
  if (!files.length) throw new Error(`No PHP files under ${themeRoot}: is this the theme folder?`);
  const blocks = new Map<string, string>();
  for (const f of files.filter((x) => x.file === 'functions.php' || x.file.startsWith('inc/'))) for (const [k, v] of blockRegistry(f.source)) blocks.set(k, v);
  return frameworkIndex(themeRoot, files.map((f) => ({ file: f.file, classes: phpClasses(f.source), block: blocks.get(f.file) ?? null })));
}

export function frameworkIndex(root: string, files: FrameworkFile[]): FrameworkIndex {
  const sets = files.map((f) => ({ ...f, set: new Set(f.classes) }));
  return {
    root,
    files,
    best(classes, min = 0.3, only) {
      const own = classes.filter((c) => !UTILITY.test(c));
      if (!own.length) return null;
      let best: { file: string; block: string | null; share: number; size: number } | null = null;
      for (const f of sets) {
        if (only && !only(f.file)) continue;
        const share = own.filter((c) => f.set.has(c)).length / own.length;
        if (share >= min && (!best || share > best.share + 1e-9 || (Math.abs(share - best.share) < 1e-9 && f.set.size < best.size))) best = { file: f.file, block: f.block, share, size: f.set.size };
      }
      return best && { file: best.file, block: best.block, share: Math.round(best.share * 100) / 100 };
    },
  };
}
