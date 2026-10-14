import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI, load } from 'cheerio';
import type { FormField } from '@wm/core';
import { clean, isPlaceholderOption, isRequiredNote, splitRequired } from './rules.js';

/** A DOM node (cheerio doesn't re-export domhandler's types). */
export type AnyNode = Exclude<Parameters<typeof load>[0], string | Buffer | unknown[]>;
export type Element = Extract<AnyNode, { attribs: unknown }>;
type Text = Extract<AnyNode, { data: string }>;

const isTag = (n: AnyNode): n is Element => 'attribs' in n;
const isText = (n: AnyNode): n is Text => String(n.type) === 'text';

const CONTROLS = 'input, select, textarea';
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'button', 'link', 'meta']);
const INLINE = new Set(['a', 'span', 'strong', 'b', 'em', 'i', 'u', 'small', 'sup', 'sub', 'abbr', 'code', 'br', 'img', 'mark', 'font']);
const NON_FIELD_INPUTS = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/** Hooks for the parts of a form that aren't plain DOM. */
export interface WalkHooks {
  /** Fields that a script draws into this element (formBuilder container, injected markup), if any. */
  fieldsFor(el: AnyNode): FormField[] | undefined;
  /** Selector of elements bound to click handlers (UI toggles such as "Directions"): not content. */
  uiControls: string;
  /** Markup for an html field (absolute URLs, presentational attributes dropped). */
  html(el: Cheerio<AnyNode>): string;
}

/** Never content of the rebuilt form. */
const NOT_CONTENT = 'script, style, noscript, template, button, [hidden], .hide, .hidden, .sr-only, .visually-hidden, .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]';

export interface WalkResult {
  fields: FormField[];
  /** Text-only blocks before the first field (a note under the heading). */
  description: string | null;
  /** The heading inside the form used as its title (legend heading or first heading). */
  title: string | null;
  recaptcha: boolean;
  warnings: string[];
}

/**
 * Reads a native <form> in document order: controls become fields, radio/checkbox inputs sharing
 * a name become one choice field, headings become sections and other text becomes html fields.
 * Labels and choices are the source's own text; a trailing "*" is read as "required".
 */
