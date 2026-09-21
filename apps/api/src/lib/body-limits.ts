/**
 * Per-route body-size ceilings for the credential tier (#555).
 *
 * Both rate checks on a credential route run at `preValidation` (their keys
 * need the parsed body and the resolved Application), and Fastify parses the
 * body between `onRequest` and `preValidation`, so neither one can stop a
 * 1 MiB sign-in body from being read first. `bodyLimit` can: Fastify refuses
 * on `Content-Length` before reading a byte, with no identity and no store.
 *
 * Each constant is a size class, and each sits well above the largest body
 * the routes in it could legally send. A cap that refuses a body the route's
 * own schema accepts is a narrower API, not a tighter one, so check the
 * derivation below before lowering one.
 */

import { METADATA_MAX_BYTES } from './metadata-limit.js';

/**
 * Email, password, token and code bodies: sign-in, magic link, password
 * reset, MFA, and the operator twins of each.
 *
 * The largest is /auth/mfa-verify at about 2.5 KB with every field at its
 * schema maximum (`mfaChallengeToken` 2048 + `code` 64 + the device binding).
 */
export const CREDENTIAL_BODY_LIMIT = 8 * 1024;

/**
 * Bodies carrying a token minted elsewhere: the OAuth token, introspection,
 * grant and authorize endpoints, the social-login callbacks, `oidc/assert`.
 *
 * `oidc/assert` sets the floor: its `idToken` may be 8192 characters, which
 * an 8 KiB class would refuse.
 */
export const TOKEN_BODY_LIMIT = 16 * 1024;

/**
 * WebAuthn ceremony responses, end-user and operator.
 *
 * Their `response` is an unbounded `object` in the schema, so the number
 * comes from the format: an attestation with a full X.509 chain (TPM, Android
 * Play Integrity) runs 5-8 KB base64url, before `clientDataJSON` and any
 * extension results.
 */
export const WEBAUTHN_BODY_LIMIT = 32 * 1024;

/**
 * Sign-up, the one credential route taking free-form `metadata`.
 *
 * A caller may legitimately fill `metadata` to `METADATA_MAX_BYTES`, and past
 * that the 400 `METADATA_TOO_LARGE` is a better error than a 413, so this has
 * to clear it, by enough that the ceiling, not the cap, is what answers.
 *
 * The two measure different bytes. `assertMetadataWithinLimit` serializes the
 * merged object with `JSON.stringify`, which emits every printable character
 * literally as UTF-8; `bodyLimit` counts what arrived on the wire, where the
 * same character may be `\uXXXX`. A client that escapes non-ASCII is not
 * exotic (Python's `json.dumps` does it by default), and for anything
 * outside Latin-1 that is 6 wire bytes against the 2 or 3 UTF-8 bytes the
 * ceiling counts, or 12 against 4 for an emoji. Three times, in other words:
 * at 2x, 16 KiB of escaped CJK metadata was refused 413 by the cap when the
 * ceiling would have accepted it. 4x carries that 3x plus the rest of the
 * body (email, password, the JSON structure) with room to spare, and is still
 * an order of magnitude under the global 1 MiB this class exists to avoid.
 *
 * A caller who escapes plain ASCII as well reaches 6x and gets the 413. That
 * is the honest answer: nothing legitimate produces it.
 */
export const SIGN_UP_BODY_LIMIT = 4 * METADATA_MAX_BYTES;

/**
 * RFC 7591 dynamic client registration.
 *
 * The outlier, and entirely the schema's doing: `redirect_uris` is 20 items
 * of 2048 characters, which is 40 KiB of URIs before the percent-encoding the
 * form-encoded variant of these routes adds. Tighten it by tightening
 * `redirect_uris`, not by lowering this.
 */
export const CLIENT_REGISTRATION_BODY_LIMIT = 128 * 1024;
