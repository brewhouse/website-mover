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
    source-export/        optional: content export from jaxha.org's CMS vendor (BJM)
```

## Framework

**Needed for M0**
- **Preferred:** a local git clone of the seed site's Pantheon repo. Set `SEED_CODE_PATH` in `.env` to its path. It already holds the theme(s) and plugins, so nothing needs copying here. Treat it as read-only.
- **Otherwise:** put the theme folder(s) from `wp-content/themes/` and the plugins they depend on in `inputs/framework/`.

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
- `source-export/`: a content export from Brooks Jeffrey Marketing (jaxha.org's CMS vendor), if they'll provide one: pages with ids and parents, news with dates and categories, files with upload dates and original names. It fills gaps the crawl can't see.
- GA4 measurement ID (`G-…`). Add it to `.env` as `GA4_MEASUREMENT_ID`.
- Content rules: pages to leave out, a cutoff date for archiving old documents, which forms are still in use. A short `notes.md` is fine.
