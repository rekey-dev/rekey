/**
 * TOTP (RFC 6238) helpers + backup codes.
 *
 * - `generateSecret`: build a random base32 secret + the otpauth:// URI for QR.
 * - `verifyTotp`: check a 6-digit code against the secret with ±1 step drift.
 * - `generateBackupCodes`: 10 random short codes (5-char alphanumeric pairs)
 *   for the user to print/save. We store SHA-256 hashes; consume by removing
 *   the matching hash from the array.
 *
 * The MFA secret + the array of backup-code hashes are persisted via
 * `lib/secrets.ts` (AES-256-GCM JSON) — never in plaintext.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';

export interface GeneratedSecret {
  /** Base32 string (the canonical TOTP secret format). */
  base32: string;
  /** otpauth:// URI suitable for QR generation. */
  otpauthUrl: string;
}

export interface GeneratedBackupCodes {
  /** Plaintext codes — show to user once, then discard. */
  plaintext: string[];
  /** SHA-256 hashes — store these. */
  hashes: string[];
}

/**
 * Mint a new TOTP secret + the otpauth URI for QR.
 *
 * @param issuer  Display name in the authenticator app (e.g. "ReliPay")
 * @param label   Account identifier (e.g. user email)
 */
export function generateSecret(issuer: string, label: string): GeneratedSecret {
  // 20 bytes = 160 bits, the RFC 6238 recommendation.
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  return {
    base32: secret.base32,
    otpauthUrl: totp.toString(),
  };
}

/**
 * Verify a 6-digit TOTP code with ±1 time-step drift (covers clock skew
 * + the moment when a code rolls over).
 *
 * Returns true / false. Never throws.
 */
export function verifyTotp(secretBase32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    const delta = totp.validate({ token: code, window: 1 });
    return delta !== null;
  } catch {
    return false;
  }
}

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 5; // 5 bytes → 8 base32-ish chars; we format as XXXX-XXXX

function generateBackupCode(): string {
  // Format: XXXX-XXXX (8 alphanumeric, no easily-confused chars).
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  const buf = randomBytes(BACKUP_CODE_BYTES);
  let s = '';
  for (let i = 0; i < BACKUP_CODE_BYTES * 2; i++) {
    const byte = buf[i % BACKUP_CODE_BYTES]!;
    s += ALPHABET[(i % 2 === 0 ? byte >> 3 : byte & 0x1f) % ALPHABET.length];
    if (i === 3) s += '-';
  }
  return s;
}

export function hashBackupCode(raw: string): string {
  // Normalise: strip dashes + uppercase before hashing so user-typed
  // formatting variations all match.
  const norm = raw.replace(/-/g, '').toUpperCase();
  return createHash('sha256').update(norm).digest('hex');
}

export function generateBackupCodes(): GeneratedBackupCodes {
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = generateBackupCode();
    plaintext.push(code);
    hashes.push(hashBackupCode(code));
  }
  return { plaintext, hashes };
}

/** Returns the new array of remaining hashes if `code` consumes a backup, or null if no match. */
export function consumeBackupCode(stored: string[], code: string): string[] | null {
  const target = hashBackupCode(code);
  const idx = stored.indexOf(target);
  if (idx === -1) return null;
  return [...stored.slice(0, idx), ...stored.slice(idx + 1)];
}