export function walkForm($: CheerioAPI, form: Cheerio<AnyNode>, hooks: WalkHooks): WalkResult {
  const fields: FormField[] = [];
  const warnings: string[] = [];
  const consumed = new Set<AnyNode>();
  const descriptionParts: string[] = [];
  let recaptcha = false;

  const titleEl = titleHeading($, form);
  const title = titleEl ? clean($(titleEl).text()) : null;
  if (titleEl) consumed.add(titleEl);

  const removable = hooks.uiControls ? `${NOT_CONTENT}, ${hooks.uiControls}` : NOT_CONTENT;
  let run: AnyNode[] = [];
  const flush = () => {
    const nodes = run;
    run = [];
    const wrap = $('<div></div>');
    for (const n of nodes) wrap.append($(n).clone());
    pushText(wrap, true);
  };

  /** Text content: a note before any field goes to the description, anything else is an html field. */
  const pushText = (source: Cheerio<AnyNode>, inner: boolean) => {
    const el = source.clone();
    if (el.find('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]').length) recaptcha = true;
    el.find(removable).remove();
    const text = clean(el.text());
    if (!text || isRequiredNote(text)) return;
    if (!fields.length && !el.find('a, img, ul, ol, table').length && !el.is('a, img, ul, ol, table')) {
      descriptionParts.push(text);
      return;
    }
    const content = inner ? el.contents().toArray().map((n) => hooks.html($(n))).join('') : hooks.html(el);
    fields.push({ label: '', type: 'html', required: false, content: content.trim() });
  };

  const visit = (node: AnyNode) => {
    if (consumed.has(node)) return;
    if (isText(node)) {
      run.push(node);
      return;
    }
    if (!isTag(node)) return;
    const el = $(node);
    const name = node.name.toLowerCase();
    if (SKIP.has(name)) return;
    if (isHidden(el)) return;
    if (isCaptcha(el)) {
      recaptcha = true;
      return;
    }
    if (hooks.uiControls && el.is(hooks.uiControls)) return;
    const hasControls = el.is(CONTROLS) || el.find(CONTROLS).length > 0;
    const scripted = hooks.fieldsFor(node);
    if (INLINE.has(name) && !hasControls && !scripted) {
      run.push(node);
      return;
    }
    flush();

    if (scripted) {
      fields.push(...scripted);
      return;
    }
    if (name === 'fieldset' && choiceGroupFieldset($, el)) {
      emitGroup(el.find('input[type="radio"], input[type="checkbox"]').first());
      return;
    }
    if (name === 'legend') {
      if (titleEl && el.find(titleEl).length) return;
      const text = splitRequired(el.text()).label;
      if (text) fields.push({ label: text, type: 'section', required: false, content: text });
      return;
    }
    if (el.is(CONTROLS)) {
      emitControl(el);
      return;
    }
    if (name === 'label') {
      // Labels are read by their controls (wrapped or pointed at with `for`).
      if (hasControls) el.find(CONTROLS).each((_, c) => visit(c));
      return;
    }
    if (/^h[1-6]$/.test(name)) {
      const text = clean(el.text());
      if (!text) return;
      if (!fields.length && !el.find('a').length) descriptionParts.push(text);
      else fields.push({ label: text, type: 'section', required: false, content: text });
      return;
    }
    // Blocks holding controls, script-drawn fields or the title are read piece by piece.
    const holdsScripted = el.find('*').toArray().some((d) => hooks.fieldsFor(d));
    if (hasControls || holdsScripted || (titleEl && el.find(titleEl).length)) {
      node.children.forEach(visit);
      flush();
      return;
    }
    pushText(el, false);
  };

  const emitControl = (el: Cheerio<Element>) => {
    const node = el.get(0)!;
    consumed.add(node);
    const tag = node.name.toLowerCase();
    const inputType = (el.attr('type') ?? 'text').toLowerCase();
    if (tag === 'input' && NON_FIELD_INPUTS.has(inputType)) return;
    if (tag === 'input' && (inputType === 'radio' || inputType === 'checkbox')) {
      emitGroup(el);
      return;
    }
    const { label, marked } = labelFor($, form, el);
    const required = marked || isRequired(el);
    const placeholder = clean(el.attr('placeholder'));
    const extra = placeholder ? { placeholder } : {};
    if (tag === 'select') {
      const options = el.find('option').toArray();
      const choices: string[] = [];
      let selectPlaceholder: string | undefined;
      options.forEach((o, i) => {
        const text = clean($(o).text());
        if (isPlaceholderOption(text, $(o).attr('value'), i === 0)) selectPlaceholder = text || undefined;
        else choices.push(text || clean($(o).attr('value')));
      });
      if (el.attr('multiple') !== undefined) warnings.push(`multi-select: "${label}" allows several choices on the source; rebuilt as a single select`);
      if (el.find('optgroup').length) warnings.push(`option-groups: "${label}" groups its options on the source; rebuilt as one flat list`);
      fields.push({ label, type: 'select', required, choices, ...(selectPlaceholder ? { placeholder: selectPlaceholder } : {}) });
      return;
    }
    if (tag === 'textarea') {
      fields.push({ label, type: 'textarea', required, ...extra });
      return;
    }
    const type = INPUT_TYPES[inputType];
    if (!type) warnings.push(`input-type: "${label}" is a ${inputType} input on the source; rebuilt as text`);
    if (inputType === 'password') warnings.push(`password-field: "${label}"`);
    fields.push({ label, type: type ?? 'text', required, ...extra });
  };

  const emitGroup = (first: Cheerio<Element>) => {
    const inputName = first.attr('name');
    const type = (first.attr('type') ?? '').toLowerCase() === 'radio' ? 'radio' : 'checkbox';
    const inputs = inputName
      ? form.find(`input[type="${type}"]`).filter((_, i) => $(i).attr('name') === inputName)
      : first;
    inputs.each((_, i) => void consumed.add(i));
    const choices = inputs.toArray().map((i) => choiceLabel($, form, $(i)));
    // A lone checkbox ("I agree …") is labeled by its own text.
    const groupLabel = inputs.length > 1 ? groupLabelFor($, form, inputs) : null;
    const label = groupLabel ? splitRequired(groupLabel.text) : { label: choices.length === 1 ? choices[0]! : clean(inputName), marked: false };
    if (!groupLabel && choices.length > 1) warnings.push(`unlabeled-group: no label found for the "${inputName}" choices; using its input name`);
    const required = label.marked || inputs.toArray().some((i) => isRequired($(i))) || Boolean(groupLabel?.marked);
    fields.push({ label: label.label, type, required, choices });
  };

  form.contents().each((_, n) => visit(n));
  flush();

  return { fields, description: descriptionParts.length ? descriptionParts.join('\n') : null, title, recaptcha, warnings };
}

