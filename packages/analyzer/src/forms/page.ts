import type { Cheerio, CheerioAPI } from 'cheerio';
import type { FormField, FormRecord } from '@wm/core';
import { findFormBuilderDefinitions, formBuilderFields } from './formbuilder.js';
import { fragmentFields, walkForm, type AnyNode, type Element } from './native.js';
import { clean, formKind, SEARCH_RE, sensitiveReason, splitRequired } from './rules.js';
import { jsStrings } from './script.js';

/** A form found on a page, before the cross-page chrome check. */
export interface PageForm {
  record: FormRecord;
  /** Same action and control names on many pages means site chrome (a sidebar or footer form). */
  signature: string;
}

const CHROME = 'header, footer, nav, aside, [role="banner"], [role="contentinfo"], [role="navigation"], [role="search"], [role="complementary"]';
const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'title', 'target', 'rel', 'colspan', 'rowspan', 'scope']);

/**
 * Forms on one page, in document order, minus site chrome (search, anything in header/footer/nav).
 * `page.title` (the extracted title) names a form that has no heading of its own.
 */
export function readPageForms($: CheerioAPI, page: { url: URL; key: string; title: string }): PageForm[] {
  const scripts = $('script:not([src])').map((_, s) => $(s).html() ?? '').get();
  const uiControls = clickBoundSelector($, scripts);
  const defs = findFormBuilderDefinitions(scripts);
  const injected = injectedFields(scripts, (el) => cleanHtml($, el, page.url));
  const allowedTypes = allowedFileTypes(scripts);

  // formBuilder containers that aren't inside a <form> are forms of their own.
  const targetOf = (def: { target: string | null }): Cheerio<Element> | null => {
    const target = def.target ? ($(def.target).first() as Cheerio<Element>) : null;
    return target?.length ? target : null;
  };
  const roots = $('form').toArray();
  for (const def of defs) {
    const target = targetOf(def);
    if (target && !target.closest('form').length) roots.push(target.get(0)!);
  }

  const out: PageForm[] = [];
  for (const root of roots) {
    const form = $(root);
    if (isChrome($, form)) continue;
    const warnings: string[] = [];
    let implementation = 'native';
    const fbFields = new Map<AnyNode, FormField[]>();
    for (const def of defs) {
      const target = targetOf(def);
      if (!target || !(target.is(form) || form.find(target).length)) continue;
      implementation = 'formbuilder';
      if (!def.items) {
        warnings.push(`formbuilder-unread: ${def.error}`);
        continue;
      }
      const mapped = formBuilderFields(def.items);
      warnings.push(...mapped.warnings);
      fbFields.set(target.get(0)!, mapped.fields);
    }
    const injectedHere = new Map<AnyNode, FormField[]>();
    for (const inj of injected) {
      const target = form.find(`[id="${inj.containerId}"]`).first();
      if (!target.length) continue;
      const controller = inj.controllerId ? form.find(`[id="${inj.controllerId}"]`).first() : $();
      const controllerLabel = controller.length ? splitRequired(form.find('label').filter((_, l) => $(l).attr('for') === inj.controllerId).text()).label : '';
      const option = inj.when && controller.length ? clean(controller.find('option').filter((_, o) => $(o).attr('value') === inj.when).text()) : '';
      const fields = inj.fields.map((f) => {
        if (f.type === 'html' || f.type === 'section') return f;
        const condition = option ? `shown when "${controllerLabel}" is "${option}"` : 'shown by a script';
        warnings.push(`conditional-field: "${f.label}" is ${condition}${f.required ? ' and required then' : ''}; rebuilt as an optional, always-visible field (add conditional logic in the forms plugin)`);
        return { ...f, required: false };
      });
      const node = target.get(0)!;
      injectedHere.set(node, [...(injectedHere.get(node) ?? []), ...fields]);
    }

    for (const def of defs.filter((d) => !targetOf(d))) {
      warnings.push(`formbuilder-unplaced: the page has a formBuilder definition (${def.items?.length ?? 0} fields) whose container wasn't found${def.target ? ` (${def.target})` : ''}; not read into this form`);
    }

    const walked = walkForm($, form, {
      fieldsFor: (el) => fbFields.get(el) ?? injectedHere.get(el),
      uiControls,
      html: (el) => cleanHtml($, el, page.url),
    });
    warnings.push(...walked.warnings);

    const fields = walked.fields;
    if (fields.filter((f) => f.type === 'email').length > 1) {
      for (const f of fields.filter((f) => f.type === 'email' && /confirm/i.test(f.label))) {
        warnings.push(`email-confirmation: "${f.label}" is a second email box on the source; the forms plugin's own email confirmation option can replace it`);
      }
    }
    const sensitive: string[] = [];
    for (const f of fields) {
      const reason = sensitiveReason(f);
      if (!reason) continue;
      sensitive.push(f.label);
      // The forms plugin reformats number boxes (leading zeros, thousands separators): account
      // and id numbers are rebuilt as text.
      if (f.type === 'number') {
        f.type = 'text';
        warnings.push(`number-as-text: "${f.label}" is a number box on the source; rebuilt as text so leading zeros survive`);
      }
    }
    if (sensitive.length) warnings.push(`sensitive: collects ${[...new Set(fields.map(sensitiveReason).filter(Boolean))].join(', ')} (${sensitive.map((s) => `"${s}"`).join(', ')}); needs the client's sign-off`);
    const captcha = walked.recaptcha || form.find('.g-recaptcha, .h-captcha, [data-sitekey]').length > 0;
    const uploads = fields.some((f) => f.type === 'file');
    if (uploads && allowedTypes.length) warnings.push(`file-types: the source accepts only ${allowedTypes.join(', ')} uploads (checked by script)`);
    if (!fields.some((f) => f.type !== 'html' && f.type !== 'section')) {
      const links = form.find('a[href]').map((_, a) => clean($(a).attr('href'))).get();
      warnings.push(`no-fields: the source form has no input fields${links.length ? ` (it links to ${links.join(', ')})` : ''}`);
    }

    const title = walked.title ?? precedingHeading($, form) ?? page.title;
    const attrs = ['id', 'class', 'name', 'action'].map((a) => form.attr(a) ?? '').join(' ');
    const kind = formKind({ hasPassword: form.find('input[type="password"]').length > 0, attrs, title });
    if (kind === 'subscription') warnings.push('subscription: an alerts/newsletter sign-up kept by a service on the source; not rebuilt (pick a service for the new site)');
    if (kind === 'login') warnings.push('login: never migrated');

    out.push({
      record: {
        key: `${page.key}#form-${out.length + 1}`, // renumbered once chrome is dropped
        pageKey: page.key,
        kind,
        title,
        description: walked.description,
        fields,
        sensitive,
        uploads,
        captcha,
        implementation,
        warnings,
      },
      signature: `${new URL(form.attr('action') ?? '', page.url).pathname}|${form.find('input, select, textarea').map((_, c) => `${$(c).attr('type') ?? c.name}:${$(c).attr('name') ?? ''}`).get().join(',')}`,
    });
  }
  return out;
}

