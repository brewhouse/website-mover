import type { DocumentRecord, PageKind, SnapshotFile } from '@wm/core';
import { cleanText, findDates } from './text.js';

/** A link to the file from a source page. */
export interface DocumentLink {
  text: string;
  pageKey: string;
  pageTitle: string;
  pageKind: PageKind;
  /** How many library documents that page links. */
  pageDocuments: number;
}

/**
 * The resource_type terms (the framework's Document Directory filter). A short controlled list
 * that covers what a housing authority publishes: the board's paperwork (Agenda, Minutes,
 * Notice, Resolution, Packet, Presentation), governing documents (Policy: policies, the ACOP,
 * the dwelling leases and resident agreements; Plan: annual, five-year and administrative plans), finance (Budget,
 * Audit, Report), resident and landlord paperwork (Form), reference schedules (Schedule:
 * payment standards, utility allowances, charge and meeting schedules), outreach (Newsletter,
 * Flyer) and Map. Anything else is Other, for a person to re-file.
 *
 * Order matters: the first rule that matches wins, so "Finance and Audit Committee Agenda" is an
 * Agenda, "Form_Notice of Intent to Vacate" a Form, and "Public Notice for Admin Plan" a Notice.
 */
const DOCUMENT_TYPES: { type: string; re: RegExp }[] = [
  { type: 'Resolution', re: /\bresolutions?\b/i },
  { type: 'Minutes', re: /\bminutes\b|\btranscripts?\b/i },
  { type: 'Agenda', re: /\bagendas?\b/i },
  { type: 'Form', re: /\bforms?\b|\bapplications?\b/i },
  { type: 'Notice', re: /\bnotices?\b/i },
  { type: 'Packet', re: /\bpackets?\b/i },
  { type: 'Presentation', re: /\bpresentations?\b|\bslides\b/i },
  { type: 'Audit', re: /\baudits?\b/i },
  { type: 'Budget', re: /\bbudgets?\b/i },
  { type: 'Report', re: /\breports?\b|\bbalance sheet\b/i },
  { type: 'Policy', re: /\bpolic(?:y|ies)\b|\bacop\b|\badmissions and continued occupancy\b|\b(?:ph|housing|dwelling|income) lease\b|\blease agreement\b|\bagreements?\b/i },
  { type: 'Plan', re: /\bplans?\b|\bconplan\b/i },
  { type: 'Map', re: /\bmaps?\b/i },
  { type: 'Newsletter', re: /\bnewsletters?\b|\bnews\b/i },
  { type: 'Flyer', re: /flyer|brochure/i },
  { type: 'Schedule', re: /\bschedules?\b|\bpayment standards?\b|\butility (?:allowances?|charts?|comparison)\b|\bUAs?\b/i },
];
const OTHER = 'Other';

/**
 * Types a linking page's title may give its files when neither the filename nor the link says:
 * a list page named for what it lists ("Meeting Minutes", "HCV Forms", "Performance Reports"),
 * or a page whose only file is its printable version ("… Meeting Public Notice").
 */
const PAGE_TITLE_TYPES = new Set(['Minutes', 'Agenda', 'Notice', 'Form', 'Report']);
const LIST_TITLE = /\b(minutes|agendas|notices|forms|reports)$/i;
/** Not the adopted version: kept out of Key Documents. ("Propsed" is how one source file spells it.) */
const DRAFT = /\b(draft|proposed|propsed)\b/i;
/** Pages that put a document out for public comment: what they link is a proposal. */
const FOR_COMMENT = /\bcomments?\b/i;
/** The source's own key-documents page. */
const KEY_DOCUMENTS_PAGE = /^plans? (and|&) polic(y|ies)$/i;

/** Filename without extension, underscores as spaces, for matching words. */
function words(text: string): string {
  return cleanText(text.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_+/g, ' '));
}

/** The first type whose rule matches, and the words that matched. */
function typeOf(text: string): { type: string; matched: string } | undefined {
  for (const t of DOCUMENT_TYPES) {
    const m = text.match(t.re);
    if (m) return { type: t.type, matched: m[0] };
  }
  return undefined;
}

