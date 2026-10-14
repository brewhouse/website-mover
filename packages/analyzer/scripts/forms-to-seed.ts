/**
 * M2 check: rebuild JHA's web forms on the local seed and prove they work.
 *
 * 1. analyzeForms('jha') → analyze/forms.json.
 * 2. Each `kind: 'form'` is posted to the bridge (POST /website-mover/v1/forms, idempotent by
 *    source_key). Forms with sensitive fields get `sensitive_fields` and a 30-day retention.
 * 3. A throwaway page holds every form's block; each form must render with all its fields. The
 *    page is deleted afterwards (the forms stay; re-runs update them in place).
 * 4. Read back through WP-CLI: for forms with sensitive fields, the notification rendered for a
 *    test entry leaves those values out, and the retention policy deletes entries after 30 days.
 *
 * Run (local seed up, see e2e/seed): pnpm exec tsx --env-file=.env packages/analyzer/scripts/forms-to-seed.ts
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as cheerio from 'cheerio';
import type { FormRecord } from '@wm/core';
import { localSeedClient } from '@wm/wp-client';
import { analyzeForms } from '../src/forms.ts';

const RETENTION_DAYS = 30;
const ROOT = path.resolve(import.meta.dirname, '../../..');
const wp = localSeedClient();

type FormResult = {
  id: number;
  created: boolean;
  sensitive_field_ids: number[];
  retention: { policy: string; retain_entries_days?: number };
  block: { name: string; attrs: { formId: string } };
};
type Page = { id: number; link: string };

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

async function main() {
  const { forms } = await analyzeForms('jha', (m) => console.log(m));
  const rebuilt: { form: FormRecord; result: FormResult }[] = [];

  console.log('\nPosting forms to the bridge');
  for (const form of forms.filter((f) => f.kind === 'form')) {
    const result = await wp.post<FormResult>('/website-mover/v1/forms', {
      source_key: form.key,
      title: form.title,
      description: form.description ?? '',
      fields: form.fields,
      sensitive_fields: form.sensitive,
      ...(form.sensitive.length ? { retention_days: RETENTION_DAYS } : {}),
    });
    console.log(`  ${form.key} → form ${result.id} (${result.created ? 'created' : 'updated'}), retention ${JSON.stringify(result.retention)}`);
    rebuilt.push({ form, result });
  }

  console.log('\nRendering (throwaway page)');
  const content = rebuilt.map(({ result }) => `<!-- wp:${result.block.name} ${JSON.stringify(result.block.attrs)} /-->`).join('\n\n');
  const page = await wp.post<Page>('/wp/v2/pages', { title: 'WM forms check (temporary)', slug: 'wm-forms-check', status: 'publish', content });
  try {
    const $ = cheerio.load(await (await fetch(page.link)).text());
    for (const { form, result } of rebuilt) {
      const wrapper = $(`#gform_wrapper_${result.id}`);
      const rendered = wrapper.find('.gfield').length;
      check(wrapper.length === 1 && rendered === form.fields.length, `${form.title}: renders ${rendered}/${form.fields.length} fields`);
      const labels = wrapper.find('.gfield_label, legend.gfield_label').map((_, l) => $(l).text()).get().join('\n');
      const missing = form.fields.filter((f) => f.type !== 'html' && f.type !== 'section' && !labels.includes(f.label));
      check(!missing.length, `${form.title}: every label shown${missing.length ? ` (missing: ${missing.map((f) => f.label).join('; ')})` : ''}`);
    }
  } finally {
    await wp.delete(`/wp/v2/pages/${page.id}`, { force: 'true' });
    console.log(`  deleted page ${page.id}`);
  }

  console.log('\nRead back (WP-CLI)');
  for (const { form, result } of rebuilt) {
    const saved = readBack(result.id);
    if (!form.sensitive.length) {
      check(saved.template.includes('{all_fields}') && saved.retention?.policy !== 'delete', `${form.title}: full notification, entries kept`);
      continue;
    }
    check(result.sensitive_field_ids.length === form.sensitive.length, `${form.title}: ${form.sensitive.length} sensitive fields matched (ids ${result.sensitive_field_ids.join(', ')})`);
    check(!saved.template.includes('{all_fields}'), `${form.title}: notification doesn't use {all_fields}`);
    const leaked = result.sensitive_field_ids.filter((id) => saved.message.includes(`wmcheck-${id}-`));
    check(!leaked.length, `${form.title}: notification leaves out the sensitive values${leaked.length ? ` (leaked: ${leaked.join(', ')})` : ''}`);
    const shown = saved.textFieldIds.filter((id) => !result.sensitive_field_ids.includes(id));
    const absent = shown.filter((id) => !saved.message.includes(`wmcheck-${id}-`));
    check(!absent.length, `${form.title}: notification shows the other ${shown.length} text values${absent.length ? ` (missing: ${absent.join(', ')})` : ''}`);
    check(saved.retention?.policy === 'delete' && Number(saved.retention.retain_entries_days) === RETENTION_DAYS, `${form.title}: entries deleted after ${RETENTION_DAYS} days (${JSON.stringify(saved.retention)})`);
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nAll checks passed');
  }
}

/**
 * The saved form, and its admin notification rendered for a made-up entry in which every text-like
 * field holds "wmcheck-<id>-" (nothing is submitted or sent).
 */
function readBack(formId: number): { template: string; message: string; retention: { policy?: string; retain_entries_days?: number | string } | null; textFieldIds: number[] } {
  const php = `
    $form  = GFAPI::get_form( ${formId} );
    $entry = array( 'id' => 0, 'form_id' => $form['id'], 'date_created' => gmdate( 'Y-m-d H:i:s' ) );
    $text  = array();
    foreach ( $form['fields'] as $f ) {
      if ( in_array( $f->type, array( 'text', 'textarea', 'email', 'number', 'phone', 'website', 'date' ), true ) ) {
        $entry[ (string) $f->id ] = 'date' === $f->type ? '2026-01-0' . ( $f->id % 9 + 1 ) : 'wmcheck-' . $f->id . '-';
        if ( 'date' !== $f->type ) { $text[] = (int) $f->id; }
      }
    }
    $n = $form['notifications']['wm-admin'];
    echo wp_json_encode( array(
      'template'     => $n['message'],
      'message'      => GFCommon::replace_variables( $n['message'], $form, $entry, false, false, true, 'html' ),
      'retention'    => $form['personalData']['retention'] ?? null,
      'textFieldIds' => $text,
    ) );`;
  const out = execFileSync('docker', ['compose', '-f', 'e2e/seed/compose.yaml', 'run', '--rm', '-T', 'cli', 'wp', 'eval', php], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out.slice(out.indexOf('{')));
}

await main();
