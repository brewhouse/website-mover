import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { guardRequests, isInterstitial, prepareContext } from '../src/index.js';

let server: Server;
let port: number;
const hits: string[] = [];

beforeAll(async () => {
  // The page is on an allowlisted host (localhost); it pulls an image from 127.0.0.1, which isn't.
  server = createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    if (req.url === '/page') res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<img src="http://127.0.0.1:${port}/secret.png"><img src="http://localhost:${port}/ok.png">`);
    else res.writeHead(200, { 'Content-Type': 'image/png' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  process.env.WM_ALLOW_PRIVATE_HOSTS = 'localhost';
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

it('stops the browser from loading anything from a blocked address, while the allowed host loads', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await guardRequests(context);
    const tab = await context.newPage();
    await tab.goto(`http://localhost:${port}/page`, { waitUntil: 'load' });
  } finally {
    await browser.close();
  }
  expect(hits.some((h) => h.endsWith('/page'))).toBe(true);
  expect(hits.some((h) => h.endsWith('/ok.png'))).toBe(true);
  expect(hits.some((h) => h.endsWith('/secret.png'))).toBe(false);
}, 60_000);

it('gets past a hosting notice (Pantheon sandbox) to the site, and recognizes the notice if it stays', async () => {
  const notice = createServer((req, res) => {
    const bypass = /Deterrence-Bypass=1/.test(req.headers.cookie ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(bypass ? '<title>News</title><h1>News</h1>' : '<title>Sandbox Environment Notice</title><p>This website is hosted in a sandbox environment.</p>');
  });
  await new Promise<void>((resolve) => notice.listen(0, '127.0.0.1', resolve));
  const url = `http://localhost:${(notice.address() as AddressInfo).port}/news/`;
  const browser = await chromium.launch();
  try {
    const plain = await (await browser.newContext()).newPage();
    await plain.goto(url);
    expect(isInterstitial(await plain.title())).toBe(true);

    const context = await browser.newContext();
    await prepareContext(context, url);
    const tab = await context.newPage();
    await tab.goto(url);
    expect(await tab.title()).toBe('News');
    expect(isInterstitial(await tab.title())).toBe(false);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => notice.close(() => resolve()));
  }
}, 60_000);
