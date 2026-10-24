/**
 * Operator-registration policy, the single chokepoint that enforces
 * OPERATOR_SIGNUP_MODE at every path that would CREATE a new operator.
 *
 * Two creation paths exist in the codebase and BOTH route through here before
 * writing a TenantUser:
 *   1. password sign-up   → tenantAuthService.signUpAndCreateWorkspace
 *   2. OAuth first login   → tenantAuthService.findOrCreateOAuthOperator
 *
 * (Magic-link is sign-in only, it issues a token to an existing operator and
 * never creates one, so it needs no gate.)
 *
 * Modes:
 *   open    → no gate. `resolveSignupInvite` returns null, unless the key
 *             presented is bound to a workspace (see below).
 *   closed  → every new-operator creation is rejected (existing operators are
 *             unaffected; they sign in on a path that never reaches here).
 *   invite  → a valid, unused, unexpired, unrevoked invite key must be
 *             presented. `resolveSignupInvite` validates it and returns its id;
 *             the caller then `consumeSignupInvite` ATOMICALLY inside the same
 *             transaction that creates the operator.
 *
 * A workspace-bound key (minted with `tenantId` + `email`, e.g. by
 * `rekey init --owner-email`, or a teammate's workspace invitation link) is
 * honoured in open AND invite mode, because
 * ignoring it in open mode would hand its owner a new, empty workspace, the
 * exact failure it exists to prevent. Closed still refuses it: a closed
 * deployment creates no operators, and an existing operator redeems a bound
 * key through the invitation accept route instead.
 */

import type { OperatorInvite, Prisma, PrismaClient, TenantRole } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { RekeyError } from '../../lib/error.js';
import { prisma } from '../../lib/prisma.js';
import { hashOperatorInviteToken } from '../../lib/operator-invite.js';
import { hashInvitationToken } from '../../lib/tenant-invitations.js';
import { isOperatorInviteToken } from '../operator-invites/workspace-invite-redemption.js';

const ModeSchema = z.enum(['open', 'invite', 'closed']);
export type OperatorSignupMode = z.infer<typeof ModeSchema>;

/**
 * The active mode. Canonically defined + boot-validated in config/env.ts; read
 * live from process.env here so the mode can be flipped at runtime (and in
 * tests) without a process restart. An out-of-range live value falls back to
 * the boot-validated `env.OPERATOR_SIGNUP_MODE` (which itself defaults 'open'),
 * so a fat-fingered runtime override can never silently change behavior, the
 * boot value, which a typo would have crashed on, wins.
 */
export function operatorSignupMode(): OperatorSignupMode {
  const parsed = ModeSchema.safeParse(process.env.OPERATOR_SIGNUP_MODE);
  return parsed.success ? parsed.data : env.OPERATOR_SIGNUP_MODE;
}

/** Handle returned by `resolveSignupInvite`, pass to `consumeSignupInvite`. */
export interface ResolvedSignupInvite {
  inviteId: string;
  /** Claimed together with the id, so a link retired by a resend cannot finish a sign-up already under way. */
  tokenHash: string;
  /**
   * `workspace-invitation` is a teammate invitation link (`/accept-invite?token=…`)
   * presented at sign-up; `operator-invite` is a key the deployment administrator minted.
   */
  kind: 'operator-invite' | 'workspace-invitation';
  /** Present on a workspace-bound key: join this workspace instead of creating one. */
  workspace: WorkspaceBinding | null;
}

export interface WorkspaceBinding {
  tenantId: string;
  email: string;
  role: TenantRole;
}

interface SignupInviteCandidate extends ResolvedSignupInvite {
  revoked: boolean;
  used: boolean;
  expiresAt: Date | null;
}

function bindingOf(invite: OperatorInvite): WorkspaceBinding | null {
  if (invite.tenantId === null || invite.email === null || invite.role === null) return null;
  return { tenantId: invite.tenantId, email: invite.email, role: invite.role };
}

/**
 * Refuse a workspace-bound key presented for a different email. Without this a
 * forwarded or leaked link would let anyone join the workspace at its role.
 */
export function assertBoundEmail(binding: WorkspaceBinding, email: string): void {
  if (binding.email === email.trim().toLowerCase()) return;
  throw new RekeyError({
    statusCode: 403,
    code: 'OPERATOR_INVITE_EMAIL_MISMATCH',
    message: 'That invite key was issued for a different email address.',
    fix: 'Sign up with the email address the invite was sent to, or ask whoever invited you to invite your address.',
  });
}

