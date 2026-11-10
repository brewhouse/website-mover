/**
 * A small ZIP reader for mockup uploads: stored and deflated entries, no ZIP64, no encryption.
 * It is strict on purpose: entry names that leave the folder, symbolic links and archives that
 * expand past the limits are refused rather than skipped silently.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Forward-slash path inside the archive, never absolute and never containing "..". */
  name: string;
  isDirectory: boolean;
  size: number;
  /** Reads (and inflates) the entry. */
  read(): Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 200 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  // The end-of-central-directory record is in the last 22 bytes plus at most a 64 KB comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported: re-zip without ZIP64');
  if (count > limits.maxEntries) throw new Error(`The ZIP has ${count} entries (limit ${limits.maxEntries})`);

  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new Error('Corrupt ZIP central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const unixMode = buf.readUInt32LE(p + 38) >>> 16;
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;

    const name = safeName(rawName);
    const isDirectory = name.endsWith('/');
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`The ZIP contains a symbolic link (${name}): remove it and upload again`);
    if (flags & 0x1) throw new Error(`The ZIP is encrypted (${name})`);
    if (!isDirectory && method !== 0 && method !== 8) throw new Error(`Unsupported compression in ${name} (method ${method})`);
    if (size > limits.maxEntryBytes) throw new Error(`${name} is ${size} bytes when unpacked (limit ${limits.maxEntryBytes})`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error(`The ZIP unpacks to more than ${limits.maxTotalBytes} bytes`);

    entries.push({
      name,
      isDirectory,
      size,
      read() {
        if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`Corrupt ZIP entry ${name}`);
        const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
        const data = buf.subarray(start, start + compressed);
        const out = method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
        if (out.length !== size) throw new Error(`ZIP entry ${name} unpacked to ${out.length} bytes, expected ${size}`);
        return out;
      },
    });
  }
  return entries;
}

/** Normalizes an entry name and refuses one that would land outside the destination folder. */
export function safeName(raw: string): string {
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.includes('\0')) throw new Error(`Unsafe path in ZIP: ${raw}`);
  const parts = name.split('/');
  if (parts.some((s) => s === '..')) throw new Error(`Unsafe path in ZIP: ${raw}`);
  return parts.filter((s, i) => s !== '.' && (s !== '' || i === parts.length - 1)).join('/');
}