/** Search boxes and anything in the header, footer or navigation. */
function isChrome($: CheerioAPI, form: Cheerio<Element>): boolean {
  if (form.closest(CHROME).length || form.is('[role="search"]')) return true;
  if (form.find('input[type="search"]').length) return true;
  const attrs = ['id', 'class', 'name', 'action'].map((a) => form.attr(a) ?? '').join(' ');
  if (SEARCH_RE.test(attrs)) return true;
  const inputs = form.find('input, select, textarea').filter((_, i) => !['hidden', 'submit', 'button', 'image'].includes(($(i).attr('type') ?? '').toLowerCase()));
  return inputs.length === 1 && /^(q|s|search|query|keywords?|term|search_?term)$/i.test(inputs.attr('name') ?? '');
}

/** The last heading before the form within the main content. */
function precedingHeading($: CheerioAPI, form: Cheerio<Element>): string | null {
  const scope = form.closest('main').length ? form.closest('main') : $('body');
  const nodes = scope.find('*').toArray();
  const at = nodes.indexOf(form.get(0)!);
  for (let i = at - 1; i >= 0; i--) {
    const el = $(nodes[i]!);
    if (el.is('h1, h2, h3, h4, h5, h6') && !el.closest(CHROME).length && clean(el.text())) return clean(el.text());
  }
  return null;
}

