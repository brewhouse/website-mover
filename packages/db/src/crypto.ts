import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** CREDENTIALS_ENCRYPTION_KEY: 32 bytes, base64. */
function key(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY ?? '';
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32)');
  return k;
}

/** AES-256-GCM: "v1:<iv>:<tag>:<ciphertext>", base64 parts. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognized encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
