import { readFile } from 'node:fs/promises';
import {
  jobPath,
  readJsonl,
  sourceKey,
  writeJson,
  type CommunityRecord,
  type DocumentRecord,
  type ExtractedPage,
  type PersonRecord,
  type RecordAnalysis,
  type SnapshotFile,
  type SnapshotPage,
  type TableRecord,
} from '@wm/core';
import { parseCommunity, parseCommunityListing, parseMapCoordinates, type ListingEntry } from './records/communities.js';
import { classifyDocument, isLibraryDocument, type DocumentLink } from './records/documents.js';
import { parsePeople } from './records/people.js';
import { assembleZipTable, isZipMapPage, isZipPage } from './records/tables.js';

/** Pages that list the board, and pages that list senior staff one per paragraph (by source slug). */
const BOARD_PAGES = /^board-(of-(commissioners|directors)|members)$/;
const STAFF_PAGES = /^(senior-management|leadership(-team)?|executive-(team|staff))$/;
const COMMUNITY_DETAIL = /^\/locations\/detail\/\d+$/;

/**
 * People, communities, assembled tables and document types from a job's extract and snapshot;
 * writes analyze/records.json. Everything is rule-based and verbatim (see each helper).
 */
export async function analyzeRecords(jobId: string, log: (msg: string) => void = () => {}): Promise<RecordAnalysis> {
  const pages = await readJsonl<ExtractedPage>(jobPath(jobId, 'extract', 'pages.jsonl'));
  const snapshotPages = await readJsonl<SnapshotPage>(jobPath(jobId, 'snapshot', 'pages.jsonl'));
  const files = await readJsonl<SnapshotFile>(jobPath(jobId, 'snapshot', 'files.jsonl'));
  const path = (page: ExtractedPage) => new URL(page.url).pathname.toLowerCase();

  // People: board first, then staff; one record per person (first listing wins, later ones fill gaps).
  const people: PersonRecord[] = [];
  const byPersonKey = new Map<string, PersonRecord>();
  const peoplePages = [
    ...pages.filter((p) => p.kind === 'page' && p.slug && BOARD_PAGES.test(p.slug)).map((p) => ({ page: p, group: 'board' as const })),
    ...pages.filter((p) => p.kind === 'page' && p.slug && STAFF_PAGES.test(p.slug)).map((p) => ({ page: p, group: 'staff' as const })),
  ];
  for (const { page, group } of peoplePages) {
    const found = parsePeople(page.contentHtml, page.sourceKey, group);
    log(`people: ${found.length} on ${page.sourceKey}`);
    for (const person of found) {
      const earlier = byPersonKey.get(person.key);
      if (!earlier) {
        byPersonKey.set(person.key, person);
        people.push(person);
        continue;
      }
      log(`people: ${person.name} is also on ${person.pageKey} (as "${person.role}"); kept the ${earlier.pageKey} entry`);
      earlier.email ??= person.email;
      earlier.phone ??= person.phone;
      earlier.photo ??= person.photo;
      earlier.bio ??= person.bio;
    }
  }

  // Communities: detail pages, with type and photo from the list view and positions from the map view.
  const listingPage = pages.find((p) => path(p) === '/locations/list');
  const listing = listingPage ? parseCommunityListing(listingPage.contentHtml) : new Map<string, ListingEntry>();
  const mapSnapshot = snapshotPages.find((s) => s.html && s.status === 200 && sourceKey(s.finalUrl).endsWith('/locations/map'));
  const coords = mapSnapshot ? parseMapCoordinates(await readFile(jobPath(jobId, mapSnapshot.html!), 'utf8'), mapSnapshot.finalUrl) : new Map<string, { lat: number; lng: number }>();
  const communities: CommunityRecord[] = pages
    .filter((p) => p.kind === 'record' && COMMUNITY_DETAIL.test(path(p)))
    .map((p) => parseCommunity(p, listing.get(p.sourceKey), coords.get(p.sourceKey)));
  const listOrder = (c: CommunityRecord) => listing.get(c.sourceKey)?.order ?? Number.MAX_SAFE_INTEGER;
  communities.sort((a, b) => listOrder(a) - listOrder(b) || a.sourceKey.localeCompare(b.sourceKey, 'en', { numeric: true }));
  for (const c of communities) {
    if (!listing.has(c.sourceKey)) log(`communities: ${c.sourceKey} is not on the list view (no type)`);
    if (c.lat === null) log(`communities: ${c.sourceKey} has no map position`);
  }
  for (const key of listing.keys()) if (!communities.some((c) => c.sourceKey === key)) log(`communities: list view links ${key}, which wasn't extracted`);

  // Tables: the payment standards by ZIP code.
  const tables: TableRecord[] = [];
  const zip = assembleZipTable(
    pages.filter((p) => p.kind === 'record' && isZipPage(p)),
    pages.filter((p) => p.kind === 'record' && isZipMapPage(p)),
  );
  if (zip) {
    tables.push(zip.table);
    for (const a of zip.anomalies) log(`tables: ${a}`);
  }

  // Documents: every downloaded library document, typed from its filename and links.
  const pageByKey = new Map(pages.map((p) => [p.sourceKey, p]));
  const libraryFiles = files.filter(isLibraryDocument);
  const libraryLinks = new Map<string, number>();
  for (const file of libraryFiles) for (const ref of new Set(file.referencedBy)) libraryLinks.set(ref, (libraryLinks.get(ref) ?? 0) + 1);
  const documents: DocumentRecord[] = [];
  for (const file of libraryFiles) {
    const key = sourceKey(file.url);
    const links: DocumentLink[] = [];
    for (const ref of file.referencedBy) {
      const page = pageByKey.get(ref);
      if (!page) continue;
      const own = page.documents.filter((d) => safeKey(d.href) === key);
      const pageDocuments = libraryLinks.get(page.sourceKey) ?? 0;
      for (const d of own.length ? own : [{ text: '' }]) {
        links.push({ text: d.text, pageKey: page.sourceKey, pageTitle: page.title, pageKind: page.kind, pageDocuments });
      }
    }
    documents.push(classifyDocument(file, links));
  }

  const analysis: RecordAnalysis = { people, communities, tables, documents };
  await writeJson(jobPath(jobId, 'analyze', 'records.json'), analysis);
  log(summary(analysis));
  return analysis;
}

function safeKey(url: string): string | null {
  try {
    return sourceKey(url);
  } catch {
    return null;
  }
}

function summary(a: RecordAnalysis): string {
  const count = (values: (string | null)[]) =>
    Object.entries(
      values.reduce<Record<string, number>>((acc, v) => {
        const k = v ?? '(none)';
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    )
      .sort((x, y) => y[1] - x[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  return [
    `records: ${a.people.length} people (${count(a.people.map((p) => p.group))})`,
    `${a.communities.length} communities (${count(a.communities.map((c) => c.type))})`,
    ...a.tables.map((t) => `table ${t.key}: ${t.rows.length} rows × ${t.columns.length} columns`),
    `${a.documents.length} documents (${count(a.documents.map((d) => d.type))}); library ${count(a.documents.map((d) => d.library))}; ${a.documents.filter((d) => d.date).length} dated`,
  ].join('; ');
}
