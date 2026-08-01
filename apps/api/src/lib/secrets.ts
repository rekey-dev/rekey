/**
 * AES-256-GCM JSON encryption used to store provider credentials at rest.
 *
 * Key comes from `ENCRYPTION_KEY` (32 bytes hex, validated by env.ts in
 * production). Each ciphertext carries its own random IV — we never reuse
 * IVs across writes, even for the same plaintext.
 *
 * Format on disk: `v1.<iv-hex>.<authTag-hex>.<ciphertext-hex>`. The version
 * prefix lets us rotate the algorithm later without breaking old rows.
 *
 * If `ENCRYPTION_KEY` isn't set we fall back to `plain.<json>` so a dev
 * deployment still functions. Production cannot reach that branch: `config/env.ts`
 * throws at boot when `NODE_ENV=production` and the key is absent, because
 * plaintext provider credentials at rest is exactly the kind of exposure nobody
 * notices. Note there is NO warning on the dev path — a mis-set `NODE_ENV` will
 * write `plain.` rows silently.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recommended for GCM

function key(): Buffer | null {
  return env.ENCRYPTION_KEY ? Buffer.from(env.ENCRYPTION_KEY, 'hex') : null;
}

/**
 * Encrypt an arbitrary JSON-serialisable value. Returns the on-disk string.
 */
export function encryptJson(value: unknown): string {
  const k = key();
  const json = JSON.stringify(value);
  if (!k) {
    // Dev fallback. Env.ts already screamed at boot if NODE_ENV=production.
    return `plain.${Buffer.from(json, 'utf8').toString('hex')}`;
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, k, iv);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${iv.toString('hex')}.${authTag.toString('hex')}.${ciphertext.toString('hex')}`;
}

/**
 * Decrypt a string produced by `encryptJson`. Returns the parsed JSON or
 * throws if the ciphertext is tampered with / wrong key / wrong format.
 */
export function decryptJson<T = unknown>(stored: string): T {
  if (stored.startsWith('plain.')) {
    return JSON.parse(Buffer.from(stored.slice('plain.'.length), 'hex').toString('utf8')) as T;
  }
  if (!stored.startsWith('v1.')) {
    throw new Error('Unsupported ciphertext format');
  }
  const k = key();
  if (!k) {
    throw new Error('ENCRYPTION_KEY is not set — cannot decrypt v1 ciphertext.');
  }
  const [, ivHex, tagHex, ctHex] = stored.split('.');
  if (!ivHex || !tagHex || !ctHex) throw new Error('Malformed v1 ciphertext');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(ALGO, k, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
