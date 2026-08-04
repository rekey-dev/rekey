/**
 * Super-admin billing writes — currently one: granting a subscription that no
 * payment provider is behind. Mounted under `/api/v1/admin/applications`
 * alongside the plan, coupon and API-key admin surfaces.
 *
 * ## Why this is super-admin and not an operator role floor
 *
 * Every other billing WRITE an operator can reach either follows a provider
 * event — money that has demonstrably moved — or removes entitlement, which
 * fails safe. Granting is the only one that CREATES entitlement on somebody's
 * say-so, with nothing behind it but the assertion that a payment happened
 * somewhere this deployment cannot see.
 *
 * On a deployment where the operator is also the buyer, that is a lever aimed
 * at the deployment's own ceiling. Rekey Cloud is exactly that deployment: a
 * workspace's `max_workspaces` allowance is written from the entitlements on
 * its own subscription, so "an operator may grant a subscription" is one
 * mis-scoped application away from "a customer may write their own limits".
 * That mistake has already been made here once in a different form —
 * `WORKSPACE_CREATION=open` let any operator bypass `max_workspaces` until it
 * was closed on 2026-08-02 — and the shape of it is not one to re-learn.
 *
 * Today's tenant scoping would in fact contain an operator-callable grant: a
 * subscription is Application-scoped, and Rekey's own Application is not in a
 * customer's workspace. The reason it is still held here is that the
 * containment is incidental rather than designed, and the asymmetry of the two
 * mistakes is total. Opening this to `requireTenantRole(['OWNER'])` later is a
 * one-line change; discovering after it has shipped that it should not have
 * been is not. See decisions.md, 2026-08-03.
 *
 * The audit row this writes carries the Application's `tenantId`, so the
 * operator whose workspace it lands in sees it in their own security-event
 * trail even though they could not have caused it.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '../../middleware/admin-auth.js';
import { applicationsService } from '../applications/applications.service.js';
import { subscriptionGrantsService } from './grant.service.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { ok, errs, ref, type JsonSchema } from '../../lib/openapi.js';

/**
 * `activated` rides alongside the subscription rather than being inferred from
 * the status: the row reads `ACTIVE` either way, so a caller retrying a grant
 * has no other way to tell "I did this" from "it was already so".
 */
const GrantResult: JsonSchema = {
  type: 'object',
  properties: {
    subscription: ref('Subscription'),
    activated: {
      type: 'boolean',
      description: 'True when THIS call activated the subscription and emitted `subscription.activated`.',
    },
  },
  required: ['subscription', 'activated'],
};

/** The 401/403/429 trio every `/api/v1/admin/*` route shares. */
const SUPER_ADMIN_ERRORS = {
  401:
    'ADMIN_AUTH_MISSING — no `Authorization: Bearer` header; or ADMIN_AUTH_INVALID — the ' +
    'value does not match `SUPER_ADMIN_KEY`.',
  403: 'ADMIN_IP_NOT_ALLOWED — the caller IP is outside `ADMIN_IP_ALLOWLIST`.',
  429: 'RATE_LIMITED — too many requests. Honour the `Retry-After` header.',
} as const;

const Params = z.object({ id: z.string().min(1) });

const GrantBody = z
  .object({
    planSlug: z.string().min(1).max(40),
    endUserId: z.string().min(1).max(64).optional(),
    email: z.string().email().max(320).optional(),
    organizationId: z.string().min(1).max(64).optional(),
    currentPeriodEnd: z.string().datetime().optional(),
    note: z.string().max(500).optional(),
  })
  // Naming the subscriber twice is not a convenience, it is two answers to one
  // question — and the wrong one silently winning is how a subscription gets
  // granted to somebody who did not buy it.
  .refine((b) => (b.endUserId === undefined) !== (b.email === undefined), {
    message: 'Provide exactly one of `endUserId` or `email`.',
  });

function adminContext(req: FastifyRequest): { ip: string | null; userAgent: string | null } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip || null, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
}

