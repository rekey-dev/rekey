/**
 * The session kill switches.
 *
 * Two grains, and which one a revocation writes is the whole point.
 *
 * Per user: `EndUser.sessionsInvalidBefore` and `TenantUser.sessionsInvalidBefore`
 * are stamped ONLY by revocations that end every session the person holds:
 * password change or reset, sign-out everywhere, refresh-token reuse
 * detection. An access token whose `iat` falls before the stamp is refused on
 * its next use, whatever lifetime it was issued with.
 *
 * How it is compared depends on whether the token names a session. One that
 * carries `sid` is also answered for by its refresh family, which the same
 * revocation revoked under the account's row lock, so the stamp is compared
 * at second granularity and strictly: a token minted in the same second as
 * the stamp survives the stamp, which is what the stamping request's own new
 * session needs, and an older session minted in that second is ended by its
 * `sid` instead. One that names no session (an MCP access token, a consent
 * token) has nothing else to end it, so it carries its issue time in
 * milliseconds (`iat_ms`) and is refused when minted at or before the stamp.
 * Those tokens are always minted before the row their grant is written to,
 * so nothing minted before a revocation commits can carry a later time.
 *
 * Both times come from the clock of the API instance that wrote them, the
 * stamp from the one that revoked and `iat_ms` from the one that minted. On
 * one instance that is one clock. Across instances the comparison is as good
 * as their clocks agree, so a token minted on a fast instance within the skew
 * before a revocation on a slow one outlives it, until it expires. The stamp
 * is not taken from the database clock instead, because session tokens are
 * compared to the same stamp by whole seconds: with the database a second
 * ahead of an instance, the session that instance issues straight after a
 * claim or a password change would be refused. What skew cannot touch is the
 * grant behind such a token: refresh rows are revoked, and codes and
 * challenges are bound to the stamp they saw, under the account's row lock.
 *
 * Per session: a single-session revoke and a device release or block must not
 * stamp, because the stamp ends the access token of the user's OTHER sessions
 * too, and clients that renew during a render (the panel, the portal) turn
 * that into a replayed refresh token and a full revoke. Those are refused
 * through the token's own claims instead: `sid` names the refresh-token
 * family, refused once its newest row is revoked; `dev` names the device,
 * refused once it is no longer ACTIVE. A token minted with no session carries
 * neither check and runs to its natural expiry.
 */
export function sessionIssuedBefore(claims: { iat?: number }, stamp: Date | null | undefined): boolean {
  if (!stamp) return false;
  // Every token this API mints carries `iat`; one without it is not ours, and
  // once a stamp exists it is refused rather than admitted.
  return typeof claims.iat !== 'number' || claims.iat < Math.floor(stamp.getTime() / 1000);
}

/**
 * The stamp check for a token that names no session and carries `iat_ms` (an
 * MCP access token, a consent token, an MFA challenge): refused when minted
 * at or before the stamp. Every such token this API mints carries `iat_ms`,
 * so one without it is refused whether or not a stamp exists.
 *
 * @example
 *   if (unanchoredTokenEnded(claims, user.sessionsInvalidBefore)) return null;
 */
export function unanchoredTokenEnded(
  claims: { iat_ms?: number },
  stamp: Date | null | undefined,
): boolean {
  if (typeof claims.iat_ms !== 'number') return true;
  return stamp ? claims.iat_ms <= stamp.getTime() : false;
}

/**
 * The stamp check for an access token that may or may not name a session.
 * One minted with no session (`sessionId` is optional when one is issued)
 * has no refresh family to end it and no `iat_ms`, so it is refused through
 * the end of the stamp's second.
 *
 * @example
 *   if (accessTokenEndedByStamp(claims, user.sessionsInvalidBefore)) throw sessionEndedEverywhere();
 */
export function accessTokenEndedByStamp(
  claims: { iat?: number; sid?: string },
  stamp: Date | null | undefined,
): boolean {
  if (claims.sid) return sessionIssuedBefore(claims, stamp);
  if (!stamp) return false;
  return typeof claims.iat !== 'number' || claims.iat <= Math.floor(stamp.getTime() / 1000);
}

/**
 * True when the token's own session is over. `head` is the newest row of the
 * `sid` family (`replacedById` null), or null when none was found. The
 * callers read only a LIVE head (`revokedAt` null too), so a revoked head
 * arrives here as null; both mean ended, and the revokedAt check stays for any
 * caller that reads the newest row whatever its state. `device`
 * is the row `dev` names, or null. Both are looked up only when the claim is
 * present. A missing head counts as ended: rows are pruned only long after
 * any access token minted from them has expired.
 */
export function sessionEnded(
  claims: { sid?: string; dev?: string },
  head: { revokedAt: Date | null } | null,
  device: { status: string } | null,
): boolean {
  if (claims.sid && (!head || head.revokedAt !== null)) return true;
  if (claims.dev && (!device || device.status !== 'ACTIVE')) return true;
  return false;
}
