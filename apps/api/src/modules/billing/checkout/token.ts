/**
 * The bearer token in a checkout page URL.
 *
 * 32 random bytes, so guessing one is not a strategy. Only its SHA-256 hash is
 * stored: a leaked database row or backup yields no working checkout link.
 */

import { createHash, randomBytes } from 'node:crypto';
import { CHECKOUT_TOKEN_PATTERN, type CheckoutPaymentMode } from '@rekey.dev/shared-types';

const TOKEN_BYTES = 32;

/**
 * A fresh token and the hash to store for it.
 *
 * @example
 * const { token, tokenHash } = mintCheckoutToken('test');
 * // token = 'chk_test_…', tokenHash = hashCheckoutToken(token)
 */
export function mintCheckoutToken(mode: CheckoutPaymentMode): { token: string; tokenHash: string } {
  const token = `chk_${mode}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { token, tokenHash: hashCheckoutToken(token) };
}

/**
 * @example
 * hashCheckoutToken('chk_test_…'); // 64 hex characters
 */
export function hashCheckoutToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The hash to look a presented token up by, or null when it is not even
 * shaped like one, so a malformed value never reaches the database.
 *
 * @example
 * lookupHashFor('../../etc'); // null
 */
export function lookupHashFor(token: string): string | null {
  return CHECKOUT_TOKEN_PATTERN.test(token) ? hashCheckoutToken(token) : null;
}
