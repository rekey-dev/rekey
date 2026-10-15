/**
 * What a new session is issued on the strength of, and the lock that makes
 * the answer hold.
 *
 * A claim, a password change, a reset and sign-out everywhere each end every
 * session an account has. A sign-in that checked its credential a moment
 * before one of them, and wrote its refresh row a moment after, used to walk
 * away with a live session: the revocation could not see a row that did not
 * exist yet.
 *
 * Both sides now take the account row first. Whoever revokes holds it while
 * stamping `sessionsInvalidBefore` and revoking; whoever issues holds it while
 * comparing the row to the one their credential was checked against, and
 * writes nothing when it has moved on.
 *
 * `FOR NO KEY UPDATE`, never `FOR UPDATE` or `FOR SHARE`. It conflicts with
 * itself, which is the mutual exclusion wanted. It does not conflict with the
 * `FOR KEY SHARE` a child insert takes through its foreign key, so a sign-in
 * that just registered a device does not deadlock against another one. And
 * two holders of `FOR SHARE` would deadlock on the row update a sign-in makes
 * for its first-sign-in and activity columns.
 */

import type { Prisma } from '@prisma/client';

/** The columns of an account row that decide whether a credential still stands. */
export interface CredentialRow {
  passwordHash: string | null;
  sessionsInvalidBefore: Date | null;
}

export interface SessionBasis {
  /** `sessionsInvalidBefore` as it stood when the credential was read. */
  sessionsInvalidBefore: Date | null;
  /** Set only when a password is what verified: the hash it verified against. */
  passwordHash?: string | null;
  /** The answer when the account has moved on: the same one a wrong or ended credential gets. */
  refusal: () => Error;
}

/**
 * The basis for a session issued from an account row read with its credential.
 *
 * @example
 *   await issueRefreshToken(app.id, user.id, {}, sessionBasis(user, credentialSuperseded));
 */
export function sessionBasis(
  row: { sessionsInvalidBefore: Date | null },
  refusal: () => Error,
): SessionBasis {
  return { sessionsInvalidBefore: row.sessionsInvalidBefore, refusal };
}

/**
 * The stamp a challenge token was bound to when its first factor verified
 * (`sib`: milliseconds, 0 for none). Every challenge this API mints carries
 * it; undefined means the token carries none and is bound to nothing.
 *
 * @example
 *   const stamp = boundStamp(claims.sib);
 *   if (stamp === undefined) throw challengeInvalid();
 */
export function boundStamp(sib: number | undefined): Date | null | undefined {
  if (sib === undefined) return undefined;
  return sib === 0 ? null : new Date(sib);
}

/**
 * Take the end-user row for the rest of the transaction. Null when it is gone.
 *
 * @example
 *   const row = await lockEndUserCredentials(tx, endUserId);
 */
export async function lockEndUserCredentials(
  tx: Prisma.TransactionClient,
  endUserId: string,
): Promise<CredentialRow | null> {
  const rows = await tx.$queryRaw<CredentialRow[]>`
    SELECT "password_hash" AS "passwordHash", "sessions_invalid_before" AS "sessionsInvalidBefore"
    FROM "end_users" WHERE "id" = ${endUserId} FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

/**
 * Take the operator row for the rest of the transaction. Null when it is gone.
 *
 * @example
 *   const row = await lockOperatorCredentials(tx, tenantUserId);
 */
export async function lockOperatorCredentials(
  tx: Prisma.TransactionClient,
  tenantUserId: string,
): Promise<CredentialRow | null> {
  const rows = await tx.$queryRaw<CredentialRow[]>`
    SELECT "password_hash" AS "passwordHash", "sessions_invalid_before" AS "sessionsInvalidBefore"
    FROM "tenant_users" WHERE "id" = ${tenantUserId} FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

/**
 * Throw the basis's refusal unless the locked row is still the one the
 * credential was checked against.
 *
 * @example
 *   assertBasisHolds(basis, await lockEndUserCredentials(tx, endUserId));
 */
export function assertBasisHolds(basis: SessionBasis, row: CredentialRow | null): void {
  const stamp = (at: Date | null): number | null => (at ? at.getTime() : null);
  const moved =
    row === null ||
    stamp(row.sessionsInvalidBefore) !== stamp(basis.sessionsInvalidBefore) ||
    (basis.passwordHash !== undefined && basis.passwordHash !== row.passwordHash);
  if (moved) throw basis.refusal();
}
