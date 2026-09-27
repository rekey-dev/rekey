/**
 * TOTP (RFC 6238) helpers + backup codes.
 *
 * - `generateSecret`: build a random base32 secret + the otpauth:// URI for QR.
 * - `matchTotpStep`: match a 6-digit code (±1 step drift) to its time step.
 * - `generateBackupCodes`: 10 random short codes (5-char alphanumeric pairs)
 *   for the user to print/save. We store SHA-256 hashes; consume by removing
 *   the matching hash from the array.
 *
 * The MFA secret + the array of backup-code hashes are persisted via
 * `lib/secrets.ts` (AES-256-GCM JSON), never in plaintext.
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
  /** Plaintext codes, show to user once, then discard. */
  plaintext: string[];
  /** SHA-256 hashes, store these. */
  hashes: string[];
}

/**
 * Mint a new TOTP secret + the otpauth URI for QR.
 *
 * @param issuer  Display name in the authenticator app (e.g. "Rekey")
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

const TOTP_PERIOD_SECONDS = 30;

/**
 * Match a 6-digit TOTP code against the secret with one step of drift either
 * way, and return the time step it belongs to, or null when it does not match.
 *
 * The step is what makes a code single-use: `acceptTotpCode` in
 * `mfa-replay.ts` refuses any step at or below the last one it accepted.
 * Never throws.
 *
 * @example
 * const step = matchTotpStep(secret.base32, '123456');
 * if (step === null) refuse();
 */
export function matchTotpStep(
  secretBase32: string,
  code: string,
  timestamp: number = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const totp = new OTPAuth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD_SECONDS,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
    const delta = totp.validate({ token: code, timestamp, window: 1 });
    return delta === null ? null : totp.counter({ timestamp }) + delta;
  } catch {
    return null;
  }
}

export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 5; // 5 bytes -> 8 base32-ish chars, formatted as XXXX-XXXX

function generateBackupCode(): string {
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
