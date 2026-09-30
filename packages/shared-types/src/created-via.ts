import { z } from 'zod';

/**
 * How an end-user account was created. OAuth carries the provider after a
 * colon (`oauth:google`). `unknown` is never stored: it is how a row created
 * before the column existed reads.
 */
export const CREATED_VIA_KINDS = [
  'password',
  'magic_link',
  'oauth',
  'passkey',
  'operator',
  'import',
  'billing',
  'unknown',
] as const;
export type CreatedViaKind = (typeof CREATED_VIA_KINDS)[number];

/** One stored or filterable value: a kind, or `oauth:<provider>`. */
export const CREATED_VIA_PATTERN =
  /^(password|magic_link|oauth|passkey|operator|import|billing|unknown|oauth:[a-z0-9][a-z0-9_-]{0,39})$/;

export const CreatedViaSchema = z
  .string()
  .regex(CREATED_VIA_PATTERN, 'Use password, magic_link, oauth, oauth:<provider>, passkey, operator, import, billing or unknown.');

/**
 * The value to store for an account created by signing in with `provider`.
 *
 * @example
 *   createdViaOAuth('google') // 'oauth:google'
 */
export function createdViaOAuth(provider: string): string {
  const name = provider
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[_-]+/, '')
    .slice(0, 40);
  return name ? `oauth:${name}` : 'oauth';
}

/**
 * The kind a stored value belongs to, with null read as `unknown`.
 *
 * @example
 *   createdViaKind('oauth:github') // 'oauth'
 *   createdViaKind(null) // 'unknown'
 */
export function createdViaKind(value: string | null | undefined): CreatedViaKind {
  if (!value) return 'unknown';
  if (value.startsWith('oauth:')) return 'oauth';
  return (CREATED_VIA_KINDS as readonly string[]).includes(value) ? (value as CreatedViaKind) : 'unknown';
}
