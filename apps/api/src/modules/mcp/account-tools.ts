/**
 * Hosted MCP account tools, read-only views of the *authenticated* end-user's
 * own Rekey data, scoped to (applicationId, endUserId). No secrets are ever
 * returned (no key hashes, password hashes, provider creds).
 *
 * A grant can be bound to one of the user's organizations at consent
 * (`ToolContext.organization`). The billing tools then answer for that
 * organization exactly where the HTTP API would: only when the Application
 * bills organizations (`billingConfig.billingSubject === 'org'`). In a
 * user-billed Application an organization holds no subscription, so its view
 * would report a paying user as entitled to nothing. The subject rule and the
 * reads are the ones `GET /billing/subscription` and the credits routes use,
 * not a second copy of them.
 *
 * Each tool is a plain `{ name, description, inputSchema, handler }`. The MCP
 * JSON-RPC layer (mcp-server.ts) lists + dispatches them. Kept transport- and
 * SDK-agnostic so the handlers are unit-testable directly.
 */

import type { Application } from '@prisma/client';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { billingService } from '../billing/billing.service.js';
import { billingSubjectOrganization } from '../billing/session-reads.js';
import { assertBillingEnabled } from '../../middleware/billing-enabled.js';
import { creditsService } from '../credits/credits.service.js';
import { licensesService } from '../licenses/licenses.service.js';
import { organizationsService } from '../organizations/organizations.service.js';
import type { GrantOrganization } from './oauth.service.js';

export interface ToolContext {
  applicationId: string;
  endUserId: string;
  /**
   * The organization the grant is bound to, already confirmed live (member,
   * usable role) by the resource server for this request. Absent or null for a
   * personal grant, which is every grant made before the binding existed.
   */
  organization?: GrantOrganization | null;
}

export interface AccountTool {
  name: string;
  description: string;
  /** JSON Schema for tool arguments, all tools here are zero-arg. */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: boolean };
  handler: (ctx: ToolContext) => Promise<unknown>;
}

const NO_ARGS = { type: 'object' as const, properties: {}, additionalProperties: false };

/**
 * The organization the billing tools answer for, or undefined for the
 * personal view: `billingSubjectOrganization`, the helper `/auth/me?include=`,
 * `GET /users/me/licenses` and the session billing reads use, with the bound
 * organization in the place of the session's `oid`. One rule, so MCP and REST
 * cannot drift.
 *
 * The helper degrades a lapsed membership to the personal view, which is right
 * for a session and wrong for a binding. The resource server has already
 * refused a lapsed binding before any tool runs; if membership ends between
 * that check and this one, the tool fails instead of answering for the user
 * under the organization's name.
 */
async function billingOrganizationId(ctx: ToolContext, application: Application): Promise<string | undefined> {
  const organizationId = await billingSubjectOrganization(application, {
    applicationId: ctx.applicationId,
    endUserId: ctx.endUserId,
    activeOrganizationId: ctx.organization?.id,
  });
  if (
    ctx.organization &&
    organizationId === undefined &&
    BillingConfigSchema.parse(application.billingConfig).billingSubject === 'org'
  ) {
    throw new Error('This connection acts for an organization you can no longer act for.');
  }
  return organizationId;
}

function loadApplication(ctx: ToolContext): Promise<Application> {
  return prisma.application.findUniqueOrThrow({ where: { id: ctx.applicationId } });
}

/**
 * The Application, refused with `BILLING_DISABLED` when billing is off: the
 * gate `GET /billing/subscription`, the credit reads and `GET /users/me/licenses`
 * put in front of the reads these tools mirror. Without it a connection
 * answered with a subscription, a balance and licences for an Application
 * whose own API refused to.
 */
async function loadBillingApplication(ctx: ToolContext): Promise<Application> {
  const application = await loadApplication(ctx);
  assertBillingEnabled(application);
  return application;
}

