/**
 * Data passed between pipeline stages. Each stage writes its output into the job
 * directory (see jobs.ts) and the next stage reads it, so stages can be re-run
 * independently.
 *
 *   scan     → snapshot/pages.jsonl, snapshot/files.jsonl (+ raw HTML and file bodies)
 *   extract  → extract/pages.jsonl
 *   plan     → plan/plan.v<N>.json
 *   approve  → plan/approval.json
 *   execute  → run/entities.json, run/events.jsonl
 *   report   → report/*
 */

/** `job.json`: what the scan was run against. */
export interface JobInfo {
  id: string;
  origin: string;
  /** Site profile name (e.g. "bjm", "generic"). */
  profile: string;
  scannedAt: string;
}

/** One fetched HTML URL. */
export interface SnapshotPage {
  /** URL as discovered (absolute). */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  fetchedAt: string;
  /** Path of the raw HTML, relative to the job directory; null when there is no body. */
  html: string | null;
  /** How the URL was found: 'seed', 'sitemap', 'site-map', 'link', 'profile' (profile-specific seeds), 'redirect' (a redirect target nothing else links to). */
  via: string;
}

/** One file (document or image) found on the source. */
export interface SnapshotFile {
  url: string;
  finalUrl: string;
  status: number;
  /** MIME type implied by the filename when the server sends a generic one (BJM sends Word files as application/octet-stream). */
  contentType: string;
  /** From Content-Disposition, else the URL path; null when neither gives one (BJM images). */
  filename: string | null;
  bytes: number;
  sha256: string | null;
  /** Path of the downloaded body, relative to the job directory; null if not downloaded. */
  path: string | null;
  /** Source keys of pages that link to or embed it. Empty for files found only by an id sweep. */
  referencedBy: string[];
}

export type PageKind =
  /** Ordinary content page. */
  | 'page'
  /** Dated news item / article. */
  | 'post'
  /** A listing of other items (news index, archive); replaced by a template, not migrated as content. */
  | 'listing'
  /** Board/committee meeting page or notice (structured in M2). */
  | 'meeting'
  /** Structured record pages the analyzer may turn into a custom type (e.g. communities). */
  | 'record'
  /** The homepage (rebuilt from the template's fields, not migrated as a page). */
  | 'home'
  /** Search, login, sign-up, site map, calendar shells and similar. */
  | 'utility';

/** Main content and metadata of one source page, cleaned of site chrome. */
export interface ExtractedPage {
  sourceKey: string;
  url: string;
  kind: PageKind;
  /** Why it got that kind (rule name), for the plan's reviewers. */
  kindReason: string;
  title: string;
  /** Source slug if the URL has a usable one (e.g. "hcv-landlords"); null for id-only URLs. */
  slug: string | null;
  /** ISO date (YYYY-MM-DD) for dated items. */
  date: string | null;
  categories: string[];
  /** Source key of the section parent (from breadcrumbs / section nav), if any. */
  parentKey: string | null;
  /** Main content HTML with the page title removed and every URL made absolute. */
  contentHtml: string;
  wordCount: number;
  /** Other http(s) links (not files). mailto: and tel: links are in neither list. */
  links: { href: string; text: string }[];
  images: { src: string; alt: string }[];
  /** Links to files: every file-library link (images included) and document-extension links on any host. */
  documents: { href: string; text: string }[];
  /** Things a reviewer should know (empty content, dead links, embedded forms, ...). */
  warnings: string[];
}