/**
 * Type, library and date for one library file, from its filename, the text of the links to
 * it, and the titles of the pages that link it.
 *
 * - type: the filename's words first (they name the file itself), then the link texts, then a
 *   linking page's title (list pages and single-file pages, see PAGE_TITLE_TYPES); else Other.
 * - library: "Bills & Resolutions" for resolutions, "Maps" for maps, "Key Documents" for files
 *   on the Plans and Policies page and for other plans and policies unless they are drafts or
 *   proposals (the name says draft/proposed, or only public-comment pages link them).
 * - date: a full date stated by the link text, else by the filename. Several different dates in
 *   the same place (a range, "eff. 6.1.22 for Website 5.21.22") are not explicit: no date.
 */
export function classifyDocument(file: SnapshotFile, links: DocumentLink[]): DocumentRecord {
  const reasons: string[] = [];
  const filename = file.filename ?? '';
  const texts = [...new Set(links.map((l) => cleanText(l.text)).filter(Boolean))];

  // Type.
  let type: string | null = null;
  const byFile = filename ? typeOf(words(filename)) : undefined;
  if (byFile) {
    type = byFile.type;
    reasons.push(`type ${type}: filename "${filename}" says "${byFile.matched}"`);
  }
  if (!type) {
    for (const text of texts) {
      const byText = typeOf(words(text));
      if (byText) {
        type = byText.type;
        reasons.push(`type ${type}: link text "${text}" says "${byText.matched}"`);
        break;
      }
    }
  }
  if (!type) {
    for (const link of links) {
      const byPage = typeOf(link.pageTitle);
      const applies = link.pageDocuments === 1 || LIST_TITLE.test(cleanText(link.pageTitle));
      if (byPage && applies && PAGE_TITLE_TYPES.has(byPage.type)) {
        type = byPage.type;
        reasons.push(`type ${type}: linked from ${link.pageKind} "${link.pageTitle}", which says "${byPage.matched}"`);
        break;
      }
    }
  }
  if (!type) {
    type = OTHER;
    reasons.push('type Other: no rule matched the filename, link text or linking page');
  }

  // Library.
  let library: DocumentRecord['library'] = null;
  const keyPage = links.find((l) => KEY_DOCUMENTS_PAGE.test(cleanText(l.pageTitle)));
  const draft = [filename, ...texts].find((t) => DRAFT.test(t));
  if (type === 'Resolution') {
    library = 'Bills & Resolutions';
    reasons.push('library Bills & Resolutions: a resolution');
  } else if (type === 'Map') {
    library = 'Maps';
    reasons.push('library Maps: a map');
  } else if (keyPage) {
    library = 'Key Documents';
    reasons.push(`library Key Documents: listed on "${keyPage.pageTitle}"`);
  } else if (type === 'Policy' || type === 'Plan') {
    const forComment = links.length > 0 && links.every((l) => FOR_COMMENT.test(l.pageTitle)) ? links[0]! : undefined;
    if (draft) reasons.push(`library none: "${draft}" is a draft or proposal`);
    else if (forComment) reasons.push(`library none: put out for comment by "${forComment.pageTitle}"`);
    else {
      library = 'Key Documents';
      reasons.push(`library Key Documents: an adopted ${type.toLowerCase()}`);
    }
  }

  // Date.
  let date: string | null = null;
  const textDates = [...new Set(texts.flatMap((t) => findDates(t)))];
  const fileDates = findDates(filename.replace(/\.[a-z0-9]{2,5}$/i, ''));
  if (textDates.length === 1) {
    date = textDates[0]!;
    reasons.push(`date ${date}: stated by the link text`);
  } else if (textDates.length > 1) {
    reasons.push(`date none: the link text states several dates (${textDates.join(', ')})`);
  } else if (fileDates.length === 1) {
    date = fileDates[0]!;
    reasons.push(`date ${date}: stated by the filename`);
  } else if (fileDates.length > 1) {
    reasons.push(`date none: the filename states several dates (${fileDates.join(', ')})`);
  }
  if (date) {
    // A meeting page's title may disagree (minutes linked from a later meeting, or a typo): flag it.
    for (const link of links) {
      const titleDates = findDates(link.pageTitle);
      if (titleDates.length === 1 && titleDates[0] !== date) {
        reasons.push(`check: linking ${link.pageKind} "${link.pageTitle}" states ${titleDates[0]}`);
      }
    }
  }

  return { url: file.url, type, library, date, reasons };
}

/** Library documents: downloaded, non-image files. */
export function isLibraryDocument(file: SnapshotFile): boolean {
  return file.status === 200 && !!file.path && !file.contentType.toLowerCase().startsWith('image/');
}
