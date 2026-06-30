/**
 * Server-side WebAuthn challenge store — the anti-replay control for passkey
 * ceremonies (both operator and end-user).
 *
 * A WebAuthn assertion is only fresh if the relying party verifies it against
 * a challenge IT issued and has not seen before. Earlier versions delegated
 * the challenge round-trip to the client: `/start` returned a challenge and
 * `/complete` trusted whatever `expectedChallenge` the caller posted back.
 * That meant a captured assertion (from logs, APM, a malicious panel, …) could
 * be replayed forever — the server had no way to tell a fresh assertion from a
 * stale one, especially for synced platform passkeys that report `counter = 0`.
 *
 * Now `/start` persists the challenge here and `/complete` must look it up and
 * atomically burn it. The posted `expectedChallenge` is no longer trusted on
 * its own — it must match a stored, unexpired, unconsumed row bound to the
 * right ceremony/scope/subject, and the row is consumed on first use.
 *
 * Rows live ~5 minutes. Single-use is enforced by an atomic guarded
 * `updateMany(... consumedAt = null)`, so two concurrent completes for the same
 * challenge cannot both win.
 */

import { prisma } from './prisma.js';
import { RelipayError } from './error.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type WebAuthnCeremony = 'registration' | 'authentication';
export type WebAuthnScope = 'tenant' | 'end_user';

export interface StoreChallengeArgs {
  /** The base64url challenge SimpleWebAuthn generated for this ceremony. */
  challenge: string;
  ceremony: WebAuthnCeremony;
  scope: WebAuthnScope;
  /** Set for `end_user` scope; null for operator (`tenant`) ceremonies. */
  applicationId?: string | null;
  /**
   * The subject the resulting credential binds to (tenantUserId / endUserId)
   * for registration ceremonies. Null for usernameless authentication.
   */
  subjectId?: string | null;
}

/** Persist a freshly-issued challenge so `/complete` can validate + burn it. */
export async function storeChallenge(args: StoreChallengeArgs): Promise<void> {
  await prisma.webAuthnChallenge.create({
    data: {
      challenge: args.challenge,
      ceremony: args.ceremony,
      scope: args.scope,
      applicationId: args.applicationId ?? null,
      subjectId: args.subjectId ?? null,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    },
  });
}

export interface ConsumeChallengeArgs {
  /** The challenge value the caller posted to `/complete`. */
  challenge: string;
  ceremony: WebAuthnCeremony;
  scope: WebAuthnScope;
  /** Must match what `/start` stored: app id for `end_user`, null for `tenant`. */
  applicationId?: string | null;
  /**
   * For registration ceremonies, the authenticated session subject. The stored
   * challenge must have been minted for this same subject — stops a challenge
   * issued to user A being completed by user B. Omit for authentication.
   */
  expectedSubjectId?: string | null;
}

/**
 * Atomically validate + consume a challenge. Throws `WEBAUTHN_CHALLENGE_INVALID`
 * if it is unknown, expired, already used, or bound to a different
 * ceremony/scope/subject. Consumes BEFORE the cryptographic verify so a failed
 * verify still burns the challenge (one challenge = one attempt, regardless of
 * outcome — the WebAuthn-correct behaviour).
 */
export async function consumeChallenge(args: ConsumeChallengeArgs): Promise<void> {
  const now = new Date();
  const claimed = await prisma.webAuthnChallenge.updateMany({
    where: {
      challenge: args.challenge,
      ceremony: args.ceremony,
      scope: args.scope,
      applicationId: args.applicationId ?? null,
      consumedAt: null,
      expiresAt: { gt: now },
      ...(args.expectedSubjectId !== undefined &&
        args.expectedSubjectId !== null && { subjectId: args.expectedSubjectId }),
    },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) {
    throw new RelipayError({
      statusCode: 401,
      code: 'WEBAUTHN_CHALLENGE_INVALID',
      message:
        'The WebAuthn challenge is unknown, expired, already used, or does not match this ceremony.',
      fix: 'Start a fresh ceremony with /start and complete it once, without reusing or hand-editing the challenge.',
    });
  }
}

/**
 * Best-effort sweep of expired/consumed challenges. Safe to call opportunistically
 * (e.g. from a cron); failures are swallowed since the rows are harmless once
 * past their TTL — they can never be consumed again.
 */
export async function pruneExpiredChallenges(): Promise<number> {
  const res = await prisma.webAuthnChallenge.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return res.count;
}
