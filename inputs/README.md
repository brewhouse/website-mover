# Inputs

Client and framework files go here. Everything in this folder except this README is gitignored, so it may hold confidential files.
Credentials (passwords, license keys) go in `.env`, never here.

```
inputs/
  framework/              Planeteria framework
  jha/
    style-guide.pdf       JHA brand style guide
    logos/                logo files
    fonts/                licensed font files (only if the brand uses commercial fonts)
    sitemap.xlsx          approved sitemap (.csv also fine)
    priority-urls.csv     optional: top pages export
    jaxha-export.xml      optional: WordPress export of jaxha.org
```

## Framework (`inputs/framework/`)

**Needed for M0**
- The theme folder exactly as it sits in `wp-content/themes/`: the parent theme and any child theme. A folder or a zip is fine.
- Any plugins the framework depends on (zips), or a list with versions. Include Planeteria-specific plugins and mu-plugins, and say whether it needs ACF Pro or a page builder.

**Helpful**
- The URL of a finished site built on the framework, ideally another housing authority, so we can see what "done" looks like.
- Any framework docs, a component list, or design files (e.g. Figma).
- A theme-options export, if the framework has an options panel that can export settings.

**Needed from M1, in `.env`**
- `SEED_URL`, `SEED_USER`, `SEED_APP_PASSWORD`: the blank seed site, plus an admin Application Password (Users → Profile → Application Passwords).
- `ACF_PRO_LICENSE`, if the framework uses ACF Pro.
- Where the seed is hosted (e.g. Pantheon) and whether that environment is password-locked.

## JHA (`inputs/jha/`)

**Needed for M0**
- `style-guide.pdf`: the brand style guide.

**Needed by M3**
- `sitemap.xlsx` or `.csv`: the approved sitemap. Columns: page title, parent page, URL path (if decided), notes. If it only exists as a PDF or image, add it as-is and we'll convert it.
- `logos/`: SVG and PNG versions (full colour, reversed/white, icon) if you have them. Otherwise the logo is pulled from the style guide.
- `fonts/`: licensed font files, only if the brand uses commercial fonts. Free fonts such as Google Fonts are fetched automatically.

**Optional**
- `priority-urls.csv`: a top-pages export from Google Analytics or Search Console. Used to rank which old URLs get 301 redirects first.
- `jaxha-export.xml`: from jaxha.org admin, Tools → Export → All content. It includes raw content and custom fields that the public API hides.
- GA4 measurement ID (`G-…`). Add it to `.env` as `GA4_MEASUREMENT_ID`.
- Content rules: pages to leave out, a cutoff date for archiving old documents, which forms are still in use. A short `notes.md` is fine.
