import * as cheerio from 'cheerio';
import type { FormField } from '@wm/core';
import { readBracketed, readJsString } from './script.js';
import { clean } from './rules.js';

/**
 * jQuery formBuilder forms (https://formbuilder.online): the page holds an empty container and an
 * inline script `$('#rendered-content').formRender({ formData: '[…JSON…]' })` that draws the
 * fields in the browser. The JSON is the form's definition.
 */
export interface FormBuilderDefinition {
  /** CSS selector of the container formRender draws into ("#rendered-content"). */
  target: string | null;
  /** The parsed field list, or null when the definition couldn't be read (see `error`). */
  items: FormBuilderItem[] | null;
  error?: string;
}

export interface FormBuilderItem {
  type: string;
  subtype?: string;
  label?: string;
  name?: string;
  required?: boolean | string;
  placeholder?: string;
  description?: string;
  multiple?: boolean | string;
  other?: boolean | string;
  values?: { label?: string; value?: string; selected?: boolean | string }[];
}

const CALL = /(?:\$|jQuery)\(\s*(['"])(.+?)\1\s*\)\s*\.\s*formRender\s*\(/g;
const DATA = /['"]?formData['"]?\s*[:=]\s*/g;

/** Every formRender call in the page's inline scripts, with its definition. */
export function findFormBuilderDefinitions(scripts: string[]): FormBuilderDefinition[] {
  const all = scripts.join('\n;\n');
  if (!/\.formRender\s*\(/.test(all)) return [];
  const literals = dataLiterals(all);
  const defs: FormBuilderDefinition[] = [];
  for (const call of all.matchAll(CALL)) {
    // The definition passed to this call: the first formData literal after it, else any literal
    // (`formRender({ formData })` with the data in a variable).
    const literal = literals.find((l) => l.at > call.index) ?? literals[0];
    defs.push({ target: call[2]!, ...parse(literal?.text) });
  }
  if (!defs.length) defs.push({ target: null, ...parse(literals[0]?.text) });
  return defs;
}

function dataLiterals(src: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  for (const m of src.matchAll(DATA)) {
    const start = m.index + m[0].length;
    const str = readJsString(src, start);
    if (str) out.push({ at: start, text: str.value });
    else {
      const bracketed = readBracketed(src, start);
      if (bracketed) out.push({ at: start, text: bracketed });
    }
  }
  return out;
}

function parse(text: string | undefined): { items: FormBuilderItem[] | null; error?: string } {
  if (!text) return { items: null, error: 'no formData literal found' };
  if (/^\s*</.test(text)) return { items: null, error: 'formData is XML (old formBuilder format), not read' };
  try {
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data) || !data.every((d) => d && typeof d === 'object' && typeof (d as FormBuilderItem).type === 'string')) {
      return { items: null, error: 'formData is not a list of fields' };
    }
    return { items: data as FormBuilderItem[] };
  } catch (err) {
    return { items: null, error: `formData is not JSON (${(err as Error).message})` };
  }
}

const truthy = (v: unknown) => v === true || v === 'true';

/** Visible text of a formBuilder label (labels may hold markup and entities). */
function text(label: string | undefined): string {
  return clean(cheerio.load(`<div>${label ?? ''}</div>`, null, false).root().text());
}

const BLOCK = /<(hr|p|div|ul|ol|table|h[1-6]|blockquote|br)\b/i;

/**
 * Maps a formBuilder definition to plugin-neutral fields. Things the spec can't express (an "Other"
 * choice with free text, multiple files, a preselected choice) become warnings.
 */
export function formBuilderFields(items: FormBuilderItem[]): { fields: FormField[]; warnings: string[] } {
  const fields: FormField[] = [];
  const warnings: string[] = [];
  for (const item of items) {
    const label = text(item.label);
    const required = truthy(item.required);
    const base = {
      label,
      required,
      ...(item.placeholder ? { placeholder: clean(item.placeholder) } : {}),
      ...(item.description ? { description: clean(item.description) } : {}),
    };
    const choices = (item.values ?? []).map((v) => text(v.label ?? v.value));
    const selected = (item.values ?? []).filter((v) => truthy(v.selected)).map((v) => text(v.label ?? v.value));
    const preselected = () => {
      if (selected.length) warnings.push(`preselected-choice: "${label}" has ${selected.map((s) => `"${s}"`).join(', ')} selected by default on the source`);
    };
    const other = () => {
      if (truthy(item.other)) warnings.push(`other-choice: "${label}" offers an "Other" choice with a text box on the source; not in the spec`);
    };

    switch (item.type) {
      case 'header':
        fields.push({ label, type: 'section', required: false, content: label });
        break;
      case 'paragraph': {
        const raw = (item.label ?? '').trim();
        const tag = /^[a-z][a-z0-9]*$/i.test(item.subtype ?? '') ? item.subtype! : 'p';
        fields.push({ label: '', type: 'html', required: false, content: BLOCK.test(raw) ? raw : `<${tag}>${raw}</${tag}>` });
        break;
      }
      case 'text': {
        const sub = (item.subtype ?? 'text').toLowerCase();
        const type: FormField['type'] = sub === 'email' ? 'email' : sub === 'tel' ? 'phone' : 'text';
        if (sub === 'password') warnings.push(`password-field: "${label}"`);
        fields.push({ ...base, type });
        break;
      }
      case 'textarea':
        fields.push({ ...base, type: 'textarea' });
        break;
      case 'number':
        fields.push({ ...base, type: 'number' });
        break;
      case 'date':
        fields.push({ ...base, type: 'date' });
        break;
      case 'select':
      case 'autocomplete':
        if (truthy(item.multiple)) warnings.push(`multi-select: "${label}" allows several choices on the source; rebuilt as a single select`);
        if (item.type === 'autocomplete') warnings.push(`autocomplete: "${label}" is a type-ahead list on the source; rebuilt as a select`);
        preselected();
        fields.push({ ...base, type: 'select', choices });
        break;
      case 'radio-group':
        preselected();
        other();
        fields.push({ ...base, type: 'radio', choices });
        break;
      case 'checkbox-group':
      case 'checkbox':
        preselected();
        other();
        fields.push({ ...base, type: 'checkbox', choices: choices.length ? choices : [label] });
        break;
      case 'file':
        if (truthy(item.multiple)) warnings.push(`multiple-files: "${label}" accepts several files at once on the source`);
        fields.push({ ...base, type: 'file' });
        break;
      case 'hidden':
        warnings.push(`hidden-field: "${clean(item.name)}" not rebuilt (no visible label)`);
        break;
      case 'button':
        break;
      default:
        warnings.push(`unsupported-field: formBuilder type "${item.type}" ("${label}") not rebuilt`);
    }
  }
  return { fields, warnings };
}
