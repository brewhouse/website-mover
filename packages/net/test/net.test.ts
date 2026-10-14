import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { assertPublicUrl, isBlockedAddress, safeFetch } from '../src/index.js';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    // /hop redirects to the same server by literal loopback address.
    if (req.url === '/hop') res.writeHead(302, { Location: `http://127.0.0.1:${port}/inner` }).end();
    else res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  delete process.env.WM_ALLOW_PRIVATE_HOSTS;
});

it.each([
  ['127.0.0.1', true],
  ['10.20.30.40', true],
  ['172.31.255.255', true],
  ['192.168.1.1', true],
  ['169.254.169.254', true], // cloud metadata
  ['100.64.0.1', true],
  ['0.0.0.0', true],
  ['::1', true],
  ['[::1]', true],
  ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
  ['fd12:3456::1', true],
  ['fe80::1', true],
  ['8.8.8.8', false],
  ['172.32.0.1', false],
  ['2606:4700:4700::1111', false],
  ['not-an-address', true],
])('%s blocked: %s', (address, expected) => {
  expect(isBlockedAddress(address)).toBe(expected);
});

it('refuses to connect to a private address, whether given as a name or a literal IP', async () => {
  await expect(safeFetch(`http://localhost:${port}/`)).rejects.toMatchObject({ cause: { name: 'BlockedAddressError' } });
  await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ cause: { name: 'BlockedAddressError' } });
});

it('connects to an allowlisted host, but not when it redirects to another private address', async () => {
  process.env.WM_ALLOW_PRIVATE_HOSTS = 'localhost';
  expect(await (await safeFetch(`http://localhost:${port}/`)).text()).toBe('ok');
  await expect(safeFetch(`http://localhost:${port}/hop`)).rejects.toMatchObject({ cause: { name: 'BlockedAddressError' } });
});

it('checks URLs typed at intake: scheme, credentials and address', async () => {
  await expect(assertPublicUrl('ftp://example.org/')).rejects.toThrow(/http/);
  await expect(assertPublicUrl('https://user:secret@example.org/')).rejects.toThrow(/credentials/);
  await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/private or reserved/);
  process.env.WM_ALLOW_PRIVATE_HOSTS = 'localhost';
  await expect(assertPublicUrl('http://localhost:8088/')).resolves.toBeInstanceOf(URL);
});

it('only fetches http and https', async () => {
  await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/Only http and https/);
});
