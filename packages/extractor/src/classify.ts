import type { ExtractProfile, KindMatch } from './profiles/types.js';

/**
 * Meeting-related wording (from the M0 inventory): agendas, minutes, board and
 * committee meetings, public notices, hearings, workshops, retreats. "Workshops"
 * doesn't match (the landlord-workshop page isn't a meeting).
 */
export const MEETING_RE = /\b(meetings?|minutes|agenda|public notice|retreat|workshop|hearing|town hall)\b/i;

export interface KindInput {
  url: URL;
  title: string;
  /** Section parent label (BJM section nav, breadcrumbs). */
  sectionTitle: string | null;
  wordCount: number;
  /** Words outside <form> elements. */
  wordsOutsideForms: number;
  forms: number;
  media: number;
  documents: number;
}

/** A page whose content is a form plus a short intro is a form shell. */
const FORM_SHELL_MAX_WORDS = 80;

/**
 * Kind rules, first match wins. The match's `reason` is the rule name.
 *
 *  1. home             site root without a query                         → home
 *  2. platform rules   the profile's URL patterns (BJM: news items → post;
 *                      news, press list, calendar, community map/list
 *                      → listing; community and ZIP pages → record; site map,
 *                      search, sign-up, alerts, staff login → utility)
 *  3. meeting-title    title matches MEETING_RE                           → meeting
 *     meeting-url      URL path words match MEETING_RE                    → meeting
 *     meeting-section  section parent label matches MEETING_RE            → meeting
 *                      (posts stay posts: rule 2 runs first)
 *  4. form-shell       a form and fewer than 80 words outside it          → utility
 *  5. empty-content    no words, images, embeds or documents              → utility
 *  6. default                                                             → page
 */
export function classify(input: KindInput, profile: ExtractProfile): KindMatch {
  const { url } = input;
  if ((url.pathname === '/' || url.pathname === '') && !url.search) return { kind: 'home', reason: 'home' };

  const byUrl = profile.kindByUrl(url);
  if (byUrl) return byUrl;

  if (MEETING_RE.test(input.title)) return { kind: 'meeting', reason: 'meeting-title' };
  const pathWords = safeDecode(url.pathname).replace(/[-_/.,()]+/g, ' ');
  if (MEETING_RE.test(pathWords)) return { kind: 'meeting', reason: 'meeting-url' };
  if (input.sectionTitle && MEETING_RE.test(input.sectionTitle)) return { kind: 'meeting', reason: 'meeting-section' };

  if (input.forms > 0 && input.wordsOutsideForms < FORM_SHELL_MAX_WORDS) return { kind: 'utility', reason: 'form-shell' };
  if (input.wordCount === 0 && input.media === 0 && input.documents === 0) return { kind: 'utility', reason: 'empty-content' };
  return { kind: 'page', reason: 'default' };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
