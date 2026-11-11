/**
 * A small ZIP reader for mockup uploads: stored and deflated entries, no ZIP64, no encryption.
 * It is strict on purpose: entry names that leave the folder, symbolic links and archives that
 * expand past the limits are refused rather than skipped silently.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

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

/**
 * Writes a ZIP (deflated entries, UTF-8 names, no ZIP64) for downloads such as a theme change
 * set. Entries are files; folders are implied by their paths.
 */
export function writeZip(files: { name: string; data: Buffer }[], date = new Date()): Buffer {
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(safeName(f.name), 'utf8');
    const packed = deflateRawSync(f.data);
    const store = packed.length >= f.data.length;
    const body = store ? f.data : packed;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
