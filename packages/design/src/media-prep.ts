/**
 * Mockup images are often export-size (4096 px, 10+ MB). WordPress makes every thumbnail size from
 * the upload, and on Pantheon that outlasts the gateway (502). Large images are scaled down to
 * WordPress's own "big image" limit first and saved in the format their content really is.
 */
import path from 'node:path';
import sharp from 'sharp';

/** WordPress scales anything wider or taller than this anyway (big_image_size_threshold). */
export const MAX_EDGE = 2560;
/** Files above this are re-encoded even when they're small enough in pixels. */
export const MAX_BYTES = 1.5 * 1024 * 1024;

const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };

export interface PreparedImage {
  data: Uint8Array<ArrayBuffer>;
  filename: string;
  contentType: string;
  /** Set when the image was changed: what it was. */
  resized?: { width: number; height: number; bytes: number };
}

/**
 * Returns the image ready to upload: unchanged when it's small, else scaled to fit MAX_EDGE and
 * re-encoded (JPEG unless it has transparency). The filename's extension follows the real format,
 * so a JPEG exported as .png uploads as .jpg.
 */
export async function prepareImage(input: Buffer, filename: string, fallbackType: string): Promise<PreparedImage> {
  const asIs = (): PreparedImage => ({ data: new Uint8Array(input), filename, contentType: fallbackType });
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return asIs(); // not an image sharp reads (SVG is fine as it is, PDFs aren't images)
  }
  const format = meta.format ?? '';
  if (!(format in MIME) || format === 'gif' || !meta.width || !meta.height) return asIs();
  const base = path.basename(filename, path.extname(filename));
  const big = Math.max(meta.width, meta.height) > MAX_EDGE || input.length > MAX_BYTES;
  if (!big) return { data: new Uint8Array(input), filename: `${base}.${EXT[format]}`, contentType: MIME[format]! };

  const img = sharp(input).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  const alpha = meta.hasAlpha && (await sharp(input).stats()).isOpaque === false;
  const out = alpha ? await img.png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer() : await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  return {
    data: new Uint8Array(out),
    filename: `${base}.${alpha ? 'png' : 'jpg'}`,
    contentType: alpha ? 'image/png' : 'image/jpeg',
    resized: { width: meta.width, height: meta.height, bytes: input.length },
  };
}
