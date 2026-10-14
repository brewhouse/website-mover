# M0 spike: HTML → Gutenberg blocks in Node

**Result: PASS, in Node and in the real WordPress 7.0.4 editor.** In Node 22 with jsdom, WordPress's own `@wordpress/blocks` and `@wordpress/block-library` (the WP 7.0 builds) convert every fixture into blocks that pass the editor's validator, with no Classic, missing or core/html fallback blocks. The structured builders (columns, cover, group, buttons) also produce valid blocks, and the markup survives `serialize → parse → serialize` unchanged. jsdom was enough, so the Playwright fallback wasn't needed for conversion. The converted sample post (47 blocks) was saved to the local seed over REST and opened in the block editor with **0 invalid blocks and no warnings** (§7).

Code: `packages/blocks/src/{env,convert,validate}.ts`. Tests: `packages/blocks/test/convert.test.ts`. Sample: `packages/blocks/scripts/sample-post.ts`.

## 1. Evidence

`pnpm --filter @wm/blocks test` gives **1 file and 15 tests passed**, in about 3–4 s. Most of that time is the one-off WordPress load. Each fixture is converted, serialized, then run through `validateSerialized` (which does what the editor does on load). Each one must have no errors, an identical round trip and no fallback blocks, and must meet the assertions in the table below.

| Fixture | Blocks produced (top level) | Assertions beyond validity |
|---|---|---|
| `paragraphs.html` | 3 × paragraph | `<b>/<i>` become `strong/em`; links kept; relative PDF path kept; `&nbsp;` paragraph dropped |
| `headings.html` | heading ×6 (levels 1–6) | levels 1–6. A separate test checks that `demoteH1` turns level 1 into 2 |
| `lists.html` | list (ul), list (ol, `start: 3`) | nested `core/list` inside `core/list-item` (×2) |
| `table.html` | table ×2 | thead `th` cells, 3 body rows; `<caption>` and a Gutenberg-rendered `figure.wp-block-table > figcaption` both end up in the `caption` attribute |
| `images.html` | image ×4 | plain `<img>` in a `<p>`; figure+figcaption with `align: center`; lazy `data-src` resolved; linked image `href`; **no `id`** carried over from `wp-image-4512` |
| `blockquote.html` | quote > paragraph | `<footer><cite>` goes into the `citation` attribute |
| `code.html` | code, preformatted | entities preserved |
| `separator.html` | paragraph, separator, paragraph | — |
| `embeds.html` | paragraph, embed ×4 | YouTube and Vimeo URLs on their own line, a `youtube-nocookie` iframe and a wrapped `player.vimeo.com` iframe all become `core/embed` with `providerNameSlug` youtube/vimeo, `type: video`, `responsive`, canonical URL |
| `layout-wrappers.html` | heading, paragraph ×4 | page-builder `section/div` wrappers unwrapped; sibling text `<div>`s stay separate paragraphs; no `script`, `onclick`, `javascript:`, `style=` or source classes left |
| `sample-post.html` (generic path) | 16 kinds of block, 0 fallbacks | contains heading, list, image, table, quote, embed, separator, preformatted |
| builders (in code) | cover(heading, paragraph); columns(2: heading+paragraph+image / heading+list); group(columns(3: heading+paragraph / embed / table), buttons) | attributes and inner structure survive parse |

Two checks show the tests can fail:
- **Validator negative control.** A wrong heading level (`invalid`), loose HTML (`freeform`), `acme/widget` (`missing`), a pre-6.2 quote (`deprecated`), a paragraph with a stray class that is fixed on load (`drift`) and core/html (warning) are each reported at the right path.
- **Mutation check.** Disabling the embed post-pass and the lazy-src fix turns 3 tests red (embeds, images, sample-post).

`scripts/sample-post.ts` builds 47 blocks (cover, columns ×2, group, buttons, table, quote, embed, image ×2, lists, and others). Result: valid, round trip OK, 0 errors, 0 html fallbacks.

