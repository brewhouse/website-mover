/**
 * Headless WordPress block environment for Node.
 *
 * `@wordpress/blocks` and `@wordpress/block-library` are browser packages: they
 * touch `window`/`document` at import time and `rawHandler` parses HTML with the
 * DOM. So we install a jsdom window as globals first and only then load the
 * WordPress packages and register the core blocks. Call `loadWordPress()`; it
 * is memoised, so every caller shares one block registry.
 *
 * We load the packages' CommonJS builds through `createRequire`:
 * - their ESM builds import `.json` files without `with { type: 'json' }`, which
 *   plain Node rejects (they only work through a bundler, tsx or vitest);
 * - the CJS build loads ~2x faster (≈3.5s vs ≈7s for block-library);
 * - one module system means one `@wordpress/blocks` store. Never import
 *   `@wordpress/blocks` directly for runtime values elsewhere: an ESM copy would
 *   have its own, empty block registry. Type-only imports are fine.
 */
import { createRequire } from 'node:module';
import { JSDOM, VirtualConsole } from 'jsdom';

import type { WPBlocks } from './wp-types.js';
export type { WPBlocks };

const require = createRequire(import.meta.url);

let installed = false;
let wp: WPBlocks | undefined;

/** Install a jsdom window as Node globals (idempotent). */
export function installDom(): void {
  if (installed) return;
  installed = true;

  // Editor packages inject CSS-in-JS that jsdom's CSS parser can't read; that
  // noise is harmless. Forward every other jsdom error.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error & { type?: string }) => {
    if (e.type !== 'css-parsing') console.error(e);
  });

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true, // provides requestAnimationFrame
    virtualConsole,
  });
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;

  // Copy every window property Node doesn't already have (DOMParser, Node,
  // HTMLElement, MutationObserver, getComputedStyle, requestAnimationFrame...).
  // Node's own URL, Event, setTimeout, TextEncoder etc. are kept.
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (key in g) continue;
    try {
      g[key] = win[key];
    } catch {
      // a few window getters throw when read like this; not needed
    }
  }

  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define('window', dom.window);
  define('self', dom.window);
  define('document', dom.window.document);
  // Node 21+ has its own read-only `navigator`; WordPress expects the browser one.
  define('navigator', dom.window.navigator);

  // Not implemented by jsdom; editor packages call these while importing.
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  for (const [key, value] of Object.entries({ matchMedia, ResizeObserver })) {
    if (typeof win[key] !== 'function') win[key] = value;
    if (typeof g[key] !== 'function') define(key, value);
  }
}

/**
 * Install the DOM, load `@wordpress/blocks` + `@wordpress/block-library` and
 * register all core blocks (once). Returns the `@wordpress/blocks` API.
 */
export function loadWordPress(): WPBlocks {
  if (wp) return wp;
  installDom();
  // The editor page has `wp.oldEditor`, which makes registerCoreBlocks register
  // the Classic block as the freeform handler. Mirror that so `parse()` reports
  // undelimited HTML as core/freeform (like the editor), not core/missing.
  const win = window as unknown as { wp?: Record<string, unknown> };
  win.wp = { ...win.wp, oldEditor: {} };
  const blocks = require('@wordpress/blocks') as WPBlocks;
  const library = require('@wordpress/block-library') as { registerCoreBlocks: () => void };
  library.registerCoreBlocks();
  wp = blocks;
  return wp;
}
