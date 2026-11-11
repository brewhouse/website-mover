import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { dropReason, unpackTheme, matchFrames, nameTokens, parseFigmaUrl, parsePage, readZip, safeName, summarizeFrames, unpackMockups, type FigmaFrame, type MockupPage } from '../src/index.js';

/** A minimal ZIP writer for tests: deflated entries, optional unix mode. */
function makeZip(files: { name: string; data?: string; mode?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data ?? '');
    const comp = deflateRawSync(raw);
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((f.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const tmp: string[] = [];
afterAll(() => Promise.all(tmp.map((d) => rm(d, { recursive: true, force: true }))));

describe('zip', () => {
  it('reads deflated entries', () => {
    const [e] = readZip(makeZip([{ name: 'a/b.html', data: '<p>hi</p>' }]));
    expect(e!.name).toBe('a/b.html');
    expect(e!.read().toString()).toBe('<p>hi</p>');
  });
  it('refuses paths that leave the folder and symbolic links', () => {
    expect(() => safeName('../x')).toThrow(/Unsafe/);
    expect(() => safeName('/etc/passwd')).toThrow(/Unsafe/);
    expect(() => safeName('a\\..\\..\\x')).toThrow(/Unsafe/);
    expect(safeName('./a//b.css')).toBe('a/b.css');
    expect(() => readZip(makeZip([{ name: 'link', data: '/etc', mode: 0o120777 }]))).toThrow(/symbolic link/);
  });
  it('enforces size limits', () => {
    expect(() => readZip(makeZip([{ name: 'a', data: 'x'.repeat(100) }]), { maxEntries: 10, maxEntryBytes: 50, maxTotalBytes: 1000 })).toThrow(/limit 50/);
  });
});

describe('intake', () => {
  it('keeps what a browser needs and strips the wrapping folder', async () => {
    expect(dropReason('.git/config')).toBe('version control (.git)');
    expect(dropReason('.vscode/settings.json')).toMatch(/hidden/);
    expect(dropReason('css/sections/core/_a.scss')).toMatch(/sources/);
    expect(dropReason('package.json')).toMatch(/build/);
    expect(dropReason('img/a.PNG')).toBeNull();

    const dir = await mkdtemp(path.join(tmpdir(), 'wm-design-'));
    tmp.push(dir);
    const zip = path.join(dir, 'm.zip');
    await writeFile(zip, makeZip([{ name: 'Site/index.html', data: '<h1>Home</h1>' }, { name: 'Site/css/a.css', data: 'a{}' }, { name: 'Site/.git/HEAD', data: 'x' }, { name: 'Site/prepros.config', data: '{}' }]));
    const out = path.join(dir, 'out');
    const r = await unpackMockups(zip, out);
    expect(r).toMatchObject({ kept: 2, strippedPrefix: 'Site' });
    expect((await readdir(out)).sort()).toEqual(['css', 'index.html']);
    expect(await readFile(path.join(out, 'index.html'), 'utf8')).toBe('<h1>Home</h1>');
  });
});

describe('theme intake', () => {
  it('finds the named theme in a repo zip and keeps only PHP, JSON and style.css', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wm-theme-'));
    tmp.push(dir);
    const zip = path.join(dir, 't.zip');
    const t = 'site/wp-content/themes';
    await writeFile(
      zip,
      makeZip([
        { name: `${t}/twentytwentytwo/functions.php`, data: '<?php' },
        { name: `${t}/twentytwentytwo/style.css`, data: '/* parent */' },
        { name: `${t}/planeteriaweb/functions.php`, data: '<?php // child' },
        { name: `${t}/planeteriaweb/style.css`, data: '/* child */' },
        { name: `${t}/planeteriaweb/template-parts/blocks/a.php`, data: '<div class="a">' },
        { name: `${t}/planeteriaweb/theme.json`, data: '{}' },
        { name: `${t}/planeteriaweb/img/logo.png`, data: 'png' },
        { name: `${t}/planeteriaweb/node_modules/x/index.php`, data: '<?php' },
      ]),
    );
    const out = path.join(dir, 'theme');
    const r = await unpackTheme(zip, out);
    expect(r).toMatchObject({ files: 4, prefix: `${t}/planeteriaweb/` });
    expect(await readFile(path.join(out, 'functions.php'), 'utf8')).toBe('<?php // child');
    expect((await readdir(out)).sort()).toEqual(['functions.php', 'style.css', 'template-parts', 'theme.json']);
  });
});

describe('pages', () => {
  it('collects visible text as people see it', () => {
    const p = parsePage(
      `<html><head><title>T</title><style>.x{}</style></head><body>
        <header class="main_header x"><input placeholder="Search Intranet"></header>
        <h1>Rabbit  Reads</h1><p>By <b>Jane</b> S.</p><span aria-hidden="true">hidden</span>
        <a href="calendar.html">Calendar</a><a href="https://x.org/a.html">ext</a><img src="img/a.png?v=1">
        <script>var a = "no";</script></body></html>`,
      'news.html',
    );
    expect(p.h1).toBe('Rabbit Reads');
    expect(p.texts).toEqual(['search intranet', 'rabbit reads', 'by jane s', 'jane', 'calendar', 'ext']);
    expect(p.landmarks).toEqual(['header.main_header']);
    expect(p.links).toEqual(['calendar.html']);
    expect(p.images).toEqual(['img/a.png']);
  });
});

describe('figma', () => {
  it('reads design links', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/MkBx/INTRANET?node-id=8173-34&t=x')).toEqual({ fileKey: 'MkBx', nodeId: '8173:34' });
    expect(() => parseFigmaUrl('https://example.com/design/x?node-id=1-2')).toThrow(/Not a Figma/);
    expect(() => parseFigmaUrl('https://www.figma.com/design/MkBx/x')).toThrow(/node-id/);
  });
  it('summarizes the frames on a page', () => {
    const res = {
      name: 'F',
      lastModified: '',
      version: '1',
      nodes: {
        '1:1': {
          document: {
            id: '1:1',
            name: 'All Pages',
            type: 'CANVAS',
            children: [
              { id: '2:1', name: 'Dashboard v1 ', type: 'FRAME', absoluteBoundingBox: { width: 1440, height: 3000 }, children: [{ id: '3', name: 'Header', type: 'GROUP', children: [{ id: '4', name: 't', type: 'TEXT', characters: 'Quick\nLinks', styles: { text: 'S:1' } }] }, { id: '5', name: 'Hidden', type: 'TEXT', characters: 'nope', visible: false }] },
              { id: '2:2', name: 'note', type: 'TEXT', characters: 'loose text' },
            ],
          },
          styles: { 'S:1': { name: 'H1', styleType: 'TEXT' } },
        },
      },
    };
    const { frames, styles } = summarizeFrames(res, '1:1');
    expect(frames).toEqual([{ id: '2:1', name: 'Dashboard v1', width: 1440, height: 3000, kind: 'desktop', texts: ['quick', 'links', 'quick links'], sections: ['Header'], styleIds: ['S:1'] }]);
    expect(styles).toEqual([{ id: 'S:1', name: 'H1', type: 'TEXT', description: '' }]);
  });
});

describe('matching', () => {
  it('tokenizes names', () => {
    expect([...nameTokens('department-detail1.html')]).toEqual(['department', 'detail']);
    expect([...nameTokens('Documents directory')]).toEqual(['document', 'directory']);
    expect([...nameTokens("404 Error Page doesn't exist")]).toContain('404');
    expect(nameTokens('index.html').has('dashboard')).toBe(true);
  });

  const shell = ['home', 'departments', 'documents', 'calendar', 'privacy policy', 'search intranet'];
  const page = (file: string, own: string[]): MockupPage => ({ file, title: '', h1: null, headings: [], texts: [...shell, ...own], landmarks: [], classes: [], images: [], stylesheets: [], scripts: [], links: [] });
  const frame = (id: string, name: string, texts: string[], width = 1440): FigmaFrame => ({ id, name, width, height: 2000, kind: width === 375 ? 'mobile' : 'desktop', texts, sections: [], styleIds: [] });
  const pages = [
    page('index.html', ['quick links', 'rabbit reads', 'welcome aboard', 'throwback thursday']),
    page('department-detail.html', ['department name', 'all staff', 'staff member one', 'staff member two']),
    page('department-detail-dept.html', ['department name', 'department overview', 'related resources']),
    page('classifieds.html', ['classifieds', 'post an ad', 'for sale']),
    page('result.html', ['search results', 'showing 10 results']),
  ];

  it('matches by name and text, and spots shell and reference frames', () => {
    const m = matchFrames(
      [
        frame('1', 'Dashboard v1', [...shell, 'quick links', 'rabbit reads', 'welcome aboard']),
        frame('2', 'Department Detail - All Staff', [...shell, 'department name', 'all staff', 'staff member one']),
        frame('3', 'Department Detail - Dept Only', [...shell, 'department name', 'department overview', 'related resources']),
        frame('4', 'Classifieds', [...shell, 'classifieds', 'for sale']),
        frame('5', 'Classifieds', [...shell, 'classifieds', 'post an ad', 'upload photos']),
        frame('6', 'Search Results', [...shell, 'search results']),
        frame('7', 'Mobile - Menu 1', [...shell], 375),
        frame('8', 'Typography & Colors Style Guide', ['h1', 'body'], 6790),
        frame('9', 'Something else', ['lorem ipsum']),
      ],
      pages,
    );
    const by = Object.fromEntries(m.map((x) => [x.frameId, x]));
    expect(by['1']).toMatchObject({ role: 'page', page: 'index.html', status: 'proposed' });
    expect(by['2']!.page).toBe('department-detail.html');
    expect(by['3']!.page).toBe('department-detail-dept.html');
    expect([by['4']!.page, by['5']!.page]).toEqual(['classifieds.html', 'classifieds.html']);
    expect(by['6']!.page).toBe('result.html');
    expect(by['7']!.role).toBe('shell');
    expect(by['8']!.role).toBe('reference');
    expect(by['9']!.role).toBe('unmatched');
  });

  it('matches a page by a clear file name when its text is a copy of another page', () => {
    const errorPages = [page('403.html', ['404', 'page not found']), page('404.html', ['404', 'page not found', "this page doesn't exist"])];
    const m = matchFrames([frame('a', '403 Error Access Denied', [...shell, '403', 'access denied']), frame('b', 'Mobile - Menu 2', [...shell, 'quick links', 'rabbit reads', 'welcome aboard'], 375)], [...pages, ...errorPages]);
    expect(m[0]).toMatchObject({ role: 'page', page: '403.html' });
    expect(m[1]).toMatchObject({ role: 'shell', reason: 'named as a menu or other shell part' });
  });

  it('applies reviewer decisions', () => {
    const m = matchFrames([frame('9', 'Something else', ['lorem ipsum'])], pages, { '9': 'result.html' });
    expect(m[0]).toMatchObject({ role: 'page', page: 'result.html', status: 'confirmed' });
  });
});