const INPUT_TYPES: Record<string, FormField['type']> = {
  text: 'text',
  search: 'text',
  email: 'email',
  tel: 'phone',
  number: 'number',
  range: 'number',
  date: 'date',
  url: 'url',
  file: 'file',
};

function isHidden(el: Cheerio<AnyNode>): boolean {
  const style = (el.attr('style') ?? '').replace(/\s+/g, '').toLowerCase();
  return el.attr('hidden') !== undefined || style.includes('display:none') || /(^|\s)(hide|hidden|sr-only|visually-hidden)(\s|$)/.test(el.attr('class') ?? '');
}

function isCaptcha(el: Cheerio<AnyNode>): boolean {
  return el.is('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], #g-recaptcha') || /recaptcha/i.test(el.attr('id') ?? '');
}

function isRequired(el: Cheerio<AnyNode>): boolean {
  return el.attr('required') !== undefined || el.attr('aria-required') === 'true' || /(^|\s)required(\s|$)/.test(el.attr('class') ?? '');
}

/** The heading that titles the form: inside its outer legend, or the first heading before any control. */
function titleHeading($: CheerioAPI, form: Cheerio<AnyNode>): Element | null {
  const legendHeading = form.find('fieldset').first().children('legend').first().find('h1, h2, h3, h4, h5, h6').first();
  if (legendHeading.length) return legendHeading.get(0)!;
  const all = form.find(`h1, h2, h3, h4, h5, h6, ${CONTROLS}`).toArray();
  const first = all[0];
  return first && /^h[1-6]$/i.test(first.name) ? first : null;
}

/** Visible text of a label without the text of controls (and options) nested in it. */
function labelText($: CheerioAPI, label: Cheerio<AnyNode>): string {
  const copy = label.clone();
  copy.find(`${CONTROLS}, option, script, style`).remove();
  copy.find('.hide, .hidden, .sr-only').remove();
  return copy.text();
}

function labelFor($: CheerioAPI, form: Cheerio<AnyNode>, el: Cheerio<AnyNode>): { label: string; marked: boolean } {
  const id = el.attr('id');
  const candidates: (string | undefined)[] = [];
  if (id) {
    const byFor = form.find('label').filter((_, l) => $(l).attr('for') === id).first();
    if (byFor.length) candidates.push(labelText($, byFor));
  }
  const wrapping = el.closest('label');
  if (wrapping.length) candidates.push(labelText($, wrapping));
  candidates.push(el.attr('aria-label'));
  const labelledBy = el.attr('aria-labelledby');
  if (labelledBy) candidates.push(labelledBy.split(/\s+/).map((ref) => form.find(`[id="${ref}"]`).text()).join(' '));
  candidates.push(el.attr('placeholder'), el.attr('title'));
  for (const c of candidates) {
    const split = splitRequired(c ?? '');
    if (split.label) return split;
  }
  return { label: clean(el.attr('name')), marked: false };
}

