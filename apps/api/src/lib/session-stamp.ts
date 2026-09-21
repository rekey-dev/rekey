/**
 * The session kill switches.
 *
 * Two grains, and which one a revocation writes is the whole point.
 *
 * Per user: `EndUser.sessionsInvalidBefore` and `TenantUser.sessionsInvalidBefore`
 * are stamped ONLY by revocations that end every session the person holds:
 * password change or reset, sign-out everywhere, refresh-token reuse
 * detection. An access token whose `iat` falls before the stamp is refused on
 * its next use, whatever lifetime it was issued with. Compared at second
 * granularity because `iat` is seconds: a token minted in the same second as
 * the stamp survives, which is the pair the stamping request itself may hand
 * back.
 *
 * Per session: a single-session revoke and a device release or block must not
 * stamp, because the stamp ends the access token of the user's OTHER sessions
 * too, and clients that renew during a render (the panel, the portal) turn
 * that into a replayed refresh token and a full revoke. Those are refused
 * through the token's own claims instead: `sid` names the refresh-token
 * family, refused once its newest row is revoked; `dev` names the device,
 * refused once it is no longer ACTIVE. A token minted before `sid` existed
 * carries neither check and runs to its natural expiry.
 */
export function sessionIssuedBefore(claims: { iat?: number }, stamp: Date | null | undefined): boolean {
  if (!stamp) return false;
  // Every token this API mints carries `iat`; one without it is not ours, and
  // once a stamp exists it is refused rather than admitted.
  return typeof claims.iat !== 'number' || claims.iat < Math.floor(stamp.getTime() / 1000);
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
