/**
 * OIDC `profile` claims: where they are stored, and who is allowed to write
 * them.
 *
 * The provider originally read the claims straight off the top level of
 * `EndUser.metadata`, on the stated assumption that the OPERATOR was the only
 * writer of that column. `PATCH /api/v1/users/me` ended that assumption the
 * hour it merged: an end-user holding nothing but a publishable key and their
 * own session could set `metadata.preferred_username` to `"admin"` and have it
 * arrive verbatim in an `id_token` AND at `/userinfo`. Grafana, Gitea, Argo CD,
 * Vault, Nextcloud and Keycloak brokering all provision or match local accounts
 * on `preferred_username`, so that is impersonation with one PATCH.
 *
 * The claims therefore live in a RESERVED sub-object — `metadata.oidc` — that
 * every end-user-authenticated write path refuses. The rest of `metadata` stays
 * exactly as free-form as it was, which is the point: reserving the claim names
 * themselves would have made `name` and `picture` unwritable through the
 * self-service route whose entire stated use case is "display name, avatar and
 * custom fields". One reserved key costs an integrator nothing; five reserved
 * words in the middle of their own profile object costs them the feature.
 *
 * Nothing here reads the database or the request — it is pure shaping, so both
 * the write guard and the claim reader are unit-testable on their own and the
 * two can never drift apart about which keys are claims.
 */

import { RekeyError } from './error.js';

/**
 * The reserved top-level key inside `EndUser.metadata`. Its value is an object
 * whose keys are OIDC claim names.
 */
export const OIDC_METADATA_NAMESPACE = 'oidc';

/**
 * The `profile` scope's claims, as a strict ALLOWLIST of standard OIDC names.
 *
 * This list is the ONLY thing standing between `EndUser.metadata` and an
 * `id_token`, so it must never grow to include a name the API itself gives
 * meaning to. `typ`, `applicationId` and `gen` are the claims an access token
 * is authenticated by, and `sub`/`iss`/`aud` are the ones cross-application
 * isolation rests on: any of those appearing here would turn a profile edit
 * into account takeover across Applications. `issueIdToken` strips them
 * defensively as well, and a test asserts both halves.
 */
export const PROFILE_METADATA_CLAIMS = [
  'name',
  'given_name',
  'family_name',
  'preferred_username',
  'picture',
] as const;

/**
 * Per-claim ceiling, applied when the claim is READ.
 *
 * The 16KB ceiling on the whole `metadata` object is not a bound on any single
 * claim: a 15KB `name` fits inside it and produced a 164,620-byte `id_token`
 * plus a 122KB `/userinfo` body — an attacker-chosen payload every relying
 * party has to parse before it can decide it doesn't like it. Bounding at read
 * time rather than only at write time means an oversized value already sitting
 * in a row cannot mint one of those tokens either.
 *
 * 256 characters is past any real display name; `picture` gets more room
 * because signed CDN URLs are genuinely long, and less than the 16KB blob
 * because a `picture` beyond half a kilobyte is a data URI, not a link.
 */
const CLAIM_MAX_LENGTH = 256;
const PICTURE_MAX_LENGTH = 512;

/** Over-long or malformed values are DROPPED, not errors — see `profileClaims`. */
function acceptableClaimValue(claim: string, value: unknown): value is string {
  // Strings only. A number or object under `name` is the app's data, not a
  // claim value, and shipping it would hand RPs a type they can't parse.
  if (typeof value !== 'string' || value.length === 0) return false;
  if (claim === 'picture') {
    if (value.length > PICTURE_MAX_LENGTH) return false;
    // `picture` is the one claim an RP renders. `javascript:alert(...)` stored
    // here reached both the ID Token and `/userinfo` verbatim, and an RP that
    // drops it into an `<img src>` or an anchor inherits the payload. https
    // only — not even http, because a mixed-content avatar is a broken avatar.
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }
  return value.length <= CLAIM_MAX_LENGTH;
}

/**
 * Read the operator-written `profile` claims out of an `EndUser.metadata` blob.
 *
 * Contributes nothing rather than throwing for a malformed blob: `metadata` is
 * `Json?`, so it can legitimately be a bare string or an array, and a token
 * mint must not 500 because someone stored the wrong shape years ago.
 */
export function profileClaims(metadata: unknown): Record<string, string> {
  const claims: Record<string, string> = {};
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return claims;
  const namespaced = (metadata as Record<string, unknown>)[OIDC_METADATA_NAMESPACE];
  if (namespaced === null || typeof namespaced !== 'object' || Array.isArray(namespaced)) {
    return claims;
  }
  const source = namespaced as Record<string, unknown>;
  for (const claim of PROFILE_METADATA_CLAIMS) {
    const value = source[claim];
    if (acceptableClaimValue(claim, value)) claims[claim] = value;
  }
  return claims;
}

/**
 * Refuse a metadata write that names the reserved namespace.
 *
 * Called on the paths an END-USER can reach — `PATCH /api/v1/users/me` and
 * sign-up with a publishable key. Refused loudly (400) rather than dropped
 * silently, matching the rest of the self-service allowlist: an integrator who
 * tries to set their own claims learns immediately instead of shipping code
 * that appears to work.
 *
 * Operator surfaces (a secret key, the tenant end-user routes, the panel) do
 * NOT call this. They are the intended writer.
 */
export function assertNoReservedMetadataKey(metadata: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(metadata, OIDC_METADATA_NAMESPACE)) return;
  throw new RekeyError({
    statusCode: 400,
    code: 'METADATA_KEY_RESERVED',
    message: `The metadata key "${OIDC_METADATA_NAMESPACE}" is reserved and cannot be set from an end-user session or a publishable key.`,
    fix: `"${OIDC_METADATA_NAMESPACE}" holds the OIDC identity claims this Application asserts about the user (name, preferred_username, picture), so only the operator may write it — use PATCH /api/v1/tenant/applications/:id/end-users/:endUserId, or a secret key. Store your own profile fields under any other key.`,
  });
}
