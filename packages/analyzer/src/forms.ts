import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { jobPath, readJsonl, sourceKey, writeJson, type ExtractedPage, type FormAnalysis, type SnapshotPage } from '@wm/core';
import { readPageForms, type PageForm } from './forms/page.js';

/**
 * Finds the web forms on the job's pages and writes analyze/forms.json: one plugin-neutral spec
 * per form (the bridge's POST /forms body), with its kind, sensitive fields and warnings.
 *
 * Reads the raw snapshot HTML, not the extracted content: some forms are drawn by scripts
 * (jQuery formBuilder JSON, markup injected on change), which extraction removes. Pages are the
 * extracted ones, so keys match extract/pages.jsonl. Site chrome is skipped: search boxes, forms in
 * the header/footer/nav, and any form repeated on most pages.
 */
export async function analyzeForms(jobId: string, log: (msg: string) => void = () => {}): Promise<FormAnalysis> {
  const job = (...parts: string[]) => jobPath(jobId, ...parts);
  const pages = await readJsonl<ExtractedPage>(job('extract', 'pages.jsonl'));
  const snapshot = await readJsonl<SnapshotPage>(job('snapshot', 'pages.jsonl'));

  // Raw HTML by the extracted page's key (its final URL); a page fetched under its own URL wins
  // over one reached through a redirect.
  const htmlByKey = new Map<string, string>();
  for (const s of snapshot) {
    if (s.status !== 200 || !s.html) continue;
    const key = sourceKey(s.finalUrl || s.url);
    if (!htmlByKey.has(key) || sourceKey(s.url) === key) htmlByKey.set(key, s.html);
  }

  const found: PageForm[] = [];
  for (const page of pages) {
    const file = htmlByKey.get(page.sourceKey);
    if (!file) continue;
    const html = await readFile(job(file), 'utf8');
    if (!/<form\b|\.formRender\s*\(/i.test(html)) continue;
    found.push(...readPageForms(cheerio.load(html), { url: new URL(page.url), key: page.sourceKey, title: page.title }));
  }

  // A form with the same action and inputs on most pages is part of the layout.
  const pagesWith = new Map<string, Set<string>>();
  for (const f of found) pagesWith.set(f.signature, (pagesWith.get(f.signature) ?? new Set()).add(f.record.pageKey));
  const repeated = new Set([...pagesWith].filter(([, keys]) => keys.size >= 3 && keys.size > pages.length / 2).map(([sig]) => sig));
  for (const sig of repeated) log(`Skipping a form repeated on ${pagesWith.get(sig)!.size} pages (site chrome): ${sig}`);

  const perPage = new Map<string, number>();
  const forms = found
    .filter((f) => !repeated.has(f.signature))
    .map((f) => {
      const n = (perPage.get(f.record.pageKey) ?? 0) + 1;
      perPage.set(f.record.pageKey, n);
      return { ...f.record, key: `${f.record.pageKey}#form-${n}` };
    });
  for (const f of forms) {
    const inputs = f.fields.filter((x) => x.type !== 'html' && x.type !== 'section').length;
    log(`${f.key}: ${f.kind} "${f.title}" (${f.implementation}), ${inputs} fields${f.sensitive.length ? `, sensitive: ${f.sensitive.join('; ')}` : ''}${f.uploads ? ', uploads' : ''}`);
  }
  const analysis: FormAnalysis = { forms };
  await writeJson(job('analyze', 'forms.json'), analysis);
  return analysis;
}
