import type { Cheerio, CheerioAPI, load } from 'cheerio';
import type { PageKind, SnapshotPage } from '@wm/core';
import type { SiteProfile } from '@wm/crawler';

/** A DOM node (cheerio doesn't re-export domhandler's types). */
export type AnyNode = Exclude<Parameters<typeof load>[0], string | Buffer | unknown[]>;
export type Nodes = Cheerio<AnyNode>;

/** A snapshot page about to be extracted, addressed by its final (post-redirect) URL. */
export interface PageRef {
  /** Final URL: the base for relative links. */
  url: URL;
  /** sourceKey of `url`. */
  key: string;
  snapshot: SnapshotPage;
  /** Parses the saved HTML (not cached: parse once, use, drop). */
  load(): Promise<CheerioAPI>;
}

export interface ExtractContext {
  origin: string;
  /** The scan profile's URL rules (file URLs, same-site checks). */
  site: SiteProfile;
  /** The homepage's <title>, stripped from page titles ("Help Center - Site Name" → "Help Center"). */
  siteName: string;
}

/** What a platform profile reads from one page before the shared cleanup. */
export interface PageParts {
  title: string;
  /** ISO date (YYYY-MM-DD) for dated items. */
  date: string | null;
  categories: string[];
  /** Absolute URL of the section parent (section nav, breadcrumbs), if the page shows one. */
  parentUrl: string | null;
  /** Label of that section parent; a meeting-section signal for classification. */
  sectionTitle: string | null;
  /** Raw HTML of the main content with the page title and date header already removed. */
  contentHtml: string;
}

export interface KindMatch {
  kind: PageKind;
  /** Rule name, shown to the plan's reviewers. */
  reason: string;
}

/** Content selectors and URL patterns of one source platform. */
export interface ExtractProfile {
  name: string;
  /** One pass over the job's pages before extraction, for facts that span pages (categories, boilerplate). */
  prepare(pages: PageRef[], ctx: ExtractContext): Promise<void>;
  read(page: PageRef, $: CheerioAPI, ctx: ExtractContext): PageParts;
  /** Platform URL rules for kind; checked after `home` and before the shared content rules. */
  kindByUrl(url: URL): KindMatch | undefined;
  /** Platform-specific warnings about the cleaned content. */
  warnings?(content: CheerioAPI, ctx: ExtractContext): string[];
}