**Validation issues found during the spike.** These are all conversion-fidelity problems. None was an invalid block: everything `rawHandler` and `createBlock` produce validates.
1. `wp-image-123` classes became `id: 123`, a source attachment ID that would point at the wrong media on the target. **Fix:** strip classes before conversion.
2. Lazy images became `core/image` with the `data:` placeholder as the URL. **Fix:** resolve `data-src`, `data-lazy-src` or `data-original`; drop the image (with a warning) if no usable src.
3. YouTube iframes became `core/html`, and an iframe inside a `<p>` stayed raw *inside paragraph content*. **Fix:** video iframes become a canonical URL paragraph, which `rawHandler` turns into `core/embed`; allowlisted iframes (Google Maps) are lifted to the top level and become `core/html`; all other iframes are dropped.
4. `rawHandler` gives `core/embed` only `{url}`. **Fix:** add the attributes the editor would set after its oEmbed lookup, using the registered embed variations' URL patterns.
5. `<cite>` inside a blockquote became a `core/html` child of the quote. **Fix:** move it to `citation`.
6. Layout `div/section` wrappers made the whole subtree one opaque `core/html` block (with `<script>` and `onclick` intact). **Fix:** unwrap containers, wrap loose inline runs in `<p>`, strip script, style and `on*`.
7. `<caption>` was silently dropped, and `figure.wp-block-table` became `core/html`. **Fix:** unwrap the figure, remember the caption, set `caption` on the matching `core/table` (in document order, guarded by a count check).
8. Smaller fixes: an empty `<p>` was left behind after an image was lifted out of it (now dropped); `linkDestination: "custom"` with no `href` when the caption contained a link (now cleared); alignment classes were duplicated into `className` (alignment now moved to the `<img>`).

## 2. Approach: jsdom (Playwright not needed)

`src/env.ts` creates a jsdom window, copies its properties onto `globalThis` (keeping Node's own `URL`, `Event`, timers and the like), and sets `window`, `document` and `navigator` (Node 22's `navigator` is read-only by default, so it is redefined). It adds `matchMedia` and `ResizeObserver` stubs and sets `window.wp.oldEditor = {}` so the Classic block registers as the freeform handler, as it does in the editor. Only then does it load WordPress and call `registerCoreBlocks()`, which registers 106 block types.

- **CommonJS builds through `createRequire`, not ESM `import`.** The ESM builds import `.json` files without `with {type:'json'}`, so plain Node rejects them; they only work through tsx, vitest or a bundler. The CJS builds also load about twice as fast (≈4.3 s against ≈7 s under tsx). Using one module system also guarantees **one** `@wordpress/blocks` store. Rule: don't import `@wordpress/blocks` for runtime values anywhere else, because a second (ESM) copy has its own empty registry. Type-only imports go through `src/wp-types.ts`.
- **Where jsdom falls short. None of these is in our code path:**
  - No `innerText`. The paragraph→buttons *block transform* would produce empty text, so we build buttons with `createBlock`.
  - No `URL.createObjectURL`. `pasteHandler`'s imageCorrector crashes on `data:` images. We use `rawHandler`, and remove `data:` images ourselves anyway.
  - jsdom's CSS parser rejects the editor packages' CSS-in-JS. That is harmless noise, filtered out (`css-parsing` errors only).

  `rawHandler`, `serialize`, `parse` and `validateBlock` need no layout APIs, so no comparison under Playwright was needed.
- **`rawHandler` vs `pasteHandler` (tested both).** `pasteHandler` sanitizes and unwraps more on its own, but it loses data without warning. It flattens `<dl>`, `<details>` and forms into one run-together paragraph, merges `<cite>` into the quote text, drops table captions and alignment, and still keeps `javascript:` hrefs. Use `rawHandler` plus our own pre-pass and post-pass. Its "unknown → `core/html`" behaviour matches PLAN §6.9 (fallback plus a warning).