export const accountTools: AccountTool[] = [
  {
    name: 'get_profile',
    description:
      "Get the signed-in user's profile (email, role, verification, metadata), and the " +
      'organization this connection acts for with their role in it (null when it acts for ' +
      'the user personally).',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const u = await prisma.endUser.findFirst({
        where: { id: ctx.endUserId, applicationId: ctx.applicationId },
        select: { id: true, email: true, emailVerified: true, role: true, metadata: true, createdAt: true },
      });
      if (!u) return { error: 'not_found' };
      const organization = ctx.organization
        ? await organizationsService.get({
            application: { id: ctx.applicationId },
            endUserId: ctx.endUserId,
            organizationId: ctx.organization.id,
          })
        : null;
      return {
        ...u,
        createdAt: u.createdAt.toISOString(),
        organization: organization && {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          role: organization.role,
          baseRole: organization.baseRole,
        },
      };
    },
  },
  {
    name: 'get_subscription',
    description:
      'Get the current subscription + plan, or null if none. For the organization this ' +
      'connection acts for when the application bills organizations, otherwise for the ' +
      'signed-in user personally. `organizationId` says which.',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const [application, endUser] = await Promise.all([
        loadBillingApplication(ctx),
        // The real row, not a stub cast to EndUser: the service is typed on the
        // whole row, and a field it starts reading later must not arrive as
        // `undefined` from here.
        prisma.endUser.findFirstOrThrow({ where: { id: ctx.endUserId, applicationId: ctx.applicationId } }),
      ]);
      const organizationId = await billingOrganizationId(ctx, application);
      // The read `GET /billing/subscription` serves.
      const sub = await billingService.getCurrentSubscription(
        application,
        endUser,
        organizationId ? { organizationId } : undefined,
      );
      if (!sub) return null;
      const plan = await prisma.plan.findUnique({
        where: { id: sub.planId },
        select: { slug: true, name: true, interval: true, amount: true, currency: true },
      });
      return {
        status: sub.status,
        provider: sub.provider,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAt: sub.cancelAt?.toISOString() ?? null,
        plan,
        organizationId: organizationId ?? null,
      };
    },
  },
  {
    name: 'get_credits',
    description:
      'Get the prepaid credit balance: the shared pool of the organization this connection ' +
      "acts for when the application bills organizations, otherwise the signed-in user's own. " +
      '`organizationId` says which.',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const organizationId = await billingOrganizationId(ctx, await loadBillingApplication(ctx));
      const balance = await creditsService.getBalance(
        ctx.applicationId,
        organizationId ? { organizationId } : { endUserId: ctx.endUserId },
      );
      return { balance, organizationId: organizationId ?? null };
    },
  },
  {
    name: 'list_my_devices',
    description:
      "List the signed-in user's devices, the machines they have signed in from, with status " +
      'and last-seen time. No IPs and no operator notes. Always personal: a device belongs to ' +
      'a person, not to an organization.',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const rows = await prisma.device.findMany({
        where: { applicationId: ctx.applicationId, endUserId: ctx.endUserId },
        select: { id: true, label: true, status: true, firstSeenAt: true, lastSeenAt: true, releasedAt: true },
        orderBy: { lastSeenAt: 'desc' },
        take: 100,
      });
      return {
        devices: rows.map((r) => ({
          ...r,
          firstSeenAt: r.firstSeenAt.toISOString(),
          lastSeenAt: r.lastSeenAt.toISOString(),
          releasedAt: r.releasedAt?.toISOString() ?? null,
        })),
      };
    },
  },
  {
    name: 'list_licenses',
    description:
      "List the signed-in user's own licenses, plus those pooled to the organization this " +
      'connection acts for when the application bills organizations (no license keys are ' +
      'returned). `organizationId` says whether the pool was included; each row carries its ' +
      'own `organizationId` (null for a personal licence). The newest 100; `truncated` is ' +
      'true when there are more.',
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const organizationId = await billingOrganizationId(ctx, await loadBillingApplication(ctx));
      // Exactly what `GET /users/me/licenses` returns for the same subject: the
      // caller's own licences, plus the organization's pool when it applies.
      const { items, total } = await licensesService.listForEndUser(ctx.applicationId, ctx.endUserId, {
        ...(organizationId && { organizationId }),
        take: 100,
        skip: 0,
      });
      return {
        licenses: items.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          organizationId: r.organizationId,
          seatsAllowed: r.seatsAllowed,
          expiresAt: r.expiresAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        organizationId: organizationId ?? null,
        truncated: total > items.length,
      };
    },
  },
];
