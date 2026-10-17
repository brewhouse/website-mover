/**
 * `wm brand`: checks a brand file and copies it into a job with what it needs, so planning and
 * execution use exactly these files (their hashes go into the plan):
 *
 *   inputs/brand/brand.json      the brand file as given
 *   inputs/brand/logos/…         its logo files
 *   inputs/brand/fonts/…         its fonts: the files WordPress's own Font Library installs (its Google
 *                                Fonts collection), self-hosted on the site, so pages don't call Google
 *   inputs/brand/manifest.json   what's there, with sha256s
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { jobPath, writeJson } from '@wm/core';
import { safeFetch } from '@wm/net';
import { BrandFile, resolveBrand, type BrandFont, type BrandFontFace, type BrandLogo, type BrandManifest } from './brand.js';

/** WordPress's Google Fonts collection (wp-includes/fonts.php registers the same file). */
export const GOOGLE_FONTS_COLLECTION = 'https://s.w.org/images/fonts/wp-7.0/collections/google-fonts-with-preview.json';

const LOGO_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Imports a brand file into a job. Fails on any problem: nothing half-imported is used. */
export async function importBrand(jobId: string, file: string, log: (msg: string) => void = () => {}): Promise<BrandManifest> {
  const raw = await readFile(file);
  const brand = BrandFile.parse(JSON.parse(raw.toString()));
  const { errors, checks } = resolveBrand(brand);
  if (errors.length) throw new Error(`The brand file has problems:\n  ${errors.join('\n  ')}`);

  // Built next to the current import and swapped in at the end, so a failed import leaves it as it was.
  const final = jobPath(jobId, 'inputs', 'brand');
  const dir = `${final}.importing`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'logos'), { recursive: true });
  await writeFile(path.join(dir, 'brand.json'), raw);

  const logo = async (role: 'header' | 'footer', rel: string | null | undefined): Promise<BrandLogo | null> => {
    if (!rel) return null;
    const ext = path.extname(rel).toLowerCase();
    const contentType = LOGO_TYPES[ext];
    if (!contentType) throw new Error(`Logo ${rel}: use a PNG, JPEG or WebP file (WordPress doesn't accept SVG uploads by default)`);
    const data = await readFile(path.resolve(path.dirname(file), rel));
    const name = `logos/${role === 'header' ? 'logo' : 'logo-footer'}${ext}`;
    await writeFile(path.join(dir, name), data);
    return { file: name, sha256: sha256(data), contentType, ...pngSize(data) };
  };
  const logos = { header: await logo('header', brand.logos?.header), footer: await logo('footer', brand.logos?.footer) };

  const fonts: BrandFont[] = [];
  if (brand.fonts.length) {
    await mkdir(path.join(dir, 'fonts'), { recursive: true });
    log(`Fonts: reading WordPress's Google Fonts collection`);
    const collection = (await (await fetchOk(GOOGLE_FONTS_COLLECTION)).json()) as Collection;
    for (const font of brand.fonts) {
      const entry = collection.font_families.find((f) => f.font_family_settings.name === font.family)?.font_family_settings;
      if (!entry) throw new Error(`${font.family} isn't in WordPress's Google Fonts collection`);
      const faces: BrandFontFace[] = [];
      for (const style of font.italic ? (['normal', 'italic'] as const) : (['normal'] as const)) {
        for (const weight of font.weights) {
          const face = entry.fontFace.find((f) => f.fontStyle === style && Number(f.fontWeight) === weight);
          if (!face) throw new Error(`${font.family} has no ${style} ${weight} in the collection`);
          const sourceUrl = [face.src].flat()[0]!;
          const data = new Uint8Array(await (await fetchOk(sourceUrl)).arrayBuffer());
          const name = `fonts/${entry.slug}-${weight}${style === 'italic' ? '-italic' : ''}${path.extname(new URL(sourceUrl).pathname) || '.woff2'}`;
          await writeFile(path.join(dir, name), data);
          faces.push({ weight, style, file: name, sha256: sha256(data), sourceUrl });
        }
      }
      fonts.push({ family: font.family, slug: entry.slug, fontFamily: entry.fontFamily, faces });
      log(`  ${font.family}: ${faces.length} files`);
    }
  }

  const manifest: BrandManifest = { importedAt: new Date().toISOString(), brandSha256: sha256(raw), logos, fonts };
  await writeJson(path.join(dir, 'manifest.json'), manifest);
  await rm(final, { recursive: true, force: true });
  await rename(dir, final);
  const failing = checks.filter((c) => !c.passes);
  log(`Brand: ${Object.keys(brand.theme).length} theme values, ${fonts.length} fonts, ${[logos.header, logos.footer].filter(Boolean).length} logos`);
  for (const c of failing) log(`  ! ${c.what}: ${c.foreground} on ${c.background} is ${c.ratio}:1; WCAG AA needs ${c.needs}:1`);
  return manifest;
}

interface Collection {
  font_families: {
    font_family_settings: { name: string; slug: string; fontFamily: string; fontFace: { fontStyle: string; fontWeight: string; src: string | string[] }[] };
  }[];
}

async function fetchOk(url: string) {
  const res = await safeFetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A PNG's size from its header; null for other formats. */
function pngSize(data: Uint8Array): { width: number | null; height: number | null } {
  const png = data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  if (!png) return { width: null, height: null };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
