/**
 * The billing reads a signed-in session makes about itself.
 *
 * `GET /billing/entitlements`, `GET /billing/subscription` and the `?include=`
 * on the current-user routes all answer through these, so the one-call answer
 * and the dedicated routes cannot drift apart.
 */

import type { Application } from '@prisma/client';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { billingService } from './billing.service.js';
import { getModule } from './providers/registry.js';
import { organizationsService } from '../organizations/organizations.service.js';
import { ref, type JsonSchema } from '../../lib/openapi.js';

/**
 * The organization a session's billing reads default to: its active
 * organization (`oid`) while the caller is still a member with a usable role,
 * else none, which means the personal view. A lapsed claim degrades to the
 * personal view rather than failing the call.
 */
export async function sessionBillingOrganization(args: {
  applicationId: string;
  endUserId: string;
  activeOrganizationId: string | null | undefined;
}): Promise<string | undefined> {
  if (!args.activeOrganizationId) return undefined;
  const member = await organizationsService.isMember({
    applicationId: args.applicationId,
    endUserId: args.endUserId,
    organizationId: args.activeOrganizationId,
  });
  return member ? args.activeOrganizationId : undefined;
}

/**
 * The subject a session's own reads resolve for when the caller names none:
 * the organization only where organizations are what the Application bills
 * (`billingSubject: "org"`) and the session acts for one the caller still
 * belongs to. Everywhere else the end-user, the subject
 * `GET /billing/subscription` reads by default: in a user-billed Application an
 * organization never holds a subscription, so reading its view would report a
 * paying user as entitled to nothing the moment they switched into a team.
 *
 * `?include=` on the current-user routes, `GET /users/me/licenses` and the
 * single-feature check all answer through this, so they agree on the subject.
 */
export async function billingSubjectOrganization(
  application: Pick<Application, 'billingConfig'>,
  session: { applicationId: string; endUserId: string; activeOrganizationId: string | null | undefined },
): Promise<string | undefined> {
  const { billingSubject } = BillingConfigSchema.parse(application.billingConfig);
  if (billingSubject !== 'org') return undefined;
  return sessionBillingOrganization(session);
}

/**
 * The current subscription exactly as `GET /billing/subscription` serves it:
 * `billingService.getCurrentSubscription` (live rows ranked, the free plan
 * only as a fallback) plus `providerCapabilities`.
 */
export async function readCurrentSubscription(
  application: Application,
  endUser: { id: string; applicationId: string },
  opts: { organizationId?: string; includeEnded?: boolean },
) {
  // The service signature wants an EndUser row; it only reads id and
  // applicationId, which is all a session carries.
  const sub = await billingService.getCurrentSubscription(
    application,
    { ...endUser, passwordHash: null } as never,
    opts,
  );
  // `providerCapabilities` lets a portal ask what the provider holding this
  // row can do (an inbound-only one cannot be cancelled here) instead of
  // matching on the provider's name.
  return (
    sub && {
      ...sub,
      providerCapabilities: (sub.provider !== null && getModule(sub.provider)?.capabilities) || null,
    }
  );
}

/** `data` of `GET /billing/entitlements`: the resolved union of the caller's benefits. */
export const RESOLVED_ENTITLEMENTS_SCHEMA: JsonSchema = {
  type: 'object',
  description:
    "The union of the caller's benefits: feature flags, the live credit balance, and the raw " +
    'resolved entitlement list.',
  properties: {
    features: {
      type: 'object',
      description: 'Feature flag key → typed value (boolean, number, or string).',
      additionalProperties: { oneOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string' }] },
    },
    entitlements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'e.g. FEATURE, CREDIT, LICENSE, USAGE.' },
          key: { type: 'string' },
          valueType: { type: 'string', nullable: true },
          value: { type: 'string', nullable: true },
          quantity: { type: 'integer', nullable: true },
          creditsPerUnit: {
            type: 'integer',
            nullable: true,
            description: 'USAGE only: credits charged per unit past `quantity`. Null means a hard cap.',
          },
          licenseKind: { type: 'string', nullable: true },
          rollover: { type: 'boolean' },
        },
        required: ['kind', 'key', 'rollover'],
      },
    },
    creditBalance: { type: 'integer' },
  },
  required: ['features', 'entitlements', 'creditBalance'],
};

/** `data` of `GET /billing/subscription`: the current Subscription, or `null`. */
export const NULLABLE_SUBSCRIPTION_SCHEMA: JsonSchema = { nullable: true, allOf: [ref('Subscription')] };
