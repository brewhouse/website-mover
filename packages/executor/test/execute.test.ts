import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { jobPath, writeJsonl } from '@wm/core';
import { approvePlan, buildPlan, savePlan } from '@wm/planner';
import { WpError, type WpClient } from '@wm/wp-client';
import { executePlan, homeFieldValues, restoreHome, uploadOnce, type SeedField } from '../src/index.js';

it('refuses to execute content that changed after the plan was approved', async () => {
  process.env.WM_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'wm-'));
  const extract = jobPath('test', 'extract', 'pages.jsonl');
  await writeJsonl(extract, [{ sourceKey: 'example.org/a', contentHtml: '<p>reviewed</p>' }]);
  const plan = buildPlan({
    jobId: 'test',
    version: 1,
    source: { origin: 'https://example.org', profile: 'generic' },
    inputs: { extractSha256: createHash('sha256').update(await import('node:fs').then((fs) => fs.readFileSync(extract))).digest('hex') },
    target: { name: 'local', url: 'http://localhost:8088', wordpress: '7.0.4', theme: 't', permalinks: '/%postname%/', disabledBlocks: [], reservedSlugs: [], redirection: false, timezone: 'UTC' },
    pages: [],
    snapshotPages: [],
    files: [],
    existing: [],
  });
  await savePlan(plan);
  await approvePlan('test', 'Reviewer');

  // Re-extracted after approval: different content than was reviewed.
  await writeFile(extract, JSON.stringify({ sourceKey: 'example.org/a', contentHtml: '<p>changed</p>' }) + '\n');
  const untouchable = new Proxy({}, { get: () => { throw new Error('the target must not be touched'); } }) as WpClient;

  await expect(executePlan({ jobId: 'test', client: untouchable, log: () => {} })).rejects.toThrow(/extracted content changed/);
});

it('fills the homepage template from the source within its row limits and clears the rest in forms ACF accepts', () => {
  // The seed's "Homepage Details" group, trimmed.
  const fields: SeedField[] = [
    { name: '', type: 'tab' },
    { name: 'banner', type: 'repeater', min: 0, max: 2 },
    { name: 'banner_icon', type: 'repeater', min: 1, max: 8 },
    { name: 'featured_program_heading', type: 'text' },
    { name: 'featured_program_details', type: 'repeater', min: 0 },
    { name: 'department_details', type: 'repeater', min: 1 },
    { name: 'news_list', type: 'relationship', min: '' },
    { name: 'sign_up_content', type: 'wysiwyg' },
  ];
  const slide = (title: string, image: string | null, linkUrl: string | null) => ({ title, image, linkUrl, linkKey: null, linkTitle: 'Learn More' });
  const uploaded: Record<string, number> = { 'https://www.jaxha.org/plugins/show_image.php?id=1': 101 };
  const values = homeFieldValues(
    fields,
    {
      banner: [slide('One', 'https://www.jaxha.org/plugins/show_image.php?id=1', '/about-us/'), slide('Two', 'https://www.jaxha.org/plugins/show_image.php?id=2', null), slide('Three', null, null)],
      quickLinks: [{ title: 'View Our Full Calendar', url: '/events/', key: null }],
      clearOthers: true,
    },
    { link: (_key, url) => url, mediaId: (url) => (url ? uploaded[url] : undefined) },
  );

  expect(values.acf).toEqual({
    // At most 2 slides; a slide without a link gets no link (not an empty one).
    banner: [
      { select_image: 101, title: 'One', link: { title: 'Learn More', url: '/about-us/', target: '' } },
      { select_image: null, title: 'Two', link: null },
    ],
    banner_icon: [{ banner_icon: null, icon_link: { title: 'View Our Full Calendar', url: '/events/', target: '' } }],
    featured_program_heading: '',
    featured_program_details: [],
    // ACF rejects [] for a relationship and won't save a required repeater empty.
    news_list: null,
    sign_up_content: '',
  });
  expect(values.counts).toEqual({ slides: 2, quickLinks: 1 });
  expect(values.warnings).toEqual([
    'Homepage slide "Two": its image wasn\'t uploaded, so the slide has none.',
    'The homepage template takes at most 2 slides; left out: "Three"',
    'The homepage template requires at least 1 "department_details" row(s): the seed\'s placeholders stay until an editor replaces them.',
  ]);
});

it('restores the homepage fields in the form ACF accepts: empty repeaters as [], not null', async () => {
  // Like ACF's REST check: a repeater must be an array (null is refused), a relationship may be null.
  const repeaters = new Set(['banner', 'featured_program_details']);
  const posted: Record<string, unknown>[] = [];
  const client = {
    post: async (_path: string, body: { acf: Record<string, unknown> }) => {
      posted.push(body.acf);
      const bad = Object.entries(body.acf).find(([k, v]) => repeaters.has(k) && !Array.isArray(v));
      if (bad) throw Object.assign(new Error('400 rest_invalid_param'), { body: { data: { params: { acf: `acf[${bad[0]}] must be of type array or null.` } } } });
      return {};
    },
  } as unknown as WpClient;
  const acf = { banner: [{ title: 'One' }], featured_program_details: null, news_list: null, sign_up_title: '' };

  // A snapshot with field types gets it right first time.
  await restoreHome(client, { pageId: 7, acf, types: { banner: 'repeater', featured_program_details: 'repeater', news_list: 'relationship', sign_up_title: 'text' } });
  expect(posted).toEqual([{ ...acf, featured_program_details: [] }]);

  // An older snapshot (no types) is fixed up from ACF's error.
  posted.length = 0;
  await restoreHome(client, { pageId: 7, acf });
  expect(posted.at(-1)).toEqual({ ...acf, featured_program_details: [] });
  expect(posted).toHaveLength(2);
});

it('treats a gateway timeout on an upload as unknown: the file is used if it arrived, never uploaded twice', async () => {
  const meta = { _wm_source_key: 'jaxha.org/plugins/show_image.php?id=820', _wm_job_id: 'jha' };
  const fake = (uploadError: Error, onSite: boolean) => {
    const calls: string[] = [];
    const client = {
      upload: async () => {
        calls.push('upload');
        throw uploadError;
      },
      get: async (path: string) => {
        calls.push(path);
        if (path === '/website-mover/v1/entities') return onSite ? [{ id: 36820, source_key: meta._wm_source_key }] : [];
        return { id: 36820, source_url: 'https://dev.example/wp-content/uploads/slide.jpg' };
      },
    } as unknown as WpClient;
    return { client, calls };
  };
  const data = new Uint8Array(1) as Uint8Array<ArrayBuffer>;

  // Pantheon answered 502, but WordPress had saved the file.
  const arrived = fake(new WpError(502, 'http_error', '<html>', ''), true);
  expect(await uploadOnce(arrived.client, data, 'slide.jpg', 'image/jpeg', meta)).toEqual({ id: 36820, source_url: 'https://dev.example/wp-content/uploads/slide.jpg' });
  expect(arrived.calls.filter((c) => c === 'upload')).toHaveLength(1);

  // A 502 where nothing arrived is still a failure.
  await expect(uploadOnce(fake(new WpError(502, 'http_error', '<html>', ''), false).client, data, 'slide.jpg', 'image/jpeg', meta)).rejects.toThrow(/502/);

  // WordPress refused it: no lookup, the error stands.
  const refused = fake(new WpError(400, 'rest_upload_sideload_error', 'not allowed', ''), true);
  await expect(uploadOnce(refused.client, data, 'slide.jpg', 'image/jpeg', meta)).rejects.toThrow(/400/);
  expect(refused.calls).toEqual(['upload']);
});

