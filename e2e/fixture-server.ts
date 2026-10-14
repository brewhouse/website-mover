/**
 * Serves a fixture site (e2e/fixtures/<name>) on 127.0.0.1 for end-to-end runs, e.g. the rollback
 * test in docs/m5/results.md:  npx tsx fixture-server.ts small-site 8199
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [name = 'small-site', port = '8199'] = process.argv.slice(2);
const root = path.join(import.meta.dirname, 'fixtures', name);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.txt': 'text/plain' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  // /page and /page?id=1 are page.html; / is index.html.
  const file = url.pathname === '/' ? 'index.html' : path.extname(url.pathname) ? url.pathname.slice(1) : `${url.pathname.slice(1)}.html`;
  const full = path.join(root, path.normalize(file));
  if (!full.startsWith(root)) return void res.writeHead(400).end();
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>Not found</h1>');
  }
}).listen(Number(port), '127.0.0.1', () => console.log(`Fixture ${name} on http://127.0.0.1:${port}`));
