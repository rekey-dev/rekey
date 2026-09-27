/**
 * Signed one-click unsubscribe tokens for `notification` custom mail.
 *
 * Format: `keyId.payload.signature`. The payload names the Application, the
 * address and the category being left. Tokens never expire, because an
 * unsubscribe link in a two-year-old email must still work, so the signing key
 * is rotatable: `EMAIL_UNSUBSCRIBE_SECRET` signs under
 * `EMAIL_UNSUBSCRIBE_SECRET_ID`, and `EMAIL_UNSUBSCRIBE_PREVIOUS_SECRETS` keeps
 * old keys verifying. With no secret configured the key is derived from
 * JWT_SECRET under key id `jwt`, and those tokens stay valid until JWT_SECRET
 * changes. The worst a leaked key allows is unsubscribing addresses.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../../config/env.js';
import { publicApiOrigin } from '../../../lib/public-api-origin.js';

const PURPOSE = 'rekey:email-unsubscribe:v1';
const DERIVED_KEY_ID = 'jwt';

export type UnsubscribeCategory = 'notification';

export interface UnsubscribeTarget {
  applicationId: string;
  address: string;
  category: UnsubscribeCategory;
}

function derivedKey(): Buffer {
  return createHmac('sha256', env.JWT_SECRET).update(PURPOSE).digest();
}

/** Every key a token may verify against, by id. The first entry signs. */
export function unsubscribeKeys(): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  if (env.EMAIL_UNSUBSCRIBE_SECRET) {
    keys.set(env.EMAIL_UNSUBSCRIBE_SECRET_ID, Buffer.from(env.EMAIL_UNSUBSCRIBE_SECRET));
  }
  for (const entry of (env.EMAIL_UNSUBSCRIBE_PREVIOUS_SECRETS ?? '').split(',')) {
    const at = entry.indexOf(':');
    if (at <= 0) continue;
    const id = entry.slice(0, at).trim();
    const secret = entry.slice(at + 1).trim();
    if (id && secret && !keys.has(id)) keys.set(id, Buffer.from(secret));
  }
  if (!keys.has(DERIVED_KEY_ID)) keys.set(DERIVED_KEY_ID, derivedKey());
  return keys;
}

function sign(key: Buffer, keyId: string, payload: string): string {
  return createHmac('sha256', key).update(`${keyId}.${payload}`).digest('base64url');
}

export function createUnsubscribeToken(
  applicationId: string,
  address: string,
  category: UnsubscribeCategory = 'notification',
): string {
  const [keyId, key] = unsubscribeKeys().entries().next().value as [string, Buffer];
  const payload = Buffer.from(
    JSON.stringify({ a: applicationId, e: address.trim().toLowerCase(), c: category }),
  ).toString('base64url');
  return `${keyId}.${payload}.${sign(key, keyId, payload)}`;
}

/** What a token names, or null for anything this deployment did not sign. */
export function verifyUnsubscribeToken(token: string): UnsubscribeTarget | null {
  const [keyId, payload, signature, extra] = token.split('.');
  if (!keyId || !payload || !signature || extra !== undefined) return null;
  const key = unsubscribeKeys().get(keyId);
  if (!key) return null;
  const expected = Buffer.from(sign(key, keyId, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { a, e, c } = parsed as { a?: unknown; e?: unknown; c?: unknown };
    if (typeof a !== 'string' || typeof e !== 'string' || a.length === 0 || e.length === 0) return null;
    if (c !== 'notification') return null;
    return { applicationId: a, address: e, category: c };
  } catch {
    return null;
  }
}

/**
 * The link for a List-Unsubscribe header, or null when this deployment has no
 * public origin: a container name such as `http://api:3030` is unreachable from
 * a mailbox, and a header pointing at it would promise an unsubscribe that
 * cannot happen.
 */
export function unsubscribeUrl(applicationId: string, address: string): string | null {
  const origin = publicApiOrigin();
  if (origin === null) return null;
  return `${origin.replace(/\/+$/, '')}/api/v1/email/unsubscribe?token=${createUnsubscribeToken(applicationId, address)}`;
}
