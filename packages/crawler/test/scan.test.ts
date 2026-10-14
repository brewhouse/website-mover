import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobPath, readJsonl, type SnapshotFile, type SnapshotPage } from '@wm/core';
import { bjmProfile, scanSite } from '../src/index.js';

/** A tiny BJM-shaped site served locally; the scan runs against it for real. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const PDF = Buffer.from('%PDF-1.4\n% fixture\n%%EOF\n');
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let server: Server;
let origin: string;
let dataDir: string;
const requests: string[] = [];

const html = (body: string) => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;

function route(url: URL, method: string): { status: number; type: string; body: string | Buffer; headers?: Record<string, string> } {
  const p = url.pathname;
  if (p === '/robots.txt') return { status: 200, type: 'text/plain', body: `User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n` };
  if (p === '/sitemap.xml') {
    const locs = ['/', '/About-Us', '/plugins/show_image.php?id=7'].map((u) => `<url><loc>${origin}${u.replace('&', '&amp;')}</loc></url>`).join('');
    return { status: 200, type: 'application/xml', body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>` };
  }
  if (p === '/') {
    return {
      status: 200,
      type: 'text/html',
      body: html(`
        <a href="/about-us">About</a>
        <a href="/calendar?year=2026">2026 calendar</a>
        <a href="/news?category=3&year=2024">Filtered news</a>
        <a href="/staff-login">Staff</a>
        <a href="/private/notes">Private</a>
        <a href="mailto:info@example.org">Mail</a>
        <a href="/plugins/show_image.php?id=5">Photo</a>
        <img src="/plugins/show_image.php?id=5&size=1000" alt="">
        <div style="background-image: url(/plugins/show_image.php?type=medium&id=5)"></div>
        <a href="https://files.example.net/report.pdf">External report</a>`),
    };
  }
  if (p === '/site-map') return { status: 200, type: 'text/html', body: html('<div class="tree_item"><a href="/hidden-page">Hidden</a></div>') };
  if (p.toLowerCase() === '/about-us') return { status: 200, type: 'text/html', body: html('<a href="plugins/show_image.php?id=9">Annual plan</a>') };
  if (p === '/hidden-page') return { status: 200, type: 'text/html', body: html('<p>Only in the HTML site map.</p>') };
  if (p === '/plugins/show_image.php') {
    const id = url.searchParams.get('id');
    if (id === '5') return { status: 200, type: 'image/png', body: method === 'HEAD' ? '' : PNG };
    if (id === '9' || id === '7') {
      // BJM sends PHP-escaped quotes in filenames.
      const headers = { 'content-disposition': `inline; filename="Plan \\' ${id}.pdf"` };
      return { status: 200, type: 'application/pdf', body: method === 'HEAD' ? '' : PDF, headers };
    }
  }
  return { status: 404, type: 'text/html', body: html('Not found') };
}

const scan = () => scanSite({ jobId: 'scan-test', origin, profile: 'bjm' });

let pages: SnapshotPage[];
let files: SnapshotFile[];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'wm-scan-'));
  process.env.WM_DATA_DIR = dataDir;
  server = createServer((req, res) => {
    const url = new URL(req.url!, origin);
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const r = route(url, req.method!);
    res.writeHead(r.status, { 'content-type': r.type, ...r.headers });
    res.end(req.method === 'HEAD' ? undefined : r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await scan();
  pages = await readJsonl<SnapshotPage>(jobPath('scan-test', 'snapshot', 'pages.jsonl'));
  files = await readJsonl<SnapshotFile>(jobPath('scan-test', 'snapshot', 'files.jsonl'));
}, 30_000);

afterAll(() => {
  server?.close();
  delete process.env.WM_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('scanSite (bjm)', () => {
  it('discovers pages from the sitemap, the HTML site map and links, once per source key, skipping filtered views', () => {
    const found = Object.fromEntries(pages.map((p) => [new URL(p.url).pathname, p.via]));
    expect(found).toEqual({ '/': 'seed', '/site-map': 'seed', '/About-Us': 'sitemap', '/hidden-page': 'site-map' });
    expect(pages.every((p) => p.status === 200 && p.html)).toBe(true);
    expect(requests.filter((r) => /calendar|category|staff|private/.test(r))).toEqual([]);
  });

  it('downloads each referenced same-site file once under its canonical URL, with hash and referrers', () => {
    const byUrl = Object.fromEntries(files.map((f) => [f.url, f]));
    expect(Object.keys(byUrl).sort()).toEqual([5, 7, 9].map((id) => `${origin}/plugins/show_image.php?id=${id}`));

    const photo = byUrl[`${origin}/plugins/show_image.php?id=5`]!;
    expect(photo).toMatchObject({ status: 200, contentType: 'image/png', filename: null, bytes: PNG.length, sha256: sha256(PNG), referencedBy: ['127.0.0.1'] });
    expect(photo.path).toBe(`snapshot/files/${sha256(PNG)}.png`);
    expect(readFileSync(jobPath('scan-test', photo.path!))).toEqual(PNG);

    const plan = byUrl[`${origin}/plugins/show_image.php?id=9`]!;
    expect(plan).toMatchObject({ filename: "Plan ' 9.pdf", sha256: sha256(PDF), path: `snapshot/files/${sha256(PDF)}.pdf`, referencedBy: ['127.0.0.1/about-us'] });

    // Listed only in sitemap.xml: recorded, not downloaded.
    expect(byUrl[`${origin}/plugins/show_image.php?id=7`]).toMatchObject({ path: null, sha256: null, referencedBy: [] });
    expect(requests).not.toContain('GET /plugins/show_image.php?id=7');
  });

  it("doesn't download files again on a re-run", async () => {
    const before = requests.filter((r) => r.startsWith('GET /plugins/')).length;
    await scan();
    expect(requests.filter((r) => r.startsWith('GET /plugins/')).length).toBe(before);
    expect(await readJsonl<SnapshotFile>(jobPath('scan-test', 'snapshot', 'files.jsonl'))).toEqual(files);
  }, 30_000);
});

describe('bjmProfile.fileUrl', () => {
  it('maps every rendition and host spelling of a file-library URL to one canonical URL', () => {
    const canonical = 'https://www.jaxha.org/plugins/show_image.php?id=1925';
    const rows: [string, string | undefined][] = [
      ['https://www.jaxha.org/plugins/show_image.php?id=1925', canonical],
      ['https://www.jaxha.org/plugins/show_image.php?id=1925&size=1000', canonical],
      ['https://www.jaxha.org/plugins/show_image.php?type=medium&id=1925', canonical],
      ['http://jaxha.org/Plugins/Show_Image.php?id=1925', canonical],
      ['https://www.jaxha.org/plugins/show_image.php?id=abc', undefined],
      // BJM's staging host has its own library: not the client's file.
      ['https://green.brooksjeffrey.us/plugins/show_image.php?id=1518', undefined],
    ];
    for (const [input, expected] of rows) expect(bjmProfile.fileUrl(new URL(input), 'https://www.jaxha.org'), input).toBe(expected);
  });
});
