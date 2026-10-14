import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What the PDF itself states, without interpretation (PLAN §6.8 step 1). */
export interface PdfFacts {
  pages: number;
  text: string;
  /** Uppercase #RRGGBB values written in the text or given as RGB triples, with the text around them. */
  colors: { hex: string; context: string }[];
  /** CMYK values as written (not convertible to an exact screen colour). */
  cmyk: string[];
  /** Font families embedded or referenced in the PDF (subset prefixes removed). */
  fonts: string[];
  /** Embedded images, extracted as PNG files: logo candidates. */
  images: { page: number; width: number; height: number; file: string }[];
  /** One PNG render per page (for the model). */
  renders: string[];
}

export async function readPdfFacts(pdf: string, workDir: string): Promise<PdfFacts> {
  await mkdir(workDir, { recursive: true });
  const { stdout: info } = await run('pdfinfo', [pdf]);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  const { stdout: text } = await run('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 64 * 1024 * 1024 });

  const colors = new Map<string, string>();
  const note = (hex: string, index: number) => {
    const key = normalizeHex(hex);
    if (key && !colors.has(key)) colors.set(key, text.slice(Math.max(0, index - 60), index + 60).replace(/\s+/g, ' ').trim());
  };
  for (const m of text.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) note(m[1]!, m.index!);
  // "HEX 0B3D91" / "Hex: 0b3d91" without a leading #.
  for (const m of text.matchAll(/\bhex\s*:?\s*#?([0-9a-f]{6})\b/gi)) note(m[1]!, m.index!);
  // "RGB 11 61 145", "R 11 G 61 B 145", "rgb(11, 61, 145)".
  for (const m of text.matchAll(/\bR(?:GB)?\s*[:(]?\s*(\d{1,3})[\s,/]+(?:G\s*:?\s*)?(\d{1,3})[\s,/]+(?:B\s*:?\s*)?(\d{1,3})\b/gi)) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].every((v) => v! <= 255)) note([r, g, b].map((v) => v!.toString(16).padStart(2, '0')).join(''), m.index!);
  }
  const cmyk = [...text.matchAll(/\bC(?:MYK)?\s*:?\s*\d{1,3}[\s,/]+M?\s*:?\s*\d{1,3}[\s,/]+Y?\s*:?\s*\d{1,3}[\s,/]+K?\s*:?\s*\d{1,3}\b/gi)].map((m) => m[0].replace(/\s+/g, ' '));

  const { stdout: fontList } = await run('pdffonts', [pdf]);
  const fonts = [
    ...new Set(
      fontList
        .split('\n')
        .slice(2)
        .map((line) => line.split(/\s{2,}/)[0]?.trim() ?? '')
        .filter(Boolean)
        .map((name) => name.replace(/^[A-Z]{6}\+/, '').replace(/[-,](Bold|Italic|Regular|Light|Medium|Semibold|Black|Book|Heavy|Thin|Oblique|BoldItalic|It|Bd|Md|Lt|Rg)+.*$/i, '')),
    ),
  ];

  const imageDir = path.join(workDir, 'images');
  await mkdir(imageDir, { recursive: true });
  const { stdout: imageList } = await run('pdfimages', ['-list', pdf]);
  await run('pdfimages', ['-png', '-p', pdf, path.join(imageDir, 'img')]);
  const files = (await readdir(imageDir)).filter((f) => f.endsWith('.png')).sort();
  const rows = imageList.split('\n').slice(2).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 4 && /^\d+$/.test(c[0]!));
  const images = rows.map((c, i) => ({ page: Number(c[0]), width: Number(c[3]), height: Number(c[4]), file: path.join(imageDir, files[i] ?? '') })).filter((im) => im.file.endsWith('.png'));

  const renderDir = path.join(workDir, 'pages');
  await mkdir(renderDir, { recursive: true });
  await run('pdftoppm', ['-r', '60', '-png', '-l', '12', pdf, path.join(renderDir, 'page')]);
  const renders = (await readdir(renderDir)).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(renderDir, f));

  return { pages, text, colors: [...colors].map(([hex, context]) => ({ hex, context })), cmyk: [...new Set(cmyk)], fonts, images, renders };
}

/** "#0b3d91" / "0B3D91" / "fff" → "#0B3D91" / "#FFFFFF"; anything else → null. */
export function normalizeHex(value: string): string | null {
  const v = value.replace(/^#/, '').trim();
  if (/^[0-9a-f]{3}$/i.test(v)) return `#${[...v].map((c) => c + c).join('')}`.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(v)) return `#${v}`.toUpperCase();
  return null;
}
