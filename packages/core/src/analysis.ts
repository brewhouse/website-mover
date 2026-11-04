/**
 * Output of the analyze stage (M2): structured records the planner turns into events, people,
 * forms, custom-type entries and tables. Written to the job directory under analyze/.
 *
 * Every text value is copied verbatim from the source (trimmed, whitespace collapsed); the
 * analyzer never invents or rewrites content. Values it derives (dates, times, kinds) carry the
 * rule that produced them in `reasons`.
 */

export type DocumentRole = 'agenda' | 'minutes' | 'notice' | 'packet' | 'presentation' | 'resolution' | 'other';

/** analyze/meetings.json */
export interface MeetingAnalysis {
  meetings: MeetingRecord[];
  /** Meeting-section landing/index pages (e.g. "Meeting Minutes", "Past BOC Meetings"): migrated as ordinary pages. */
  indexPages: string[];
  /** Meeting pages the rules could not place (no date found, conflicting dates); listed in the plan for a person. */
  unresolved: { sourceKey: string; title: string; reason: string }[];
}

/** One meeting, merged from every source page and news item about it. */
export interface MeetingRecord {
  /** Stable id: "meeting:<date>:<kind slug>" (date "undated" when unknown). */
  key: string;
  /** Verbatim title of the primary source page. */
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM (24 h), site local time; null when the source gives no time. */
  startTime: string | null;
  endTime: string | null;
  /** Normalized kind, e.g. "Board of Commissioners Meeting", "Finance and Audit Committee Meeting". */
  kind: string;
  /** Regular / special / committee / hearing / workshop / union / other. */
  type: 'regular' | 'special' | 'committee' | 'hearing' | 'workshop' | 'union' | 'other';
  /** Event category to file it under (The Events Calendar), e.g. "Board Meetings", "Committee Meetings". */
  category: string;
  /** Verbatim location sentence or address, if stated. */
  location: string | null;
  /** True when the notice says the meeting was cancelled. */
  cancelled: boolean;
  /** Source pages merged into this meeting; the first is the primary (its content leads). */
  sourceKeys: string[];
  /** News items announcing it (they stay news posts and link to the event). */
  newsKeys: string[];
  documents: { href: string; text: string; role: DocumentRole }[];
  /** Recording URLs (YouTube etc.). */
  recordings: string[];
  confidence: 'high' | 'low';
  /** How date, time, kind and grouping were derived (rule names), for reviewers. */
  reasons: string[];
}

/** analyze/forms.json */
export interface FormAnalysis {
  forms: FormRecord[];
}

/** A web form found on a source page, as a plugin-neutral spec (the bridge's POST /forms body). */
export interface FormRecord {
  /** "<page source key>#form-<n>" */
  key: string;
  /** Source key of the page the form is on. */
  pageKey: string;
  /** 'form': rebuild in the forms plugin. 'subscription': an alerts/newsletter sign-up backed by a service (not rebuilt; flagged). 'login': never migrated. */
  kind: 'form' | 'subscription' | 'login';
  /** Verbatim form heading (or page title). */
  title: string;
  description: string | null;
  fields: FormField[];
  /** Labels of fields that collect government ids, bank/account numbers or similar. */
  sensitive: string[];
  /** The form accepts file uploads. */
  uploads: boolean;
  /** The source form has a CAPTCHA (rebuilt with the forms plugin's own). */
  captcha: boolean;
  /** How the source builds it: native <form>, jQuery formBuilder JSON, etc. */
  implementation: string;
  warnings: string[];
}

export interface FormField {
  label: string;
  type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'number' | 'date' | 'url' | 'name' | 'address' | 'file' | 'hidden' | 'section' | 'html';
  required: boolean;
  choices?: string[];
  placeholder?: string;
  description?: string;
  /** For 'html' and 'section' fields: verbatim text/markup. */
  content?: string;
}

/** analyze/records.json */
export interface RecordAnalysis {
  people: PersonRecord[];
  communities: CommunityRecord[];
  /** Tables assembled from many source pages (e.g. payment standards by ZIP code). */
  tables: TableRecord[];
  /** Document type and library flags per file, from the linking pages and filenames. */
  documents: DocumentRecord[];
}

