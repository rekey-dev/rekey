/**
 * Operator personal-access-token (PAT) service.
 *
 * Mints, lists and revokes operator PATs (`rp_op_…`). Mirrors the
 * `api-keys.service.ts` create/redact/revoke flow exactly — the raw token is
 * returned **once at mint** and never again; only the SHA-256 hash is stored.
 *
 * An operator manages their OWN tokens only: every read/mutate is scoped by
 * `tenantUserId`, so one operator can never see or revoke another's PATs.
 *
 * Resolution of a presented PAT (looking up the operator + workspace behind a
 * raw token) lives in `middleware/operator-token-auth.ts`, mirroring how
 * `api-keys.service.verify` feeds the public-API auth middleware.
 */

import type { TenantApiToken } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import {
  generateOperatorToken,
  DEFAULT_OPERATOR_TOKEN_SCOPES,
  isOperatorTokenScope,
  type OperatorTokenScope,
} from '../../lib/operator-token.js';

/**
 * Public-safe shape of a PAT — `tokenHash` stripped. The hash is a
 * deterministic derivation of the raw token, not a secret in its own right,
 * but it never leaves the DB (mirrors `PublicApiKey`).
 */
export type PublicOperatorToken = Omit<TenantApiToken, 'tokenHash'>;

function redact(token: TenantApiToken): PublicOperatorToken {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tokenHash, ...rest } = token;
  return rest;
}

/** Per-operator cap. Mirrors `MAX_KEYS_PER_APP` — a sanity bound, not a quota. */
const MAX_TOKENS_PER_OPERATOR = 25;

export interface MintOperatorTokenInput {
  tenantUserId: string;
  tenantId: string;
  name: string;
  scopes: string[];
  expiresAt?: Date;
}

export interface MintOperatorTokenResult {
  token: PublicOperatorToken;
  /** Raw token. Show to the operator **once**, then forget. */
  rawToken: string;
}

/**
 * Validate + normalise the requested scopes. Default-deny: no scopes ⇒
 * `['read']`. Any unknown scope is rejected outright (fail closed) rather than
 * silently dropped, so a typo can't accidentally widen or narrow access in a
 * way the caller didn't intend.
 */
function normaliseScopes(requested: string[]): OperatorTokenScope[] {
  if (requested.length === 0) return [...DEFAULT_OPERATOR_TOKEN_SCOPES];
  const unknown = requested.filter((s) => !isOperatorTokenScope(s));
  if (unknown.length > 0) {
    throw new RekeyError({
      statusCode: 400,
      code: 'OPERATOR_SCOPE_UNKNOWN',
      message: `Unknown PAT scope(s): ${unknown.join(', ')}.`,
      fix: "Allowed scopes are 'read', 'applications:write', 'keys:mint'. Omit scopes for read-only.",
    });
  }
  // De-dupe while preserving the allowed-list order.
  return (Array.from(new Set(requested)) as OperatorTokenScope[]).filter(isOperatorTokenScope);
}

export const operatorTokensService = {
  /**
   * Mint a PAT for the operator, bound to the active workspace. Returns the
   * raw token ONCE. Default scopes = `['read']` (default-deny for writes).
   */
  async mint(input: MintOperatorTokenInput): Promise<MintOperatorTokenResult> {
    const scopes = normaliseScopes(input.scopes);

    // A non-future expiry would mint a token the auth middleware immediately
    // rejects as expired — a dead-on-arrival credential the operator was told
    // was "created". Fail fast with a clear error instead.
    if (input.expiresAt !== undefined && input.expiresAt.getTime() <= Date.now()) {
      throw new RekeyError({
        statusCode: 400,
        code: 'OPERATOR_TOKEN_EXPIRY_IN_PAST',
        message: `expiresAt (${input.expiresAt.toISOString()}) is not in the future — the token would be dead on arrival.`,
        fix: 'Pass a future expiresAt, or omit it for a non-expiring token.',
      });
    }

    const activeCount = await prisma.tenantApiToken.count({
      where: { tenantUserId: input.tenantUserId, revokedAt: null },
    });
    if (activeCount >= MAX_TOKENS_PER_OPERATOR) {
      throw new RekeyError({
        statusCode: 400,
        code: 'OPERATOR_TOKEN_LIMIT_REACHED',
        message: `You already have ${MAX_TOKENS_PER_OPERATOR} active personal-access-tokens.`,
        fix: 'Revoke an unused token before minting a new one.',
      });
    }

    const { raw, hash, prefix } = generateOperatorToken();

    const token = await prisma.tenantApiToken.create({
      data: {
        tenantUserId: input.tenantUserId,
        tenantId: input.tenantId,
        name: input.name,
        tokenPrefix: prefix,
        tokenHash: hash,
        scopes,
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      },
    });

    return { token: redact(token), rawToken: raw };
  },

  /** List the operator's active PATs, redacted (prefix only — hash never leaks). */
  async list(tenantUserId: string): Promise<PublicOperatorToken[]> {
    const tokens = await prisma.tenantApiToken.findMany({
      where: { tenantUserId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map(redact);
  },

  /**
   * Revoke one of the operator's PATs by id. Idempotent — re-revoking is fine.
   * Scoped by `tenantUserId` so an operator can only revoke their OWN tokens;
   * a token belonging to someone else reads as "not found" (no cross-operator
   * existence oracle).
   */
  async revoke(tenantUserId: string, id: string): Promise<PublicOperatorToken> {
    const token = await prisma.tenantApiToken.findUnique({ where: { id } });
    if (!token || token.tenantUserId !== tenantUserId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OPERATOR_TOKEN_NOT_FOUND',
        message: `Personal-access-token "${id}" not found.`,
        fix: 'List your tokens with GET /api/v1/tenant/auth/api-tokens.',
      });
    }
    if (token.revokedAt !== null) {
      return redact(token);
    }
    const revoked = await prisma.tenantApiToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return redact(revoked);
  },
};
