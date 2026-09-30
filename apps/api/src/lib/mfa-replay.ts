/**
 * Single-use enforcement for the second factor: TOTP codes and sign-in MFA
 * challenge tokens.
 *
 * A TOTP code verifies for about 90 seconds (one step of drift either way),
 * so without a record of what was accepted, a code read over a shoulder or
 * lifted from a proxy log works again inside that window (RFC 6238 section
 * 5.2). Each factor keeps the last time step it accepted, and a code whose
 * step is at or below it is refused. The same rule stops a code that
 * confirmed enrolment from also completing a sign-in.
 *
 * A challenge token proves the password step passed. It is a signed JWT with
 * a five-minute life, so on its own one token plus one code could mint as
 * many sessions as the caller liked. It is claimed on the first successful
 * verification and refused after that.
 *
 * Both records live in Redis. They only have to outlive the window the
 * credential itself is valid for (about 90 seconds, five minutes), so a TTL key is
 * the whole lifecycle, and every replica shares it. Keys hold a SHA-256 of
 * the secret or token, never the value itself.
 *
 * **Fail-CLOSED**, like `brute-force.ts`: a store error surfaces as 503 rather
 * than silently making a single-use credential reusable. In tests (no Redis)
 * an in-memory map backs the same logic.
 */

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getRedis } from './redis.js';
import { dependencyUnavailablePayload, RekeyError } from './error.js';
import { BACKUP_CODE_COUNT, consumeBackupCode, hashBackupCode, matchTotpStep } from './mfa.js';
import { assertNotLocked, clearFailures, MFA_POLICY, registerFailure } from './brute-force.js';
import { decryptJson, encryptJson } from './secrets.js';

const TOTP_STEP_PREFIX = 'mfa:totp-step:';
const CHALLENGE_PREFIX = 'mfa:challenge-used:';

/**
 * A code for step S is accepted until step S+1 ends, at most three periods
 * after the moment it was first accepted. The fourth period covers a replica
 * whose clock runs up to 30 seconds behind the one that accepted it, which
 * would still match S after a 90-second record had expired.
 */
const TOTP_STEP_TTL_SECONDS = 120;