/** A choice's text: its label, the text right after the input, or its value. */
function choiceLabel($: CheerioAPI, form: Cheerio<AnyNode>, input: Cheerio<AnyNode>): string {
  const id = input.attr('id');
  if (id) {
    const byFor = form.find('label').filter((_, l) => $(l).attr('for') === id).first();
    const text = byFor.length ? clean(labelText($, byFor)) : '';
    if (text) return text;
  }
  const wrapping = input.closest('label');
  if (wrapping.length) {
    const text = clean(labelText($, wrapping));
    if (text) return text;
  }
  let next = input.get(0)!.next;
  let text = '';
  while (next && !(isTag(next) && $(next).is(`${CONTROLS}, br, div, p, li, label`))) {
    text += isText(next) ? next.data : $(next).text();
    next = next.next;
  }
  return clean(text) || clean(input.attr('value'));
}

/** True when the fieldset's inputs are exactly one radio/checkbox group (its legend is the group label). */
function choiceGroupFieldset($: CheerioAPI, fieldset: Cheerio<AnyNode>): boolean {
  if (!fieldset.children('legend').length) return false;
  const inputs = fieldset.find(CONTROLS).filter((_, i) => !NON_FIELD_INPUTS.has(($(i).attr('type') ?? '').toLowerCase()));
  if (!inputs.length) return false;
  const names = new Set(inputs.toArray().map((i) => `${$(i).attr('type')}:${$(i).attr('name')}`));
  return names.size === 1 && inputs.is('input[type="radio"], input[type="checkbox"]');
}

/** The label of a radio/checkbox group: legend, aria label, or the text just before the group. */
function groupLabelFor($: CheerioAPI, form: Cheerio<AnyNode>, inputs: Cheerio<Element>): { text: string; marked: boolean } | null {
  const marked = (el: Cheerio<AnyNode>) => el.find('.requiredRed, .required, .req').filter((_, r) => clean($(r).text()) === '*').length > 0;
  const fieldset = inputs.first().closest('fieldset');
  if (fieldset.length && choiceGroupFieldset($, fieldset)) {
    const legend = fieldset.children('legend').first();
    if (clean(legend.text())) return { text: legend.text(), marked: marked(legend) };
  }
  const group = inputs.first().closest('[role="radiogroup"], [role="group"]');
  if (group.length && group.attr('aria-label')) return { text: group.attr('aria-label')!, marked: false };
  if (group.length && group.attr('aria-labelledby')) {
    return { text: group.attr('aria-labelledby')!.split(/\s+/).map((ref) => form.find(`[id="${ref}"]`).text()).join(' '), marked: false };
  }
  // The smallest ancestor holding the whole group; its nearest preceding text (a label not tied to
  // another control, a heading or a short paragraph) names the group.
  let container = inputs.first().parent();
  while (container.length && container.find(inputs).length < inputs.length) container = container.parent();
  for (let at: Cheerio<AnyNode> = container; at.length && !at.is('form'); at = at.parent()) {
    const prev = at.prevAll().filter((_, p) => !$(p).is(`${CONTROLS}, script, style, br`) && !$(p).find(CONTROLS).length && clean($(p).text()) !== '').first();
    if (prev.length) {
      const forId = prev.is('label') ? prev.attr('for') : undefined;
      if (forId && form.find(`[id="${forId}"]`).length && !inputs.filter((_, i) => $(i).attr('id') === forId).length) return null;
      return { text: prev.text(), marked: marked(prev) };
    }
  }
  return null;
}

/** Parses an HTML fragment (e.g. markup a script injects) and reads its controls. */
export function fragmentFields(html: string, hooks: Pick<WalkHooks, 'html'>): WalkResult {
  const $ = cheerio.load(`<form>${html}</form>`, null, false);
  return walkForm($, $('form').first(), { fieldsFor: () => undefined, uiControls: '', html: hooks.html });
}
