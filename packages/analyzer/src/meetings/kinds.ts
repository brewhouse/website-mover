import type { MeetingRecord } from '@wm/core';

export interface MeetingKind {
  /** Readable normalized name (MeetingRecord.kind). */
  name: string;
  type: MeetingRecord['type'];
  /** The Events Calendar category. */
  category: string;
  /** Rule name, for reasons. */
  rule: string;
  test: RegExp;
  /** The kind does not apply when this also matches ("Monthly Meeting and Workshop" is a regular meeting). */
  unless?: RegExp;
}

export const BOARD_MEETINGS = 'Board Meetings';
const COMMITTEE = 'Committee Meetings';

/**
 * Most specific first: a committee notice also names the Board of Commissioners, and a shade
 * meeting notice names collective bargaining.
 */
export const KINDS: MeetingKind[] = [
  { rule: 'shade', name: 'Board of Commissioners Shade Meeting', type: 'special', category: BOARD_MEETINGS, test: /\bshade?\s+meeting|attorney[- ]client|executive session/i },
  { rule: 'union', name: 'Collective Bargaining Negotiations', type: 'union', category: 'Union Negotiations', test: /collective\s+bargaining|union\s+negotiation|\bunion\b|\bAF?SC?M?CE\b|\bIAPPE\b/i },
  { rule: 'rab', name: 'Resident Advisory Board Meeting', type: 'other', category: 'Resident Meetings', test: /resident advisory board|\bRAB\b/i },
  { rule: 'town-hall', name: 'Community Town Hall Meeting', type: 'other', category: 'Resident Meetings', test: /town\s*hall/i },
  { rule: 'hearing', name: 'Public Hearing', type: 'hearing', category: 'Public Hearings', test: /public\s+hearing/i },
  { rule: 'bpaal', name: 'BPAAL Board Meeting', type: 'regular', category: BOARD_MEETINGS, test: /\bBPAAL\b|brentwood\s+park\s+apartment/i },
  { rule: 'executive-search', name: 'Executive Search Committee Meeting', type: 'committee', category: COMMITTEE, test: /executive\s+(?:management\s+)?search|\bCEO\b.{0,40}\bsearch|search\s+committee/i },
  { rule: 'hr-finance', name: 'Human Resources and Finance Committee Meeting', type: 'committee', category: COMMITTEE, test: /(?:human\s+resources|\bHR)\s+(?:and|&)\s+finan/i },
  { rule: 'finance', name: 'Finance Committee Meeting', type: 'committee', category: COMMITTEE, test: /\bfinan|\baudit\s+committee/i },
  { rule: 'hr', name: 'Human Resources Committee Meeting', type: 'committee', category: COMMITTEE, test: /human\s+resources|\bHR\b/i },
  { rule: 'governance', name: 'Governance Committee Meeting', type: 'committee', category: COMMITTEE, test: /governance/i },
  { rule: 'resident-relations', name: 'Resident Relations Committee Meeting', type: 'committee', category: COMMITTEE, test: /(?:resident|tenant)\s+relations/i },
  { rule: 'acquisition', name: 'Acquisition Committee Meeting', type: 'committee', category: COMMITTEE, test: /acquisition/i },
  { rule: 'asset-management', name: 'Asset Management Committee Meeting', type: 'committee', category: COMMITTEE, test: /\basset\b/i },
  { rule: 'cost-admin', name: 'Cost and Administration Committee Meeting', type: 'committee', category: COMMITTEE, test: /cost\s*(?:&|and)\s*adm/i },
  { rule: 'ethics-training', name: 'Board of Commissioners Ethics Training', type: 'workshop', category: BOARD_MEETINGS, test: /ethics\s+training/i },
  { rule: 'retreat', name: 'Board of Commissioners Retreat', type: 'workshop', category: BOARD_MEETINGS, test: /\bretreat\b/i },
  { rule: 'workshop', name: 'Board of Commissioners Workshop', type: 'workshop', category: BOARD_MEETINGS, test: /workshop/i, unless: /monthly|regular|special/i },
  { rule: 'emergency', name: 'Board of Commissioners Emergency Meeting', type: 'special', category: BOARD_MEETINGS, test: /\bemergency\b/i },
  { rule: 'special', name: 'Board of Commissioners Special Meeting', type: 'special', category: BOARD_MEETINGS, test: /\bspecial\s+(?:\w+\s+){0,4}(?:meeting|session)|\bspecial\b.{0,30}\b(?:board|BOC)\b|\b(?:board|BOC)\b.{0,30}\bspecial\b/i },
  {
    rule: 'board',
    name: 'Board of Commissioners Meeting',
    type: 'regular',
    category: BOARD_MEETINGS,
    test: /\b(?:board|BOC|commissioners?)\b.{0,80}\b(?:meetings?|minutes|agenda|notice)\b|\b(?:regular|monthly)\s+meeting\b/i,
  },
];

export const REGULAR_BOARD = KINDS.at(-1)!;

export function detectKind(text: string): MeetingKind | null {
  const t = text.replace(/_/g, ' '); // filenames: "1-24-25_JHA_BOC_HR_Committee_Meeting.pdf"
  return KINDS.find((k) => k.test.test(t) && !k.unless?.test(t)) ?? null;
}

/** A joint meeting takes items addressed to either of its committees (separate HR and finance agendas). */
export function coveredBy(kind: MeetingKind, meeting: MeetingKind): boolean {
  return kind === meeting || (meeting.rule === 'hr-finance' && (kind.rule === 'hr' || kind.rule === 'finance'));
}

export function kindSlug(kind: MeetingKind): string {
  return kind.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