export async function billingAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireSuperAdmin);

  app.post(
    '/:id/subscriptions',
    {
      schema: {
        tags: ['Admin · Billing'],
        security: [{ superAdminKey: [] }],
        summary: 'Grant a subscription (no payment provider)',
        description:
          'Activates a subscription for an end-user against a named plan without a checkout or a ' +
          'payment provider — for a sale settled by invoice, bank transfer, or any other channel ' +
          'this deployment cannot observe, and for comped accounts.\n\n' +
          'It takes the same path a provider activation takes: the plan\'s entitlements are ' +
          'materialised onto the beneficiary and `subscription.activated` is emitted through the ' +
          'same outbox, so anything already listening for a sale hears this one too.\n\n' +
          '**Idempotent.** A subscriber who is already ACTIVE or PAST_DUE on the plan is returned ' +
          'unchanged with `activated: false`, and `200` rather than `201` — nothing is written, ' +
          'nothing re-provisioned, nothing re-announced. It does not extend a live period; to ' +
          'move a grant to a new term, cancel it and grant again.\n\n' +
          'The subscription carries no provider, which is what lets `POST /api/v1/billing/' +
          'subscription/cancel` end it locally at period end.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['planSlug'],
          properties: {
            planSlug: { type: 'string', minLength: 1, maxLength: 40 },
            endUserId: {
              type: 'string',
              description: 'The subscriber. Exactly one of `endUserId` or `email` is required.',
            },
            email: {
              type: 'string',
              format: 'email',
              description: 'The subscriber, by address. Matched case-insensitively.',
            },
            organizationId: {
              type: 'string',
              description:
                'Beneficiary organization (owner+beneficiary billing). Required when the ' +
                'Application bills per organization.',
            },
            currentPeriodEnd: {
              type: 'string',
              format: 'date-time',
              description:
                'End of the granted period. Defaults to one plan interval from now for a ' +
                'recurring plan, and to null for a one-off purchase (credit pack, perpetual ' +
                'licence). Must be in the future.',
            },
            note: {
              type: 'string',
              maxLength: 500,
              description: 'Why this was granted. Stored on the subscription and in the audit log.',
            },
          },
        },
        response: {
          200: ok(GrantResult, 'The subscriber was already entitled — nothing changed.'),
          201: ok(GrantResult, 'The subscription is now active.'),
          ...errs({
            400:
              'VALIDATION_ERROR — a field failed schema validation, or neither/both of ' +
              '`endUserId` and `email` were given; or BILLING_ORGANIZATION_REQUIRED — the ' +
              'Application bills per organization and none was named; or ' +
              'SUBSCRIPTION_PERIOD_END_IN_PAST — `currentPeriodEnd` is not in the future.',
            ...SUPER_ADMIN_ERRORS,
            404:
              'APPLICATION_NOT_FOUND — no application with that id; or PLAN_NOT_FOUND — no such ' +
              'plan in this application; or END_USER_NOT_FOUND — nobody in this application ' +
              'matches that id or email; or ORGANIZATION_NOT_FOUND — no such organization here.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = Params.parse(req.params);
      const body = GrantBody.parse(req.body);
      const application = await applicationsService.get(id);

      const result = await subscriptionGrantsService.grantSubscription({
        application,
        planSlug: body.planSlug,
        ...(body.endUserId !== undefined && { endUserId: body.endUserId }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.organizationId !== undefined && { organizationId: body.organizationId }),
        ...(body.currentPeriodEnd !== undefined && {
          currentPeriodEnd: new Date(body.currentPeriodEnd),
        }),
        ...(body.note !== undefined && { note: body.note }),
      });

      // Money-adjacent state with no payment behind it: who did it, to whom, on
      // what plan, for how long, and why. Recorded ONLY when this call actually
      // activated something — an audit trail that logs no-ops teaches its reader
      // to skim it. `actorType: 'system'` because the super-admin key is a
      // deployment credential, not a person, matching the operator-invite
      // routes; `tenantId` so the workspace it landed in can see it.
      if (result.activated) {
        void recordSecurityEvent({
          type: 'app.subscription_granted',
          actorType: 'system',
          tenantId: application.tenantId,
          applicationId: application.id,
          ...adminContext(req),
          metadata: {
            subscriptionId: result.subscription.id,
            endUserId: result.subscription.endUserId,
            planSlug: body.planSlug,
            organizationId: result.subscription.beneficiaryOrgId,
            currentPeriodEnd: result.subscription.currentPeriodEnd?.toISOString() ?? null,
            note: body.note ?? null,
          },
        });
      }

      return reply.status(result.activated ? 201 : 200).send({
        success: true,
        data: { subscription: result.subscription, activated: result.activated },
      });
    },
  );
}