Pipeline: `html → normalize (ours, DOM) → rawHandler → tidy (ours, attributes via createBlock) → Block[] → serialize`. We never write block comment markup ourselves.

## 3. Versions pinned, and why

| Package | Version | Source |
|---|---|---|
| `@wordpress/block-library` | 9.40.2 | `wp-7.0` dist-tag (latest is 11.2.0) |
| `@wordpress/blocks` | 15.13.1 | `wp-7.0` dist-tag (latest is 16.2.0) |
| all other `@wordpress/*` deps (57 in total) | their `wp-7.0` dist-tag | `overrides` in `pnpm-workspace.yaml` |
| `react`, `react-dom` | 18.3.1 | peer dependency of the 7.0 packages |
| `jsdom` / `@types/jsdom` | 30.1.2 / 30.0.0 | — |

- **Why match the editor.** The editor marks a block invalid when the stored HTML differs from what *its own* `save()` produces for the stored attributes. Block markup changes between releases. For example, in 7.0 the heading's `textAlign` attribute moved to `style.typography.textAlign`: 7.0 still reads the old form through a deprecation (we saw it migrate), but markup produced by a newer `save()` than the editor's can contain classes or attributes the older editor doesn't produce. That shows up as "This block contains unexpected or invalid content". Generating with exactly the editor's versions makes Node validation predict the editor's result.
- **Why the overrides are needed.** `block-library@9.40.2` depends on `@wordpress/blocks@^15.13.1` and other caret ranges. Without overrides, pnpm installed **three** copies of `@wordpress/blocks` (15.13.1, 15.27.0, 16.2.0), plus newer components and block-editor packages. `registerCoreBlocks()` would then register into a different store from the one we serialize with, and pull in post-7.0 code. With overrides, each `@wordpress/*` package resolves to exactly one version.
- **When the seed's WordPress changes:** take every `@wordpress/*` name in the lockfile, read its `npm view <pkg> dist-tags --json`'s `wp-X.Y` value, rewrite `overrides` (`pnpm config set --location project overrides '<json>' --json`), and bump the two direct deps. The seed has **no Gutenberg plugin**; if one is ever activated, pin to that plugin's package versions instead.

## 4. What `rawHandler` does by itself (notes for later milestones)

