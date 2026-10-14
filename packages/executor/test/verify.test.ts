import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { jobPath, writeJson } from '@wm/core';
import { classify, linksIn, otherJobsOnTarget } from '../src/index.js';

it('accepts a legacy URL that reaches its page directly or with one redirect, and names every other outcome', () => {
  const hop = (status: number, location: string | null = null) => ({ status, location });
  expect(classify([hop(200)], '/about-us/', '/about-us/')).toBeNull();
  expect(classify([hop(301, '/about-us/'), hop(200)], '/about-us/', '/About-Us')).toBeNull(); // case, trailing slash
  expect(classify([hop(301, '/a/'), hop(301, '/about-us/'), hop(200)], '/about-us/', '/about-us/')).toBe('chain');
  expect(classify([hop(301, '/news/'), hop(200)], '/news/', '/about-us/')).toBe('wrong-target');
  expect(classify([hop(404)], '/gone/', '/gone/')).toBe('not-found');
  expect(classify([hop(500)], '/x/', '/x/')).toBe('error');
  expect(classify([hop(301, '/a/'), hop(301, '/b/')], '/b/', '/a/')).toBe('loop');
});

it('collects the same-site http links and images on a page, once each, without fragments or WordPress admin URLs', () => {
  const html = `
    <a href="/about-us/#team">About</a> <a href="https://site.test/about-us/">Again</a>
    <a href="news/?page=2">Relative</a> <img src="/wp-content/uploads/logo.png">
    <a href="https://other.example/x">External</a> <a href="mailto:a@b.org">Mail</a> <a href="#top">Top</a>
    <a href="webcal://site.test/event/x/?ical=1">iCal</a> <a href="/wp-admin/">Admin</a> <a href="/wp-login.php?action=logout">Out</a>
    <a href="+1%20904-990-8560,,123#">Dial-in</a>`;
  expect(linksIn(html, 'https://site.test/board/').sort()).toEqual(
    [
      'https://site.test/about-us/',
      'https://site.test/board/news/?page=2',
      'https://site.test/wp-content/uploads/logo.png',
      // A phone number pasted as a link resolves to a page that doesn't exist: reported as broken.
      'https://site.test/board/+1%20904-990-8560,,123',
    ].sort(),
  );
});

it('finds the other jobs on the same target, with the redirects and content types they use', async () => {
  process.env.WM_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'wm-rollback-'));
  const job = async (id: string, target: string, startedAt: string, redirects: string[], types: string[]) => {
    await writeJson(jobPath(id, 'run', 'state.json'), { jobId: id, planVersion: 1, startedAt, redirects: redirects.map((from) => ({ from, to: '/x/' })), entities: {} });
    await writeJson(jobPath(id, 'plan', 'plan.v1.json'), { target: { url: target }, contentTypes: types.map((postType) => ({ postType })) });
  };
  await job('a', 'http://seed.test', '2026-10-14T10:00:00Z', ['/latest-news/', '/a-only/'], ['community']);
  await job('b', 'http://seed.test', '2026-10-14T11:00:00Z', ['/latest-news/'], []);
  await job('c', 'http://elsewhere.test', '2026-10-14T12:00:00Z', ['/a-only/'], ['community']);
  expect(await otherJobsOnTarget('b', 'http://seed.test')).toEqual([
    { jobId: 'a', startedAt: '2026-10-14T10:00:00Z', redirects: ['/latest-news/', '/a-only/'], contentTypes: ['community'] },
  ]);
});
