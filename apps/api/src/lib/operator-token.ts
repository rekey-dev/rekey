/**
 * Operator personal-access-token (PAT) generation + resolution.
 *
 * A PAT is a long-lived, revocable, scoped credential an operator (or an AI
 * agent acting as them) presents as `Authorization: Bearer rp_op_…` to call
 * tenant-scoped routes — replacing reliance on the global SUPER_ADMIN_KEY.
 *
 * Crypto policy mirrors `lib/keys.ts` exactly: the raw token is a high-entropy
 * random string, stored only as its SHA-256 hash (`hashKey`). We do NOT invent
 * new hashing here. The raw token is shown to the operator exactly once at mint
 * and is unrecoverable after. Verification is a direct hash lookup against the
 * unique `token_hash` index — no scan, no timing oracle.
 */

import { randomBytes } from 'node:crypto';
import { hashKey } from './keys.js';

/** Clear, greppable prefix so a leaked operator PAT is identifiable at a glance. */
export const OPERATOR_TOKEN_PREFIX = 'rp_op';

/**
 * Allowed PAT scopes. Default-deny: an empty scope set grants nothing beyond
 * `read`. Writes require an explicit scope.
 *
 *   - `read`               — read-only tenant introspection (the safe default).
 *   - `applications:write` — create/update Applications in the workspace.
 *   - `keys:mint`          — mint Application API keys (the highest-privilege
 *                            scope; what the MCP `mint_api_key` tool needs).
 */
export const OPERATOR_TOKEN_SCOPES = ['read', 'applications:write', 'keys:mint'] as const;
export type OperatorTokenScope = (typeof OPERATOR_TOKEN_SCOPES)[number];

/** Default scope when a mint request supplies none — read only (default-deny for writes). */
export const DEFAULT_OPERATOR_TOKEN_SCOPES: OperatorTokenScope[] = ['read'];

/** True if `value` is one of the allowed scopes. */
export function isOperatorTokenScope(value: string): value is OperatorTokenScope {
  return (OPERATOR_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** True if the value looks like an operator PAT. Cheap pre-filter. */
export function isOperatorToken(value: string): boolean {
  return value.startsWith(`${OPERATOR_TOKEN_PREFIX}_`);
}

export interface GeneratedOperatorToken {
  /** Raw token. Show to the operator **once**, then forget. Never stored. */
  raw: string;
  /** SHA-256(raw) — store this. */
  hash: string;
  /** First chars for UI list display, e.g. "rp_op_aBc1…". Never the raw token. */
  prefix: string;
}

/**
 * Generate an operator PAT. Returns the raw token (show once), its hash (store)
 * and a short display prefix (show in lists).
 *
 * @example
 * ```ts
 * const { raw, hash, prefix } = generateOperatorToken();
 * // raw    → "rp_op_oQa9k…32-byte-token…"  ← give to operator, never store
 * // hash   → "5b2d…"                         ← store this
 * // prefix → "rp_op_oQa9"                    ← show in lists for identification
 * ```
 */
export function generateOperatorToken(): GeneratedOperatorToken {
  const raw = `${OPERATOR_TOKEN_PREFIX}_${randomBytes(24).toString('base64url')}`;
  const hash = hashKey(raw);
  // First 4 chars of the random portion, for UI list display.
  const prefix = raw.slice(0, OPERATOR_TOKEN_PREFIX.length + 1 + 4);
  return { raw, hash, prefix };
}

/** SHA-256 hash of a raw operator PAT — the DB lookup key. Re-exports keys.hashKey. */
export function hashOperatorToken(raw: string): string {
  return hashKey(raw);
}