| Input | `rawHandler` alone | Now / later |
|---|---|---|
| `<h1>` | `core/heading` level 1 | `demoteH1` option turns it into level 2 (PLAN §6.9) |
| `<img>` | `core/image`, `url` = `src` verbatim (relative stays relative); drops width, height and srcset; `wp-image-N` becomes `id`; an `<img>` inside text stays an inline `<img>` in the paragraph's rich text | **M1:** after upload, rebuild image and cover blocks with `id`, `url` and `sizeSlug` through `createBlock`. Never regex the markup: `id` drives the `wp-image-N` class that `save()` emits. Inline images in rich text need rewriting too |
| Unknown markup (`div` wrappers, `dl`, `details`, forms, custom elements, `<audio>`, `<video>`) | wrappers and block-level unknowns become **one `core/html` block with the raw HTML, scripts and handlers included**; audio and video inside `<p>` stay raw in the paragraph | `rawHandler` is not a sanitizer. **M1** needs a real allowlist sanitizer before conversion and on `core/html` content; map `details` → `core/details` and audio/video → `core/audio`/`core/video` |
| Iframes | `core/html`, or raw inside a paragraph | handled (§1, fix 3); the allowlist lives in `convert.ts` |
| A URL alone on a line | `core/embed {url}` only | providers enriched; `/embed/` and `player.` URLs canonicalized |
| Classes | become the block's custom `className`, including Gutenberg-rendered `wp-block-*` and `is-style-*` classes | stripped, except alignment. **M1:** optionally map `is-style-*` to theme block styles |
| Inline styles | `text-align` becomes `style.typography.textAlign`; other block-level styles dropped; **kept** on inline `<span style>` and `<font>` | keep `text-align` only; unwrap span and font (bold spans lose their bold; `pasteHandler`'s span→strong logic could be borrowed) |
| `id` attributes | dropped (anchors lost) | **M1:** set `anchor` on headings that in-page `#links` target |
| `<table>` | `has-fixed-layout` always added (7.0 default); `colspan` and cell `text-align` kept; `<caption>` dropped; `figure.wp-block-table` becomes `core/html` | handled (§1, fix 7) |
| Shortcodes | `[gallery ids=…]` becomes `core/gallery` with *source* IDs; another shortcode alone in a `<p>` becomes `core/shortcode` | REST `content.rendered` already expands shortcodes, so this matters only if we read `content.raw` |
| Input that already has `<!-- wp:` delimiters | passed straight to `parse()` | if a source gives us raw block content, no conversion is needed |

Other gotchas:
- RichText attributes are `RichTextData` objects; use `String(x)`.
- `parse()` logs whole block-type objects to the console for every invalid block. The validator silences that and formats the issues itself.
- The jsdom document URL is `http://localhost/`. `rawHandler` reads attributes, not resolved `.href`, so relative URLs survive as written. **M1:** make every URL absolute against the source page before conversion, so the link map keys are unambiguous.
- `@wordpress/*` `exports` maps have no `types` condition. Types come from `src/wp-types.ts` (an import by path). Don't use tsconfig `paths` for this: tsx applies them at runtime and breaks `require`.
- `pnpm peers check` warns that `react-autosize-textarea` (from block-editor) wants React ≤16. This is harmless.

## 5. Validator (`validateSerialized`)

`validateSerialized` parses the markup like the editor and walks every block, inner blocks included. It reports:
- `invalid`: `isValid === false`, with `validationIssues` formatted.
- `deprecated`: valid only through a deprecation. Detected by re-running `validateBlock` against the current `save()`. The editor would rewrite these on save.
- `drift`: the block re-serializes differently because built-in fixes or migrations changed it.
- `freeform`: Classic block.
- `missing`: unregistered block type.

`core/html` is reported as a warning. `ok` means no errors and `serialize(parse(markup)) === markup`.

## 6. Performance (Apple M2, Node 22)

- **Cold start** (jsdom, `require` and `registerCoreBlocks`): **≈4.3–4.6 s**, heap ≈200 MB, once per process.
- **Per page, warm:**

  | Page body | Convert + serialize (median) | Validate |
  |---|---|---|
  | 2.5 KB | **≈19 ms** | ≈6 ms |
  | 25 KB | ≈150 ms | ≈54 ms |

  The first conversion in a process takes ≈60 ms (JIT warm-up).
- **What this means:** keep a long-lived converter in the worker and never spawn a process per page. Conversion is synchronous and uses one global DOM, so scale with worker processes, not async interleaving.

## 7. Saving the sample post to the local seed (WP 7.0.4): PASS

`pnpm --filter @wm/e2e exec tsx --env-file=../.env editor-check.ts` (`e2e/editor-check.ts`):
1. Saves `snapshots/blocks/sample-post.html` as a post through `POST /wp/v2/posts` (admin Application Password).
2. Checks that `content.raw` matches the file byte for byte.
3. Logs in with Playwright (Chromium) and opens the post in the block editor.
4. Reads the editor's own store: `isValid` on every block, `.block-editor-warning` in the canvas, `core/missing`, and whether the post is dirty on open.

Result, the same on two consecutive runs:

```
storedExactly: true   blocks: 47   invalid: []   warnings: 0   missing: 0   dirtyOnOpen: false
names: button, buttons, column, columns, cover, embed, group, heading, image, list, list-item,
       paragraph, preformatted, quote, separator, table
PASS
```

A screenshot is written to `snapshots/editor-check/editor.png`.

**With the seed's real settings (seed DB imported): FAIL, because blocks are disabled, not because they're invalid.** The seed's `disable-unused-block-editor-blocks` setting turns off `core/cover`, `core/button`, `core/separator`, `core/preformatted`, `core/code`, `core/details`, `core/gallery`, `core/file`, `core/video`, `core/audio`, `core/pullquote` and others. The same post then has `invalid: []` but `missing: 5`: the editor shows "Your site doesn't include support for the "core/cover" block" for the cover, separator, preformatted block and both buttons.

Either the seed re-enables the blocks we use, or the converter only emits blocks the seed allows (preflight reads `dubeb_disabled_blocks`). This is waiting on a decision; see PLAN §3.

**Seed finding:** opening *any* post in the editor first gave "There has been a critical error". `wp-sheet-editor-media-library-premium` 1.10.1 calls `EnableMediaReplace\Replacer`, which Enable Media Replace 4.1.5 no longer has. The local setup skips that plugin. If both are active on the hosted seed, its post editor is broken too. Check this in M1 preflight.

Notes from before the check, still relevant:

- Regenerate it with `pnpm --filter @wm/blocks exec tsx scripts/sample-post.ts`. That writes `snapshots/blocks/sample-post.html` and exits non-zero if it is invalid.
- **Save as an administrator, so `unfiltered_html` applies.** Otherwise kses filters the markup, and any change makes blocks invalid. Use `wp post create … --user=<admin>` (WP-CLI without `--user` runs kses), or the REST API with an admin application password. Afterwards, `GET ?context=edit` and check that `content.raw` matches the file **byte for byte**.
- **The seed runs `disable-unused-block-editor-blocks`.** It calls `wp.blocks.unregisterBlockType` in the editor for every block in option `dubeb_disabled_blocks`. Check `wp option get dubeb_disabled_blocks --format=json`. The sample uses cover, columns, column, group, buttons, button, embed, table, quote, list, list-item, image, heading, paragraph, separator and preformatted. Any of these that is disabled will show as unsupported, which is a configuration problem, not a converter one. The seed also has **kadence-blocks(-pro)** and **block-visibility**, which may filter core blocks; the editor check is what catches that.
- **Expected harmless "unsaved changes" on open:**
  - The embed fetches oEmbed (this needs outbound network; offline it shows "could not embed" but the block is still valid).
  - The cover may compute `isDark` from the image.

  Neither is a validation failure. Look for "This block contains unexpected or invalid content" and check the Code editor view.
- Images are WordPress.org sample photos (`s.w.org`), hotlinked; nothing needs uploading.
- No block needs extra attributes. Embed and cover attributes already match what the editor sets (embed: `type`, `providerNameSlug`, `responsive` and `className: "wp-embed-aspect-16-9 wp-has-aspect-ratio"`; cover: `dimRatio: 50`, `layout: constrained`).

## 8. Recommendations for `packages/blocks` in M1

1. Keep this design: our normalize, then `rawHandler`, then our tidy, plus `createBlock` builders for structure that the extractor detects (hero → cover, rows → columns, button links → buttons, accordions → details, image grids → gallery). The `.hero`, `.row` and `.btn` mapping in `scripts/sample-post.ts` belongs in `packages/extractor`.
2. Replace the spike's DOM normalization with a real allowlist sanitizer (PLAN §8), shared with `core/html` content. Count every `core/html` as a warning in the report.
3. Media and links: operate on the `Block[]` tree (or re-parse it) and rebuild blocks with `createBlock`; never edit serialized markup with regex.
4. Preflight: intersect the block names we emit with the seed's registered *and enabled* blocks (`/wp/v2/block-types` plus `dubeb_disabled_blocks`).
5. Register Node-side stubs (`save: () => null`) for plugin blocks we emit (forms plugin, M2), so validation doesn't report them as `missing`.
6. Post-save verification: compare `content.raw` with what we sent, then run `validateSerialized` on it. Also run `e2e/editor-check.ts`'s real-editor check on a sample of pages per run (one per template / block mix).
7. Once the editor check passes, add **human-reviewed** golden outputs for the fixture corpus (PLAN §9), so package upgrades show up as diffs.
