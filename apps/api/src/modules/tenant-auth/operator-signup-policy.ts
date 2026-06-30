/**
 * Operator-registration policy — the single chokepoint that enforces
 * OPERATOR_SIGNUP_MODE at every path that would CREATE a new operator.
 *
 * Two creation paths exist in the codebase and BOTH route through here before
 * writing a TenantUser:
 *   1. password sign-up   → tenantAuthService.signUpAndCreateWorkspace
 *   2. OAuth first login   → tenantAuthService.findOrCreateOAuthOperator
 *
 * (Magic-link is sign-in only — it issues a token to an existing operator and
 * never creates one — so it needs no gate.)
 *
 * Modes:
 *   open    → no gate (today's behavior). `resolveSignupInvite` returns null.
 *   closed  → every new-operator creation is rejected (existing operators are
 *             unaffected; they sign in on a path that never reaches here).
 *   invite  → a valid, unused, unexpired, unrevoked invite key must be
 *             presented. `resolveSignupInvite` validates it and returns its id;
 *             the caller then `consumeSignupInvite` ATOMICALLY inside the same
 *             transaction that creates the operator.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { RelipayError } from '../../lib/error.js';
import { prisma } from '../../lib/prisma.js';
import { hashOperatorInviteToken } from '../../lib/operator-invite.js';

const ModeSchema = z.enum(['open', 'invite', 'closed']);
export type OperatorSignupMode = z.infer<typeof ModeSchema>;

/**
 * The active mode. Canonically defined + boot-validated in config/env.ts; read
 * live from process.env here so the mode can be flipped at runtime (and in
 * tests) without a process restart. An out-of-range live value falls back to
 * the boot-validated `env.OPERATOR_SIGNUP_MODE` (which itself defaults 'open'),
 * so a fat-fingered runtime override can never silently change behavior — the
 * boot value, which a typo would have crashed on, wins.
 */
export function operatorSignupMode(): OperatorSignupMode {
  const parsed = ModeSchema.safeParse(process.env.OPERATOR_SIGNUP_MODE);
  return parsed.success ? parsed.data : env.OPERATOR_SIGNUP_MODE;
}

/** Opaque handle returned by `resolveSignupInvite` — pass to `consumeSignupInvite`. */
export interface ResolvedSignupInvite {
  inviteId: string;
}

/**
 * Apply the mode to a pending new-operator creation. Throws when registration
 * is not permitted. Returns the invite to consume (mode='invite'), or null
 * when no consumption is required (mode='open').
 *
 * Does NOT mutate the invite — validation only. Consume happens later, inside
 * the operator-creation transaction, so a sign-up that fails afterwards (e.g.
 * duplicate email) does not burn the key.
 */
export async function resolveSignupInvite(
  rawKey: string | null | undefined,
): Promise<ResolvedSignupInvite | null> {
  const mode = operatorSignupMode();

  if (mode === 'open') return null;

  if (mode === 'closed') {
    throw new RelipayError({
      statusCode: 403,
      code: 'OPERATOR_SIGNUP_CLOSED',
      message: 'New operator registration is disabled on this deployment.',
      fix: 'Ask the deployment administrator to enable sign-up, or sign in with an existing operator account.',
    });
  }

  // mode === 'invite'
  const key = (rawKey ?? '').trim();
  if (!key) {
    throw new RelipayError({
      statusCode: 403,
      code: 'OPERATOR_INVITE_REQUIRED',
      message: 'Operator registration on this deployment is invite-only.',
      fix: 'Provide a valid invite key (field `inviteKey`) minted by the deployment administrator.',
    });
  }

  const invite = await prisma.operatorInvite.findUnique({
    where: { tokenHash: hashOperatorInviteToken(key) },
  });
  // Uniform error for unknown / revoked so a probe can't distinguish a wrong
  // key from a revoked one.
  if (!invite || invite.revokedAt) {
    throw new RelipayError({
      statusCode: 403,
      code: 'OPERATOR_INVITE_INVALID',
      message: 'That invite key is not valid.',
      fix: 'Check the key, or ask the deployment administrator for a fresh one.',
    });
  }
  if (invite.usedAt) {
    throw new RelipayError({
      statusCode: 409,
      code: 'OPERATOR_INVITE_USED',
      message: 'That invite key has already been used.',
      fix: 'Each invite key creates exactly one operator. Ask the administrator for a fresh key.',
    });
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    throw new RelipayError({
      statusCode: 403,
      code: 'OPERATOR_INVITE_EXPIRED',
      message: 'That invite key has expired.',
      fix: 'Ask the deployment administrator for a fresh invite key.',
    });
  }

  return { inviteId: invite.id };
}

type TxClient = Prisma.TransactionClient | PrismaClient;

/**
 * Atomically consume the resolved invite, binding it to the operator just
 * created. MUST run inside the same transaction as the TenantUser insert.
 *
 * The single-use guarantee lives in the WHERE clause: only a row that is still
 * `usedAt IS NULL AND revokedAt IS NULL` is updated. If a concurrent sign-up
 * already consumed it (count = 0), we throw and the surrounding transaction
 * rolls back the half-created operator.
 */
export async function consumeSignupInvite(
  tx: TxClient,
  invite: ResolvedSignupInvite,
  tenantUserId: string,
): Promise<void> {
  const res = await tx.operatorInvite.updateMany({
    where: { id: invite.inviteId, usedAt: null, revokedAt: null },
    data: { usedAt: new Date(), usedByTenantUserId: tenantUserId },
  });
  if (res.count !== 1) {
    throw new RelipayError({
      statusCode: 409,
      code: 'OPERATOR_INVITE_USED',
      message: 'That invite key was just used by another sign-up.',
      fix: 'Each invite key creates exactly one operator. Ask the administrator for a fresh key.',
    });
  }
}
