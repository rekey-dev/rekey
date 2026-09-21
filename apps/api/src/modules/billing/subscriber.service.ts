/**
 * The subscriber a billing event names, found or created.
 *
 * A checkout starts with a signed-in end-user, so every event the hosted
 * providers send is about somebody Rekey already knows. An external billing
 * system has no such guarantee: it reports a sale the moment it happens, and
 * the buyer may never have opened the application. Refusing the event until
 * they sign up would lose the sale on a retry schedule the sender controls,
 * and would make "paid, then let in" depend on the order two unrelated
 * systems happen to run in.
 *
 * So the applier creates the end-user. Deliberately a thin account: no
 * password, the default role, the address marked verified unless the sender
 * says otherwise. A later sign-in claims it, either through an OIDC or OAuth
 * provider that vouches for the same verified address (the callback links by
 * email), or through a password reset, which is how a person proves they
 * hold an address Rekey already has on file.
 *
 * Every creation is written to the security-event trail and announced with
 * the same `user.created` webhook a sign-up emits, with `via` naming the
 * provider, so an operator can see which accounts exist because a billing
 * system said so.
 */

import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { assertEndUserQuota } from '../../lib/tenant-limits.js';
import { applicationRolesService } from '../application-roles/application-roles.service.js';
import { emitDetached } from '../webhooks/webhook.service.js';

export type SubscriberRef = { endUserId: string } | { email: string; emailVerified?: boolean };

export interface ResolveSubscriberInput {
  application: { id: string; tenantId: string };
  subscriber: SubscriberRef;
  /** The provider module whose event named the subscriber, for the trail. */
  provider: string;
  providerEventId: string;
  log?: FastifyBaseLogger;
}

export interface ResolvedSubscriber {
  id: string;
  email: string;
  /** True when THIS call created the account. */
  created: boolean;
}

const select = { id: true, email: true, erasedAt: true } as const;

export const subscriberService = {
  async resolveOrCreate(input: ResolveSubscriberInput): Promise<ResolvedSubscriber> {
    const applicationId = input.application.id;

    if ('endUserId' in input.subscriber) {
      const found = await prisma.endUser.findFirst({
        where: { id: input.subscriber.endUserId, applicationId },
        select,
      });
      if (!found) {
        throw new RekeyError({
          statusCode: 404,
          code: 'END_USER_NOT_FOUND',
          message: `No end-user "${input.subscriber.endUserId}" exists in this Application.`,
          fix: 'Name the subscriber by email instead; an unknown address is created.',
        });
      }
      if (found.erasedAt !== null) {
        throw new RekeyError({
          statusCode: 410,
          code: 'END_USER_ERASED',
          message: `End-user "${input.subscriber.endUserId}" was erased; nothing can be granted to the tombstone.`,
          fix: 'Remove the customer from your billing system as well, or name a different subscriber.',
        });
      }
      return { id: found.id, email: found.email, created: false };
    }

    const email = input.subscriber.email.toLowerCase();
    const existing = await prisma.endUser.findUnique({
      where: { applicationId_email: { applicationId, email } },
      select,
    });
    if (existing) return { id: existing.id, email: existing.email, created: false };

    // Workspace ceiling, exactly as sign-up and the operator create route
    // apply it. A sender that outruns the quota gets a 5xx and retries; the
    // inbound event log shows why.
    await assertEndUserQuota(input.application.tenantId);
    const role = await applicationRolesService.getDefault(applicationId);
    const data: Prisma.EndUserUncheckedCreateInput = {
      applicationId,
      email,
      passwordHash: null,
      role: role.name,
      emailVerified: input.subscriber.emailVerified ?? true,
    };

    let created: {
      id: string;
      email: string;
      emailVerified: boolean;
      role: string;
      createdAt: Date;
      metadata: Prisma.JsonValue | null;
    };
    try {
      created = await prisma.endUser.create({
        data,
        select: { id: true, email: true, emailVerified: true, role: true, createdAt: true, metadata: true },
      });
    } catch (e) {
      // Two events for one new address raced; the loser reads the winner.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const won = await prisma.endUser.findUniqueOrThrow({
        where: { applicationId_email: { applicationId, email } },
        select,
      });
      return { id: won.id, email: won.email, created: false };
    }

    input.log?.info(
      { applicationId, endUserId: created.id, provider: input.provider, providerEventId: input.providerEventId },
      'end-user created from a billing webhook',
    );
    void recordSecurityEvent({
      type: 'end_user.created_by_billing_webhook',
      actorType: 'system',
      tenantId: input.application.tenantId,
      applicationId,
      metadata: {
        endUserId: created.id,
        provider: input.provider,
        providerEventId: input.providerEventId,
        emailVerified: created.emailVerified,
      },
    });
    emitDetached({
      applicationId,
      type: 'user.created',
      data: {
        user: {
          id: created.id,
          email: created.email,
          emailVerified: created.emailVerified,
          role: created.role,
          createdAt: created.createdAt.toISOString(),
          metadata: created.metadata ?? null,
        },
        via: `billing:${input.provider}`,
      },
    });
    return { id: created.id, email: created.email, created: true };
  },
};
