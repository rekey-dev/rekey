import type { Prisma, TenantUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { invalidateOperatorAuth } from '../../lib/operator-auth-cache.js';
import { panelBaseUrl } from '../../lib/panel-url.js';
import { recordSecurityEventIn } from '../../lib/security-events.js';
import { lockOperatorCredentials } from '../../lib/session-basis.js';
import { emailService } from '../email/email.service.js';

/** How an operator sign-in proved the mailbox. A reset carries the password its holder just chose. */
export type OperatorMailboxProof = (
  | { via: 'magic_link' }
  | { via: 'oauth' }
  | { via: 'password_reset'; passwordHash: string }
) & { ip?: string | null; userAgent?: string | null };

export type OperatorClaim =
  | {
      kind: 'claimed';
      user: TenantUser;
      /** A password, passkey or access token was removed, so the address is owed the notice. */
      signInMethodsRemoved: boolean;
      /** What the claim did not touch in the workspaces the account owns, for the owner to look over. */
      review: WorkspaceReview[];
    }
  /** An enrolled second factor stands in the way: nothing changed, see `promoteOperatorAfterMfa`. */
  | { kind: 'held_for_mfa' }
  | { kind: 'already_verified' };

/** One workspace the claimed account owns or administers: who else is in it, and what is live in its Applications. */
export interface WorkspaceReview {
  tenantId: string;
  tenantName: string;
  /** The claimed account's role there: OWNER or ADMIN. */
  role: string;
  otherMembers: Array<{ name: string | null; email: string; role: string }>;
  /** Members beyond the ones listed, when the workspace has more than the list holds. */
  otherMembersNotListed: number;
  /** Applications in the workspace, disabled ones included: each holds users, plans and settings. */
  applications: number;
  liveApiKeys: number;
  /**
   * Of `liveApiKeys`, those with no recorded creator (minted before keys
   * recorded one, or with the super-admin key). The claim cannot tell whose
   * they are, so it did not revoke them.
   */
  unattributedApiKeys: number;
  /** Endpoints switched on. */
  webhookEndpoints: number;
  /** Of `webhookEndpoints`, those with no recorded creator, which the claim left on. */
  unattributedWebhookEndpoints: number;
  billingProviders: number;
}

const REVIEW_MEMBERS_LISTED = 25;

/**
 * What a claim leaves in place in the workspaces the account owns or
 * administers (an ADMIN can invite, mint keys and add endpoints too). Other
 * members are never removed automatically: most unconfirmed accounts belong
 * to the person who made them, and their colleagues are real. They are named
 * to the owner instead, in the security event and in the notice.
 */
async function reviewOwnedWorkspaces(tx: Prisma.TransactionClient, tenantUserId: string): Promise<WorkspaceReview[]> {
  const owned = await tx.tenantMembership.findMany({
    where: { tenantUserId, role: { in: ['OWNER', 'ADMIN'] } },
    orderBy: { createdAt: 'asc' },
    select: { tenantId: true, role: true, tenant: { select: { name: true } } },
  });
  const reviews: WorkspaceReview[] = [];
  for (const membership of owned) {
    const inWorkspace = { application: { tenantId: membership.tenantId } };
    const [
      others,
      otherCount,
      applications,
      liveApiKeys,
      unattributedApiKeys,
      webhookEndpoints,
      unattributedWebhookEndpoints,
      billingProviders,
    ] = await Promise.all([
      tx.tenantMembership.findMany({
        where: { tenantId: membership.tenantId, tenantUserId: { not: tenantUserId } },
        orderBy: { createdAt: 'asc' },
        take: REVIEW_MEMBERS_LISTED,
        select: { role: true, tenantUser: { select: { name: true, email: true } } },
      }),
      tx.tenantMembership.count({ where: { tenantId: membership.tenantId, tenantUserId: { not: tenantUserId } } }),
      tx.application.count({ where: { tenantId: membership.tenantId } }),
      tx.apiKey.count({ where: { ...inWorkspace, revokedAt: null } }),
      tx.apiKey.count({ where: { ...inWorkspace, revokedAt: null, createdByTenantUserId: null } }),
      tx.webhookEndpoint.count({ where: { ...inWorkspace, enabled: true } }),
      tx.webhookEndpoint.count({ where: { ...inWorkspace, enabled: true, createdByTenantUserId: null } }),
      tx.billingCredentials.count({ where: inWorkspace }),
    ]);
    reviews.push({
      tenantId: membership.tenantId,
      tenantName: membership.tenant.name,
      role: membership.role,
      otherMembers: others.map((m) => ({ name: m.tenantUser.name, email: m.tenantUser.email, role: m.role })),
      otherMembersNotListed: otherCount - others.length,
      applications,
      liveApiKeys,
      unattributedApiKeys,
      webhookEndpoints,
      unattributedWebhookEndpoints,
      billingProviders,
    });
  }
  return reviews;
}

/** Whether a review holds anything an owner who did not create the account would need to look at. */
export function reviewHasFindings(review: readonly WorkspaceReview[]): boolean {
  return review.some(
    (w) =>
      w.otherMembers.length > 0 ||
      w.applications > 0 ||
      w.liveApiKeys > 0 ||
      w.webhookEndpoints > 0 ||
      w.billingProviders > 0,
  );
}

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The review as the sentences the notice email carries, one per workspace.
 *
 * @example
 *   reviewSummary(claim.review)
 */
export function reviewSummary(review: readonly WorkspaceReview[]): string {
  if (review.length === 0) return 'This account owns or administers no workspace.';
  return review
    .map((w) => {
      const people = w.otherMembers.map((m) => `${m.name ? `${m.name}, ` : ''}${m.email}, ${m.role}`);
      if (w.otherMembersNotListed > 0) people.push(`and ${w.otherMembersNotListed} more, listed under Team in the panel`);
      const members =
        w.otherMembers.length === 0
          ? 'no other members'
          : `${counted(w.otherMembers.length + w.otherMembersNotListed, 'other member', 'other members')} (${people.join('; ')})`;
      const keys =
        counted(w.liveApiKeys, 'live API key', 'live API keys') +
        (w.unattributedApiKeys > 0
          ? `, of which ${w.unattributedApiKeys} ${w.unattributedApiKeys === 1 ? 'has' : 'have'} no recorded creator and ${w.unattributedApiKeys === 1 ? 'was' : 'were'} not revoked`
          : '');
      const endpoints =
        `${counted(w.webhookEndpoints, 'webhook endpoint', 'webhook endpoints')} switched on` +
        (w.unattributedWebhookEndpoints > 0
          ? `, of which ${w.unattributedWebhookEndpoints} ${w.unattributedWebhookEndpoints === 1 ? 'has' : 'have'} no recorded creator and ${w.unattributedWebhookEndpoints === 1 ? 'was' : 'were'} not switched off`
          : '');
      return `Workspace "${w.tenantName}" (you are ${w.role}): ${members}; ${counted(w.applications, 'Application', 'Applications')}; ${keys}; ${endpoints}; ${counted(w.billingProviders, 'billing provider', 'billing providers')} configured.`;
    })
    .join(' ');
}

/**
 * Hand an operator account whose address nobody had confirmed to the person
 * who just proved the mailbox.
 *
 * Operator sign-up asks for no proof of the address, so the password,
 * sessions, passkeys, access tokens and MCP grants on an unconfirmed account
 * belong to whoever registered first. Left in place they would be a way into
 * every workspace the real owner later joins, and to the billing credentials
 * stored there. All of them go in the same transaction as the `emailVerified`
 * flip, along with invitations that account sent and nobody accepted. The
 * row and its workspace memberships stay.
 *
 * Conditional on `emailVerified: false`, so of several proofs racing for one
 * account exactly one claims it. An enrolled second factor is neither removed
 * nor trusted here; the claim waits for the code.
 *
 * @example
 *   const claim = await prisma.$transaction((tx) => claimUnverifiedOperator(tx, user, { via: 'magic_link' }));
 */
export async function claimUnverifiedOperator(
  tx: Prisma.TransactionClient,
  user: Pick<TenantUser, 'id'>,
  provenBy: OperatorMailboxProof,
): Promise<OperatorClaim> {
  // The row first: a sign-in or refresh in flight either wrote its session
  // before this and loses it below, or looks at the row afterwards and finds
  // the stamp moved (lib/session-basis.ts).
  await lockOperatorCredentials(tx, user.id);
  const unverified = await tx.tenantUser.findFirst({
    where: { id: user.id, emailVerified: false },
    select: { passwordHash: true },
  });
  if (unverified === null) return { kind: 'already_verified' };
  const mfa = await tx.tenantMfaCredential.findUnique({
    where: { tenantUserId: user.id },
    select: { enrolledAt: true },
  });
  if (mfa?.enrolledAt) return { kind: 'held_for_mfa' };

  const now = new Date();
  const flipped = await tx.tenantUser.updateMany({
    where: { id: user.id, emailVerified: false },
    data: {
      emailVerified: true,
      passwordHash: provenBy.via === 'password_reset' ? provenBy.passwordHash : null,
      sessionsInvalidBefore: now,
    },
  });
  if (flipped.count !== 1) return { kind: 'already_verified' };

  const owned = { tenantUserId: user.id };
  const sessions = await tx.tenantRefreshToken.updateMany({
    where: { ...owned, revokedAt: null },
    data: { revokedAt: now },
  });
  const passkeys = await tx.tenantWebAuthnCredential.deleteMany({ where: owned });
  await tx.tenantMfaCredential.deleteMany({ where: owned });
  await tx.tenantPasswordResetToken.deleteMany({ where: { ...owned, consumedAt: null } });
  await tx.tenantMagicLinkToken.deleteMany({ where: { ...owned, consumedAt: null } });
  const accessTokens = await tx.tenantApiToken.updateMany({
    where: { ...owned, revokedAt: null },
    data: { revokedAt: now },
  });
  const mcpGrants = await tx.tenantMcpRefreshToken.updateMany({
    where: { ...owned, revokedAt: null },
    data: { revokedAt: now },
  });
  await tx.tenantOAuthAuthCode.deleteMany({ where: { ...owned, consumedAt: null } });
  const invitations = await tx.tenantInvitation.updateMany({
    where: { invitedById: user.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  // Application keys this operator minted and endpoints it created, where the
  // row says so. Both were made before anyone confirmed the address. The keys
  // are revoked. The endpoints are switched off, not deleted: their delivery
  // history is evidence, and the owner can switch one back on.
  const apiKeys = await tx.apiKey.updateMany({
    where: { createdByTenantUserId: user.id, revokedAt: null },
    data: { revokedAt: now },
  });
  const webhooks = await tx.webhookEndpoint.updateMany({
    where: { createdByTenantUserId: user.id, enabled: true },
    data: { enabled: false },
  });
  // An impersonation this operator started is a five-minute end-user token
  // in the first registrant's hands. Ending its audit row ends the token.
  const impersonations = await tx.impersonationAudit.updateMany({
    where: { operatorUserId: user.id, endedAt: null },
    data: { endedAt: now },
  });
  const review = await reviewOwnedWorkspaces(tx, user.id);

  const claimed = await tx.tenantUser.findUniqueOrThrow({ where: { id: user.id } });
  const home = await tx.tenantMembership.findFirst({
    where: owned,
    orderBy: { createdAt: 'asc' },
    select: { tenantId: true },
  });
  await recordSecurityEventIn(tx, {
    type: 'auth.unverified_account_claimed',
    actorType: 'operator',
    actorId: user.id,
    tenantId: home?.tenantId ?? null,
    ip: provenBy.ip ?? null,
    userAgent: provenBy.userAgent ?? null,
    metadata: {
      provenBy: provenBy.via,
      passwordRemoved: unverified.passwordHash !== null && provenBy.via !== 'password_reset',
      passwordReplaced: provenBy.via === 'password_reset',
      sessionsRevoked: sessions.count,
      passkeysRemoved: passkeys.count,
      accessTokensRevoked: accessTokens.count,
      mcpGrantsRevoked: mcpGrants.count,
      invitationsRevoked: invitations.count,
      apiKeysRevoked: apiKeys.count,
      webhookEndpointsDisabled: webhooks.count,
      impersonationsEnded: impersonations.count,
      // Left in place for the owner to look over: see `WorkspaceReview`.
      review,
    },
  });
  return {
    kind: 'claimed',
    user: claimed,
    signInMethodsRemoved:
      (unverified.passwordHash !== null && provenBy.via !== 'password_reset') ||
      passkeys.count > 0 ||
      accessTokens.count > 0 ||
      mcpGrants.count > 0 ||
      apiKeys.count > 0 ||
      webhooks.count > 0,
    review,
  };
}

/**
 * Finish a claim that waited on a second factor. The mailbox proof came with
 * the challenge and the code proves the prover enrolled that factor, so the
 * account was theirs all along: promote it and remove nothing.
 *
 * @example
 *   if (claims.mbx) user = await promoteOperatorAfterMfa(user.id);
 */
export async function promoteOperatorAfterMfa(tenantUserId: string): Promise<TenantUser> {
  const user = await prisma.tenantUser.update({
    where: { id: tenantUserId },
    data: { emailVerified: true },
  });
  invalidateOperatorAuth(tenantUserId);
  return user;
}

/**
 * Tell the address what was removed and what was left for it to look over.
 * A security notice, so it is never counted against the per-recipient cap.
 * Fire and forget.
 *
 * @example
 *   sendOperatorClaimedEmail(claim.user, claim.review);
 */
export function sendOperatorClaimedEmail(
  user: Pick<TenantUser, 'id' | 'email'>,
  review: readonly WorkspaceReview[],
): void {
  void (async (): Promise<void> => {
    const home = await prisma.tenantMembership.findFirst({
      where: { tenantUserId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { tenantId: true },
    });
    await emailService.dispatchSystem({
      eventKey: 'operator_account_claimed',
      to: user.email,
      variables: {
        userEmail: user.email,
        claimedAtIso: new Date().toISOString(),
        appUrl: panelBaseUrl() ?? '',
        reviewSummary: reviewSummary(review),
      },
      tenantId: home?.tenantId ?? null,
    });
  })().catch(() => undefined);
}

export {
  assertOperatorVerifiedForCredential,
  operatorConfirmation,
  operatorConfirmationFix,
} from './operator-confirmation.js';