export interface PersonRecord {
  /** "person:<name slug>" */
  key: string;
  /** Source key of the page listing them. */
  pageKey: string;
  group: 'board' | 'staff';
  name: string;
  /** Role/title as written ("Chair", "Commissioner", "President/CEO"). */
  role: string | null;
  email: string | null;
  phone: string | null;
  /** Image URL (absolute, source). */
  photo: string | null;
  bio: string | null;
  /** Position on the source page (0-based). */
  order: number;
}

export interface CommunityRecord {
  sourceKey: string;
  title: string;
  /** Labeled values as shown on the source ("Address" → "1300 N Broad St"), labels verbatim. */
  fields: Record<string, string>;
  /** Type shown on the source listing (e.g. "Project-Based Voucher", "Rental", "Office"). */
  type: string | null;
  photo: string | null;
  lat: number | null;
  lng: number | null;
  /** Main content HTML (absolute URLs), for the entry body. */
  contentHtml: string;
}

export interface TableRecord {
  /** e.g. "payment-standards" */
  key: string;
  title: string;
  /** Source pages the rows came from; each gets a redirect to the table page. */
  sourceKeys: string[];
  columns: string[];
  rows: string[][];
  /** Verbatim notes shown with the table (effective date, footnotes). */
  notes: string[];
}

export interface DocumentRecord {
  /** Canonical file URL (as in SnapshotFile.url). */
  url: string;
  /** resource_type term for the framework's Document Directory (e.g. "Agenda", "Minutes", "Policy", "Form", "Report"). */
  type: string | null;
  /** The seed's "library_select" choice, when one fits: "Key Documents", "Bills & Resolutions", "Maps". */
  library: 'Key Documents' | 'Bills & Resolutions' | 'Maps' | null;
  /** YYYY-MM-DD when the filename or link text states a date. */
  date: string | null;
  reasons: string[];
}

/** analyze/site.json: the site's shared structure (navigation, contact details, homepage), M3. */
export interface SiteAnalysis {
  /** Organization/site name as the source writes it (e.g. "Jacksonville Housing"). */
  siteName: string | null;
  menus: {
    /** Utility bar above the header. */
    top: NavLink[];
    /** Primary navigation, with dropdown children. */
    main: NavLink[];
    /** Footer links (site map, accessibility, ...). */
    footer: NavLink[];
    /** Social profiles. */
    social: NavLink[];
    /** Other link lists shown site-wide (e.g. "Industry Links"). */
    explore: NavLink[];
    /** Links shown with the footer's contact details (e.g. "Staff Module"). Newer than the first M3 analyses. */
    contact?: NavLink[];
  };
  /**
   * The side (section) navigation inner pages show: each section page with the links listed under it,
   * gathered from every scanned page, in source order. The plan can add them to the main menu as
   * dropdowns (job option "side navigation in the main menu"). Absent in analyses made before it.
   */
  sectionNav?: { parent: NavLink; children: NavLink[] }[];
  /** The heading over the `explore` links, verbatim (e.g. "Industry Links"). Newer than the first M3 analyses. */
  exploreHeading?: string | null;
  /** The alt text of the icons beside the footer notices (e.g. "Equal Housing Opportunity"). Newer than the first M3 analyses. */
  footerIcons?: string[];
  /** `hours` keeps the source's line breaks as newlines. */
  contact: { address: string | null; phone: string | null; email: string | null; fax: string | null; hours: string | null };
  /** Statements shown on every page's footer (e.g. fair-housing notices), verbatim: text, HTML-escaped, with a bold opening phrase kept as <strong>. */
  footerNotices: string[];
  home: {
    /** Homepage slideshow / hero slides. */
    slides: { title: string; subtitle: string | null; link: string | null; image: string | null; alt: string }[];
    /** Link tiles shown under the slideshow (quick links). */
    buttons: NavLink[];
    /** The introduction (mission, programs) as HTML paragraphs, verbatim with absolute links. Newer than the first M3 analyses. */
    intro?: string | null;
  };
}

export interface NavLink {
  label: string;
  /** Absolute URL. */
  href: string;
  children?: NavLink[];
}
