import type { FormField, FormRecord } from '@wm/core';

/** Trimmed, whitespace collapsed (non-breaking spaces included). */
export function clean(text: string | undefined | null): string {
  return (text ?? '').replace(/[\s ]+/g, ' ').trim();
}

/** A label's trailing required marker ("Email*", "Email *", "Email (required)"). */
const REQUIRED_MARK = /\s*(\*|\(required\))\s*:?\s*$/i;

/** Splits a source label into its text and whether it carried a required marker. */
export function splitRequired(label: string): { label: string; marked: boolean } {
  const text = clean(label);
  const stripped = text.replace(REQUIRED_MARK, '');
  return stripped !== text && stripped ? { label: stripped, marked: true } : { label: text, marked: false };
}

/** Notes like "*Required Fields" or "* indicates a required field": not content of the rebuilt form. */
export function isRequiredNote(text: string): boolean {
  return /^\*?\s*(required fields?|indicates (a )?required( field)?|denotes (a )?required( field)?)\.?$/i.test(clean(text).replace(/^\*\s*/, ''));
}

/**
 * Labels of fields that collect government ids or bank/card numbers. These are left out of
 * notification emails and the form's entries are deleted on a schedule (docs/m2/design.md).
 */
const SENSITIVE: [RegExp, string][] = [
  [/\b(ssn|social security( (number|no\.?|#))?|soc\.? ?sec\.?)\b/i, 'social security number'],
  [/\b(f?ein|i?tin|tax ?id|taxpayer id(entification)?|employer id(entification)?( number)?)\b/i, 'tax id'],
  [/\b(routing|aba)( transit)?( (number|no\.?|#))?\b/i, 'bank routing number'],
  [/\b(account|acct\.?) ?(number|no\.?|#)/i, 'account number'],
  [/\b(iban|swift( code)?|bic)\b/i, 'bank account number'],
  [/\b(credit|debit) card\b|\bcard (number|no\.?|#)|\b(cvv|cvc|csc)\b/i, 'payment card'],
  [/\b(driver'?s?|driving) licen[cs]e (number|no\.?|#)|\bpassport (number|no\.?|#)|\balien (registration )?(number|no\.?|#)|\b(medicaid|medicare) (id|number|no\.?|#)/i, 'government id'],
];

/** Why a field label is sensitive (rule name), or null. */
export function sensitiveReason(field: FormField): string | null {
  if (field.type === 'section' || field.type === 'html' || field.type === 'hidden') return null;
  for (const [re, reason] of SENSITIVE) if (re.test(field.label)) return reason;
  return null;
}

/**
 * What kind of form this is, from its own attributes (id, class, name, action) and heading. A
 * password input means a login; subscription words mean an alerts/newsletter sign-up kept by a
 * service.
 */
export function formKind(signals: { hasPassword: boolean; attrs: string; title: string }): FormRecord['kind'] {
  const text = `${signals.attrs} ${signals.title}`;
  if (signals.hasPassword || /\b(log[- _]?in|sign[- _]?in)\b|staff[- _]login/i.test(text)) return 'login';
  if (/subscri|newsletter|\be-?news\b|\balerts?\b|mailing[- _]?list|sign[- _]?up[- _]for[- _](news|alerts|updates|e-?mail)/i.test(text)) return 'subscription';
  return 'form';
}

/** Words that mark a site-chrome search form. */
export const SEARCH_RE = /(^|[\s_/-])(search|query)([\s_.-]|$)/i;

/** Placeholder options of a select ("-- Choose One --", "Select…", or an empty/zero value). */
export function isPlaceholderOption(text: string, value: string | undefined, first: boolean): boolean {
  if (!first) return false;
  const t = clean(text);
  return !t || value === '' || /^-+.*-+$/.test(t) || /^(please )?(choose|select)\b/i.test(t);
}