/** Record `step` only when it is newer than the last one this factor accepted. */
const CLAIM_STEP_SCRIPT = `
local last = redis.call('GET', KEYS[1])
if last and tonumber(last) >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

export type TotpOutcome = 'accepted' | 'invalid' | 'reused';

interface Entry {
  value: number;
  expiresAt: number;
}

const memory = new Map<string, Entry>();

function live(key: string, now: number): Entry | undefined {
  const entry = memory.get(key);
  if (entry && entry.expiresAt <= now) {
    memory.delete(key);
    return undefined;
  }
  return entry;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The Redis client, or null for the in-memory fallback. Production without a
 * client is refused rather than falling back, because a per-process record
 * would let each replica accept the same code once.
 */
function storeClient(): Redis | null {
  const redis = getRedis();
  if (!redis && process.env.NODE_ENV === 'production') {
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
  return redis;
}

async function failClosed<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof RekeyError) throw err;
    throw new RekeyError(dependencyUnavailablePayload('redis'));
  }
}

/**
 * Record that the factor with this secret accepted `step`. Returns false when
 * that step, or a later one, was already accepted: the code is a replay.
 *
 * Atomic: of any number of concurrent claims for the same step, one wins.
 *
 * @example
 * if (!(await claimTotpStep(base32, 59683723))) refuseReplay();
 */
export async function claimTotpStep(
  secretBase32: string,
  step: number,
  redis: Redis | null = storeClient(),
): Promise<boolean> {
  const key = TOTP_STEP_PREFIX + sha256(secretBase32);
  if (redis) {
    const won = await failClosed(() =>
      redis.eval(CLAIM_STEP_SCRIPT, 1, key, String(step), String(TOTP_STEP_TTL_SECONDS)),
    );
    return won === 1;
  }
  const now = Date.now();
  const last = live(key, now);
  if (last && last.value >= step) return false;
  memory.set(key, { value: step, expiresAt: now + TOTP_STEP_TTL_SECONDS * 1000 });
  return true;
}

/**
 * Check a TOTP code and, when it matches, spend it.
 *
 * `reused` means the code was right but its step was already accepted for
 * this factor, so the caller should ask for the next code rather than report
 * a typo.
 *
 * @example
 * const outcome = await acceptTotpCode(base32, body.code);
 * if (outcome === 'accepted') grant();
 */
export async function acceptTotpCode(secretBase32: string, code: string): Promise<TotpOutcome> {
  const step = matchTotpStep(secretBase32, code);
  if (step === null) return 'invalid';
  return (await claimTotpStep(secretBase32, step)) ? 'accepted' : 'reused';
}

/**
 * Whether `step`, or a later one, was already accepted for this factor. A
 * read only: `claimTotpStep` is the atomic check that spends it.
 *
 * @example
 * if (await isTotpStepSpent(base32, step)) return 'reused';
 */
export async function isTotpStepSpent(
  secretBase32: string,
  step: number,
  redis: Redis | null = storeClient(),
): Promise<boolean> {
  const key = TOTP_STEP_PREFIX + sha256(secretBase32);
  if (redis) {
    const last = await failClosed(() => redis.get(key));
    return last !== null && Number(last) >= step;
  }
  const last = live(key, Date.now());
  return last !== undefined && last.value >= step;
}

/**
 * The first phase of a code check: the code matched and nothing is spent
 * yet. `spend` is the second phase, and it can still lose a race.
 */
export type MfaMatch =
  | { outcome: 'reused' }
  | { outcome: 'invalid'; spentBackupCode?: true }
  | { outcome: 'matched'; spend: () => Promise<TotpOutcome> };

/** What `matchMfaCode` needs to know about one enrolled credential. */
export interface EnrolledFactor {
  base32: string;
  backupCodesCiphertext: string;
  /** Hashes of backup codes already spent, when the store keeps them. */
  usedBackupCodeHashes?: readonly string[];
  backupStore: BackupCodeStore;
  /** The brute-force scope failures count against. */
  lockScope: string;
}

async function settle(lockScope: string, outcome: TotpOutcome): Promise<TotpOutcome> {
  if (outcome === 'accepted') await clearFailures(lockScope);
  else if (outcome === 'invalid') await registerFailure(lockScope, MFA_POLICY);
  return outcome;
}

/**
 * Match a TOTP or backup code WITHOUT spending it, so the caller can refuse
 * for other reasons (a device limit) after the second factor is proven and
 * before anything is consumed. A wrong code counts toward the lockout here,
 * exactly as it does when the code is checked and spent in one go. A reused
 * code does not: it is not a guess.
 *
 * @example
 * const match = await matchMfaCode(factor, code);
 * if (match.outcome === 'matched') outcome = await match.spend();
 */
export async function matchMfaCode(factor: EnrolledFactor, code: string): Promise<MfaMatch> {
  await assertNotLocked(factor.lockScope, 'MFA_TOO_MANY_ATTEMPTS');
  const step = matchTotpStep(factor.base32, code);
  if (step !== null) {
    if (await isTotpStepSpent(factor.base32, step)) return { outcome: 'reused' };
    return {
      outcome: 'matched',
      spend: async () =>
        settle(factor.lockScope, (await claimTotpStep(factor.base32, step)) ? 'accepted' : 'reused'),
    };
  }
  const hashes = decryptJson<string[]>(factor.backupCodesCiphertext);
  const hash = hashBackupCode(code);
  if (hashes.includes(hash)) {
    return {
      outcome: 'matched',
      spend: async () => {
        const spent = await spendBackupCode(code, factor.backupCodesCiphertext, factor.backupStore);
        return settle(factor.lockScope, spent ? 'accepted' : 'invalid');
      },
    };
  }
  await registerFailure(factor.lockScope, MFA_POLICY);
  // Still counted above: naming a spent code must not make guessing cheaper.
  if (factor.usedBackupCodeHashes?.includes(hash)) return { outcome: 'invalid', spentBackupCode: true };
  return { outcome: 'invalid' };
}

/**
 * Whether this challenge token has already completed a sign-in. A fast path
 * so a replay is refused before it spends a backup code; `claimMfaChallenge`
 * is the authoritative, atomic check.
 *
 * @example
 * if (await isMfaChallengeSpent(token)) throw challengeUsed();
 */
export async function isMfaChallengeSpent(
  token: string,
  redis: Redis | null = storeClient(),
): Promise<boolean> {
  const key = CHALLENGE_PREFIX + sha256(token);
  if (redis) return (await failClosed(() => redis.exists(key))) === 1;
  return live(key, Date.now()) !== undefined;
}

/**
 * Claim a challenge token for the one sign-in it may complete. Returns true
 * for the first caller only. The claim is held until the token's own `exp`,
 * after which the signature check refuses it anyway.
 *
 * @example
 * if (!(await claimMfaChallenge(token, claims.exp))) throw challengeUsed();
 */
export async function claimMfaChallenge(
  token: string,
  expiresAtSec: number,
  redis: Redis | null = storeClient(),
): Promise<boolean> {
  const ttlSec = Math.ceil(expiresAtSec - Date.now() / 1000);
  if (ttlSec <= 0) return false;
  const key = CHALLENGE_PREFIX + sha256(token);
  if (redis) {
    return (await failClosed(() => redis.set(key, '1', 'EX', ttlSec, 'NX'))) === 'OK';
  }
  const now = Date.now();
  if (live(key, now)) return false;
  memory.set(key, { value: 1, expiresAt: now + ttlSec * 1000 });
  return true;
}

/**
 * The error for a challenge token that already completed its sign-in. Shared
 * by the end-user and operator flows so the code and remedy cannot drift.
 */
export function mfaChallengeUsedError(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'MFA_CHALLENGE_USED',
    message: 'This MFA challenge token has already completed a sign-in.',
    fix: 'Sign in again to get a new challenge token. Each challenge token completes one sign-in.',
  });
}

const CODE_REUSED_FIX = {
  'sign-in':
    'Wait for the authenticator app to show a new 6-digit code and enter that one, or enter an unused backup code.',
  enrolment: 'Wait for the authenticator app to show a new 6-digit code and enter that one.',
  'step-up':
    'Wait for the authenticator app to show a new 6-digit code and send that as `code`, or send an unused backup code.',
} as const;

/**
 * The error for a TOTP code that matched but was already accepted. Enrolment
 * confirmation answers 422 (the session is fine, only the code is not) and
 * takes no backup code, so its remedy differs from the others.
 */
export function mfaCodeReusedError(during: keyof typeof CODE_REUSED_FIX): RekeyError {
  return new RekeyError({
    statusCode: during === 'enrolment' ? 422 : 401,
    code: 'MFA_CODE_REUSED',
    message: 'That authenticator code has already been used.',
    fix: CODE_REUSED_FIX[during],
  });
}

/**
 * The sign-in error for a backup code this account was issued and has already
 * spent. Only reachable after the password step, with a real code.
 */
export function mfaBackupCodeUsedError(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'MFA_BACKUP_CODE_USED',
    message: 'That backup code has already been used. Each backup code works once.',
    fix: 'Enter a different unused backup code, or the current 6-digit code from the authenticator app.',
  });
}

/** Where a credential's backup-code hashes live, for `spendBackupCode`. */
export interface BackupCodeStore {
  /**
   * Replace the ciphertext only if it still equals `expected`, recording
   * `spentHash` as used where the store keeps that. True when it did.
   */
  swap(expected: string, next: string, spentHash: string): Promise<boolean>;
  /** The current ciphertext, or null once the credential is gone. */
  reload(): Promise<string | null>;
}

/**
 * Spend one backup code with a compare-and-swap on the stored ciphertext, so
 * concurrent requests carrying the same code cannot all succeed. A lost swap
 * re-reads and tries again; every lost swap means another request removed a
 * code, so the retries are bounded by how many codes exist.
 *
 * @example
 * const ok = await spendBackupCode(code, cred.backupCodesCiphertext, store);
 */
export async function spendBackupCode(
  code: string,
  ciphertext: string,
  store: BackupCodeStore,
): Promise<boolean> {
  let current: string | null = ciphertext;
  for (let attempt = 0; attempt <= BACKUP_CODE_COUNT && current !== null; attempt++) {
    const remaining = consumeBackupCode(decryptJson<string[]>(current), code);
    if (!remaining) return false;
    if (await store.swap(current, encryptJson(remaining), hashBackupCode(code))) return true;
    current = await store.reload();
  }
  return false;
}

/** Test seam, drop every record. */
export function __resetForTests(): void {
  memory.clear();
}
