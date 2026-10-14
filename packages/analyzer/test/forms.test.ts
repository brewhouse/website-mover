import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobPath, readJson, sourceKey, writeJsonl, type FormAnalysis, type FormRecord } from '@wm/core';
import { analyzeForms } from '../src/index.js';

/**
 * analyzeForms on a small job: every page has site chrome (a header search box, a footer
 * newsletter box, and a sidebar poll repeated on every page), plus one real form of each kind.
 * Shapes follow jaxha.org's forms; all labels and values are made up.
 */
const ORIGIN = 'https://www.example.org';

const chrome = (main: string) => `<!doctype html><html><head><title>Example</title></head><body>
<header><form action="/search.php" name="form_search" class="search-form"><input type="text" name="q"><button>Go</button></form></header>
<main>
  <div class="sidebar"><form action="/poll" method="post"><label for="poll">Rate this site</label><select id="poll" name="poll"><option>Good</option><option>Bad</option></select><button>Vote</button></form></div>
  ${main}
</main>
<footer><form action="/newsletter" method="post"><label for="nl">Newsletter email</label><input type="email" id="nl" name="nl"></form></footer>
</body></html>`;

// Native form: legend title, a note, select with a placeholder option, asterisk-marked labels,
// a radio group in a fieldset, a textarea inside its label, a field a script injects when a topic
// is picked, a required-fields note, reCAPTCHA, hidden input and buttons.
const CONTACT = chrome(`
<form action="/contact" method="post" id="contactForm">
  <fieldset>
    <legend><h1>Contact Us</h1></legend>
    <h2>We answer within two business days</h2>
    <div><label for="topic">Topic*</label>
      <select id="topic" name="topic" required><option value="0">-- Choose One --</option><option value="billing">Billing</option><option value="other">Other</option></select></div>
    <div><label for="name">Name</label><input type="text" id="name" name="name"></div>
    <div><label for="email">Email<span class="requiredRed">*</span></label><input type="email" id="email" name="email"></div>
    <fieldset class="reset">
      <legend>How did we do?<span class="requiredRed">*</span></legend>
      <label for="good"><input type="radio" id="good" name="rating" value="g"> Good</label>
      <label for="bad"><input type="radio" id="bad" name="rating" value="b"> Bad</label>
    </fieldset>
    <label for="comments"><strong>Comments:</strong> (100 words max)<textarea id="comments" name="comments"></textarea></label>
    <div id="topicFields"></div>
    <div class="note">*Required Fields</div>
    <div class="g-recaptcha" data-sitekey="test"></div>
    <input type="hidden" name="submit" value="Submit"><button type="submit">Submit</button>
  </fieldset>
</form>
<script>
  function pickTopic() {
    var html = '';
    switch ($('#topic').val()) {
      case 'billing':
        html = '<label for="billing">Billing details*</label><textarea id="billing" name="billing" required></textarea>';
        $('#topicFields').html(html);
        break;
    }
  }
</script>`);

// jQuery formBuilder: an empty container drawn from JSON in a single-quoted JS string.
const FB = JSON.stringify([
  { type: 'header', subtype: 'h4', label: 'Payee' },
  { type: 'paragraph', subtype: 'p', label: 'Ask your bank for these numbers.' },
  { type: 'text', subtype: 'text', label: "Payee's Name", name: 'payee', required: true },
  { type: 'text', subtype: 'text', label: 'Tax ID (SSN or EIN)', name: 'tax-id' },
  { type: 'text', subtype: 'tel', label: 'Phone', name: 'phone' },
  { type: 'select', label: 'State', name: 'state', values: [{ label: 'Florida', value: 'FL', selected: true }, { label: 'Georgia', value: 'GA' }] },
  { type: 'checkbox-group', label: 'Account Type', name: 'type', values: [{ label: 'Checking', value: 'c' }, { label: 'Savings', value: 's' }] },
  { type: 'number', label: ' Account Number ', name: 'acct', min: 0 },
  { type: 'paragraph', subtype: 'p', label: '<hr>' },
  { type: 'file', label: 'Voided check', name: 'check', multiple: true, description: 'PDF or JPG' },
  { type: 'date', label: 'Date', name: 'date', required: true },
]);
const DIRECT_DEPOSIT = chrome(`
<h2 class="custom-form-header">Direct Deposit Form</h2>
<form class="formWrapper" method="POST" id="fb-render" enctype="multipart/form-data">
  <div id="rendered-content"></div>
  <div class="g-recaptcha" id="g-recaptcha"></div>
  <input type="submit" value="Submit">
</form>
<script>
$(function ($) {
  $('#rendered-content').formRender({ dataType: 'json', formData: '${FB.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')}' });
});
</script>`);

