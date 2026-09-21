/**
 * The size ceiling on free-form `metadata` blobs.
 *
 * `metadata` is free-form and, on end-users and organizations, writable by
 * the people it describes, which makes it the one place in the schema where
 * a signed-in user chooses how many bytes are stored per row forever. 16 KB is
 * far above any legitimate "display name, avatar URL, a few custom fields"
 * payload and far below the size at which a jsonb column starts hurting the
 * queries that select whole rows on the hot auth path. Measured after the
 * merge, not on the request body, because a stream of small patches is the
 * way one would grow it past the limit otherwise.
 *
 * Applies to every writer that accepts caller-supplied metadata: end-users
 * (sign-up, self-service PATCH, import), organizations, plans, coupons,
 * licences, usage records and credit drawdowns. Provider-written metadata on
 * subscriptions and payments is not covered, because its size is the
 * provider's choice rather than a caller's. It first shipped on the end-user
 * self-service PATCH alone, which meant a
 * 200 KB blob posted at sign-up was stored and then permanently bricked that
 * user's own PATCH route: the cap is measured post-merge, so every later
 * self-service write failed on bytes the user could no longer remove. A
 * ceiling one writer enforces is a bug in the other writers, not a ceiling.
 */

import { RekeyError } from './error.js';

export const METADATA_MAX_BYTES = 16 * 1024;

export function assertMetadataWithinLimit(metadata: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  if (bytes > METADATA_MAX_BYTES) {
    throw new RekeyError({
      statusCode: 400,
      code: 'METADATA_TOO_LARGE',
      message: `Metadata would be ${bytes} bytes after merging; the limit is ${METADATA_MAX_BYTES}.`,
      fix: 'Store large values (files, documents, long text) in your own storage and keep only a reference here.',
    });
  }
}
