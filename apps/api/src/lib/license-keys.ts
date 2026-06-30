/**
 * License key generation + verification.
 *
 * Format: `rl_lic_<20-byte-base64url>` — cryptographically random; not
 * derivable from anything visible. Stored as SHA-256 hash on disk; raw
 * value is shown to the operator exactly once at issue.
 *
 * Customer apps validate licenses by POSTing the raw key to
 * /api/v1/licenses/verify with a machine fingerprint. See
 * `modules/licenses/licenses.service.ts` for the activation tracking.
 */

import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'rl_lic';

export function generateLicenseKey(): { raw: string; hash: string; prefix: string } {
  const random = randomBytes(20).toString('base64url');
  const raw = `${PREFIX}_${random}`;
  return {
    raw,
    hash: hashLicenseKey(raw),
    prefix: raw.slice(0, PREFIX.length + 1 + 6), // "rl_lic_aBcDef"
  };
}

export function hashLicenseKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function isLicenseKey(value: string): boolean {
  return value.startsWith(`${PREFIX}_`);
}