const ALERTS = chrome(`
<form method="post" id="signup-for-alerts-form"><h2>Get Alerts</h2><label for="a">Email</label><input type="email" id="a" name="email"></form>`);

const LOGIN = chrome(`
<form method="post" action="/staff-pages"><label for="u">Username</label><input id="u" name="u"><label for="p">Password</label><input type="password" id="p" name="p"></form>`);

const PAGES = [
  { path: '/contact', title: 'Contact', html: CONTACT },
  { path: '/direct-deposit', title: 'Direct Deposit', html: DIRECT_DEPOSIT },
  { path: '/alerts', title: 'Alerts', html: ALERTS },
  { path: '/staff-login', title: 'Staff Login', html: LOGIN },
  { path: '/about', title: 'About', html: chrome('<p>About us.</p>') },
];

let dataDir: string;
let result: FormAnalysis;
const form = (path: string): FormRecord => result.forms.find((f) => f.pageKey === sourceKey(ORIGIN + path))!;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'wm-forms-'));
  process.env.WM_DATA_DIR = dataDir;
  const snapshot = [];
  const extracted = [];
  for (const [i, p] of PAGES.entries()) {
    const url = ORIGIN + p.path;
    const html = `snapshot/html/${i}.html`;
    await mkdir(path.dirname(jobPath('t', html)), { recursive: true });
    await writeFile(jobPath('t', html), p.html);
    snapshot.push({ url, finalUrl: url, status: 200, contentType: 'text/html', fetchedAt: '', html, via: 'sitemap' });
    extracted.push({ sourceKey: sourceKey(url), url, title: p.title });
  }
  await writeJsonl(jobPath('t', 'snapshot', 'pages.jsonl'), snapshot);
  await writeJsonl(jobPath('t', 'extract', 'pages.jsonl'), extracted);
  result = await analyzeForms('t');
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.WM_DATA_DIR;
});

describe('analyzeForms', () => {
  it('finds one form per page with a real form, by kind, skipping site chrome; writes analyze/forms.json', async () => {
    expect(result.forms.map((f) => [f.key, f.kind])).toEqual([
      ['example.org/contact#form-1', 'form'],
      ['example.org/direct-deposit#form-1', 'form'],
      ['example.org/alerts#form-1', 'subscription'],
      ['example.org/staff-login#form-1', 'login'],
    ]);
    expect(await readJson(jobPath('t', 'analyze', 'forms.json'))).toEqual(result);
  });

  it('reads a native form: verbatim labels, "*" as required, grouped choices, script-injected fields', () => {
    const contact = form('/contact');
    expect(contact).toMatchObject({ title: 'Contact Us', description: 'We answer within two business days', implementation: 'native', uploads: false, sensitive: [] });
    expect(contact.fields).toEqual([
      { label: 'Topic', type: 'select', required: true, choices: ['Billing', 'Other'], placeholder: '-- Choose One --' },
      { label: 'Name', type: 'text', required: false },
      { label: 'Email', type: 'email', required: true },
      { label: 'How did we do?', type: 'radio', required: true, choices: ['Good', 'Bad'] },
      { label: 'Comments: (100 words max)', type: 'textarea', required: false },
      // Shown (and required) only for one topic on the source: rebuilt optional, with a warning.
      { label: 'Billing details', type: 'textarea', required: false },
    ]);
    const codes = contact.warnings.map((w) => w.split(':')[0]);
    expect(codes).toContain('conditional-field');
    expect(contact.captcha).toBe(true);
  });

  it('reads a jQuery formBuilder definition and flags sensitive fields', () => {
    const dd = form('/direct-deposit');
    expect(dd).toMatchObject({
      title: 'Direct Deposit Form',
      implementation: 'formbuilder',
      uploads: true,
      sensitive: ['Tax ID (SSN or EIN)', 'Account Number'],
    });
    expect(dd.fields).toEqual([
      { label: 'Payee', type: 'section', required: false, content: 'Payee' },
      { label: '', type: 'html', required: false, content: '<p>Ask your bank for these numbers.</p>' },
      { label: "Payee's Name", type: 'text', required: true },
      { label: 'Tax ID (SSN or EIN)', type: 'text', required: false },
      { label: 'Phone', type: 'phone', required: false },
      { label: 'State', type: 'select', required: false, choices: ['Florida', 'Georgia'] },
      { label: 'Account Type', type: 'checkbox', required: false, choices: ['Checking', 'Savings'] },
      // A number box on the source; text keeps leading zeros.
      { label: 'Account Number', type: 'text', required: false },
      { label: '', type: 'html', required: false, content: '<hr>' },
      { label: 'Voided check', type: 'file', required: false, description: 'PDF or JPG' },
      { label: 'Date', type: 'date', required: true },
    ]);
  });
});