/**
 * Apply the mode to a pending new-operator creation. Throws when registration
 * is not permitted. Returns the invite to consume, or null when no consumption
 * is required (mode='open' with no workspace-bound key).
 *
 * A teammate's workspace invitation counts as a workspace-bound key in open and
 * invite mode: the workspace owner vouched for that email, so invite-only
 * registration must not strand the person they invited.
 *
 * Does NOT mutate the invite, validation only. Consume happens later, inside
 * the operator-creation transaction, so a sign-up that fails afterwards (e.g.
 * duplicate email) does not burn the key.
 */
export async function resolveSignupInvite(
  rawKey: string | null | undefined,
): Promise<ResolvedSignupInvite | null> {
  const mode = operatorSignupMode();

  if (mode === 'closed') {
    throw new RekeyError({
      statusCode: 403,
      code: 'OPERATOR_SIGNUP_CLOSED',
      message: 'New operator registration is disabled on this deployment.',
      fix: 'Ask the deployment administrator to enable sign-up, or sign in with an existing operator account.',
    });
  }

  const key = (rawKey ?? '').trim();
  if (!key) {
    if (mode === 'open') return null;
    throw new RekeyError({
      statusCode: 403,
      code: 'OPERATOR_INVITE_REQUIRED',
      message: 'Operator registration on this deployment is invite-only.',
      fix: 'Open the invitation link a workspace owner sent you, or provide an invite key (field `inviteKey`) minted by the deployment administrator.',
    });
  }

  const candidate = await findSignupInvite(key);
  // Open mode needs no key, so an unbound or unknown one is ignored. A
  // workspace-bound one is validated and used.
  if (mode === 'open' && candidate?.workspace == null) return null;
  return usableInvite(candidate);
}

async function findSignupInvite(key: string): Promise<SignupInviteCandidate | null> {
  if (isOperatorInviteToken(key)) {
    const invite = await prisma.operatorInvite.findUnique({
      where: { tokenHash: hashOperatorInviteToken(key) },
    });
    if (!invite) return null;
    return {
      inviteId: invite.id,
      tokenHash: invite.tokenHash,
      kind: 'operator-invite',
      workspace: bindingOf(invite),
      revoked: invite.revokedAt !== null,
      used: invite.usedAt !== null,
      expiresAt: invite.expiresAt,
    };
  }
  const invitation = await prisma.tenantInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(key) },
  });
  if (!invitation) return null;
  return {
    inviteId: invitation.id,
    tokenHash: invitation.tokenHash,
    kind: 'workspace-invitation',
    workspace: { tenantId: invitation.tenantId, email: invitation.email.toLowerCase(), role: invitation.role },
    revoked: invitation.revokedAt !== null,
    used: invitation.acceptedAt !== null,
    expiresAt: invitation.expiresAt,
  };
}

function usableInvite(invite: SignupInviteCandidate | null): ResolvedSignupInvite {
  // Uniform error for unknown / revoked so a probe can't distinguish a wrong
  // key from a revoked one.
  if (!invite || invite.revoked) {
    throw new RekeyError({
      statusCode: 403,
      code: 'OPERATOR_INVITE_INVALID',
      message: 'That invite key is not valid.',
      fix: 'Check the link or key, or ask whoever invited you for a fresh one.',
    });
  }
  if (invite.used) {
    throw new RekeyError({
      statusCode: 409,
      code: 'OPERATOR_INVITE_USED',
      message: 'That invite key has already been used.',
      fix: 'An invite creates one account. If it was yours, sign in instead; otherwise ask whoever invited you for a fresh one.',
    });
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    throw new RekeyError({
      statusCode: 403,
      code: 'OPERATOR_INVITE_EXPIRED',
      message: 'That invite key has expired.',
      fix: 'Ask whoever invited you for a fresh invite.',
    });
  }

  return { inviteId: invite.inviteId, tokenHash: invite.tokenHash, kind: invite.kind, workspace: invite.workspace };
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
  const now = new Date();
  const res =
    invite.kind === 'workspace-invitation'
      ? await tx.tenantInvitation.updateMany({
          where: {
            id: invite.inviteId,
            tokenHash: invite.tokenHash,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { acceptedAt: now, acceptedById: tenantUserId },
        })
      : await tx.operatorInvite.updateMany({
          where: {
            id: invite.inviteId,
            tokenHash: invite.tokenHash,
            usedAt: null,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          data: { usedAt: now, usedByTenantUserId: tenantUserId },
        });
  if (res.count !== 1) {
    throw new RekeyError({
      statusCode: 409,
      code: 'OPERATOR_INVITE_USED',
      message: 'That invite was used or replaced while you were signing up.',
      fix: 'If the account is yours, sign in. Otherwise ask whoever invited you for a fresh link, or open the newest invitation email.',
    });
  }
}