/** Elements scripts bind click handlers to (by id), plus inline onclick: UI, not content. */
function clickBoundSelector($: CheerioAPI, scripts: string[]): string {
  const ids = new Set<string>();
  const re = /\$\(\s*(['"])#([\w-]+)\1\s*\)\s*\.\s*(click|on\s*\(\s*['"]click|bind\s*\(\s*['"]click)|getElementById\(\s*(['"])([\w-]+)\4\s*\)\s*\.\s*(addEventListener\s*\(\s*['"]click|onclick)/g;
  for (const script of scripts) for (const m of script.matchAll(re)) ids.add(m[2] ?? m[5]!);
  return ['[onclick]', ...[...ids].filter((id) => $(`[id="${id}"]`).length).map((id) => `[id="${id}"]`)].join(', ');
}

interface InjectedFields {
  containerId: string;
  controllerId: string | null;
  /** The controller value (a `case` label) that shows these fields. */
  when: string | null;
  fields: FormField[];
}

/**
 * Fields a script writes into the form, e.g. `case 'report_fraud': html = '<label…><textarea…>';
 * $('#formType').html(html);`: the markup string, the container it lands in, and the select whose
 * value picks it.
 */
function injectedFields(scripts: string[], html: (el: Cheerio<AnyNode>) => string): InjectedFields[] {
  const out: InjectedFields[] = [];
  for (const script of scripts) {
    if (/\.formRender\s*\(/.test(script)) continue;
    const strings = jsStrings(script).filter((s) => /<(textarea|input|select)\b/i.test(s.value));
    for (const [i, s] of strings.entries()) {
      const before = script.slice(i ? strings[i - 1]!.end : 0, s.start);
      const after = script.slice(s.end, strings[i + 1]?.start ?? script.length);
      const container = after.match(/\$\(\s*(['"])#([\w-]+)\1\s*\)\s*\.\s*(html|append|prepend)\s*\(/);
      if (!container) continue;
      const when = [...before.matchAll(/case\s+(['"])(.*?)\1\s*:/g)].pop()?.[2] ?? null;
      const controller = [...script.slice(0, s.start).matchAll(/switch\s*\(\s*\$\(\s*(['"])#([\w-]+)\1\s*\)\s*\.\s*val\(\)\s*\)/g)].pop()?.[2] ?? null;
      const fields = fragmentFields(s.value, { html }).fields.filter((f) => f.type !== 'html');
      if (fields.length) out.push({ containerId: container[2]!, controllerId: controller, when, fields });
    }
  }
  return out;
}

/** File extensions an upload check script allows (`allowed_array = ['pdf','jpg']`). */
function allowedFileTypes(scripts: string[]): string[] {
  for (const script of scripts) {
    const m = script.match(/allowed\w*\s*=\s*\[([^\]]*)\]/i);
    if (m) return [...m[1]!.matchAll(/['"]([\w.]+)['"]/g)].map((x) => x[1]!.replace(/^\./, '').toLowerCase());
  }
  return [];
}

/** Outer HTML for an html field: absolute URLs, only meaningful attributes, no scripts. */
function cleanHtml($: CheerioAPI, el: Cheerio<AnyNode>, base: URL): string {
  const copy = el.clone();
  copy.add(copy.find('*')).contents().filter((_, n) => String(n.type) === 'comment').remove();
  const nodes = [...copy.toArray(), ...copy.find('*').toArray()];
  for (const node of nodes) {
    if (node.type !== 'tag') continue;
    const attribs = (node as unknown as { attribs: Record<string, string> }).attribs;
    for (const name of Object.keys(attribs)) {
      if (!KEEP_ATTRS.has(name)) delete attribs[name];
      else if ((name === 'href' || name === 'src') && !/^(mailto|tel|#)/i.test(attribs[name]!)) {
        try {
          attribs[name] = new URL(attribs[name]!, base).href;
        } catch {
          // keep as written
        }
      }
    }
  }
  return copy
    .toArray()
    .filter((n) => String(n.type) !== 'comment')
    .map((n) => $.html(n))
    .join('')
    .replace(/[ \t\u00a0]*\n\s*/g, '\n')
    .replace(/[ \t]{2,}|\t/g, ' ')
    .trim();
}
