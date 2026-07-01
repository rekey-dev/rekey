/**
 * Operator MCP WRITE tools — phase 1 (reversible workspace configuration).
 *
 * These mutate the operator's workspace and are listed / dispatchable only when
 * the caller's token carries write capability (`mcp:operator:write` for the
 * OAuth path, `applications:write` for a PAT) AND their role clears the tool's
 * `minRole` (default ADMIN). The dispatcher in `tenant-mcp-server.ts` enforces
 * both before a handler runs — but every handler ALSO re-scopes by tenant, so a
 * dispatch bug can't become a cross-workspace write.
 *
 * Reuse, not reimplementation: each handler calls the same service the panel
 * routes use (`applicationsService`, `plansService`, `webhookService`), so
 * validation, slug rules, provider registration, and secret generation behave
 * identically to the panel. Every successful write emits a `securityEvent`.
 *
 * Phase 1 is deliberately reversible-only. Destructive / financial operations
 * (delete application, refund, cancel subscription, remove member, rotate
 * webhook secret) are intentionally NOT exposed here — they belong behind a
 * stronger gate / explicit confirmation in a later phase.
 */

import type { Application, TenantRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { RelipayError } from '../../lib/error.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { applicationsService } from '../applications/applications.service.js';
import { plansService } from '../plans/plans.service.js';
import { webhookService } from '../webhooks/webhook.service.js';
import { billingService } from '../billing/billing.service.js';
import {
  billingCredentialsService,
  type BillingMode,
} from '../billing/credentials.service.js';
import { tenantWorkspacesService } from '../tenant-workspaces/tenant-workspaces.service.js';
import type { OperatorTool, OperatorToolContext } from './operator-tools.js';

/**
 * Resolve a workspace member's membership id from their tenant-user id, scoped
 * to the operator's tenant. A tenant-user id from another workspace is
 * indistinguishable from a non-existent one (no cross-tenant reach).
 */
async function membershipIdInTenant(tenantId: string, tenantUserId: string): Promise<string> {
  const membership = await prisma.tenantMembership.findUnique({
    where: { tenantUserId_tenantId: { tenantUserId, tenantId } },
  });
  if (!membership) {
    throw new RelipayError({
      statusCode: 404,
      code: 'MEMBERSHIP_NOT_FOUND',
      message: `No member with tenantUserId "${tenantUserId}" in this workspace.`,
      fix: 'Call list_members to see members and their tenantUserId values.',
    });
  }
  return membership.id;
}

/**
 * Load an application and assert it belongs to the caller's workspace.
 *
 * `applicationsService.get` is NOT tenant-scoped (it fetches by id alone), so
 * every app-targeted write MUST funnel through here — otherwise an operator
 * could pass another tenant's applicationId and mutate it. The not-found and
 * wrong-tenant cases return the SAME error so the caller can't probe which
 * application ids exist outside their workspace.
 */
async function loadAppInTenant(tenantId: string, applicationId: string): Promise<Application> {
  const app = await prisma.application.findUnique({ where: { id: applicationId } });
  if (!app || app.tenantId !== tenantId) {
    throw new RelipayError({
      statusCode: 404,
      code: 'APPLICATION_NOT_FOUND',
      message: `Application "${applicationId}" not found in this workspace.`,
      fix: 'Call list_applications to see the applications you can modify.',
    });
  }
  return app;
}

function audit(
  ctx: OperatorToolContext,
  type: string,
  applicationId: string | null,
  metadata: Record<string, unknown>,
): void {
  void recordSecurityEvent({
    type,
    actorType: 'operator',
    actorId: ctx.tenantUserId,
    tenantId: ctx.tenantId,
    applicationId,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    metadata: { via: 'operator_mcp', ...metadata },
  });
}

export const operatorWriteTools: OperatorTool[] = [
  {
    name: 'create_application',
    description:
      'Create a new Application in the active workspace. Returns the application id, ' +
      'slug, and publishable key. The slug must be URL-safe (lowercase letters, digits, ' +
      'hyphens) and is globally unique.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        slug: { type: 'string', minLength: 1, maxLength: 40 },
        enableBilling: { type: 'boolean', default: false },
      },
      required: ['name', 'slug'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await applicationsService.create({
        tenantId: ctx.tenantId,
        name: String(args.name),
        slug: String(args.slug),
        enableBilling: args.enableBilling === true,
      });
      audit(ctx, 'app.created', app.id, { slug: app.slug, name: app.name });
      return { id: app.id, slug: app.slug, name: app.name, publicKey: app.publicKey };
    },
  },
  {
    name: 'update_auth_config',
    description:
      "Patch an application's auth configuration. Only the fields you pass change. " +
      'Use `mcpEnabled` to turn the per-app end-user MCP server on/off, `methods` to set ' +
      "the enabled sign-in methods (e.g. ['password','oauth']), `mfa` for the MFA policy, " +
      'and `signupMode` to control public sign-up.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        methods: { type: 'array', items: { type: 'string' } },
        passwordMinLength: { type: 'integer', minimum: 6, maximum: 256 },
        redirectUrls: { type: 'array', items: { type: 'string' } },
        organizationsEnabled: { type: 'boolean' },
        signupMode: { type: 'string', enum: ['public', 'secret_only', 'invite_only'] },
        mfa: { type: 'string', enum: ['off', 'optional', 'required'] },
        mcpEnabled: { type: 'boolean' },
        passwordBreachCheckEnabled: { type: 'boolean' },
      },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx.tenantId, String(args.applicationId));
      const patch = {
        ...(args.methods !== undefined && { methods: args.methods as string[] }),
        ...(args.passwordMinLength !== undefined && {
          passwordMinLength: Number(args.passwordMinLength),
        }),
        ...(args.redirectUrls !== undefined && { redirectUrls: args.redirectUrls as string[] }),
        ...(args.organizationsEnabled !== undefined && {
          organizationsEnabled: args.organizationsEnabled === true,
        }),
        ...(args.signupMode !== undefined && {
          signupMode: args.signupMode as 'public' | 'secret_only' | 'invite_only',
        }),
        ...(args.mfa !== undefined && { mfa: args.mfa as 'off' | 'optional' | 'required' }),
        ...(args.mcpEnabled !== undefined && { mcpEnabled: args.mcpEnabled === true }),
        ...(args.passwordBreachCheckEnabled !== undefined && {
          passwordBreachCheckEnabled: args.passwordBreachCheckEnabled === true,
        }),
      };
      const updated = await applicationsService.updateAuthConfig({ applicationId: app.id, patch });
      audit(ctx, 'app.auth_config_updated', app.id, { fields: Object.keys(patch) });
      return { id: updated.id, slug: updated.slug, authConfig: updated.authConfig };
    },
  },
  {
    name: 'create_plan',
    description:
      'Create a billing Plan on an application. `amount` is in the smallest currency unit ' +
      '(e.g. cents). Defaults: currency USD, interval MONTH, kind SUBSCRIPTION.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        slug: { type: 'string', minLength: 1, maxLength: 40 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        amount: { type: 'integer', minimum: 0 },
        currency: { type: 'string', minLength: 3, maxLength: 3 },
        interval: { type: 'string', enum: ['MONTH', 'YEAR'] },
      },
      required: ['applicationId', 'slug', 'name', 'amount'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx.tenantId, String(args.applicationId));
      const plan = await plansService.create({
        applicationId: app.id,
        slug: String(args.slug),
        name: String(args.name),
        amount: Number(args.amount),
        ...(args.currency !== undefined && { currency: String(args.currency) }),
        ...(args.interval !== undefined && {
          interval: args.interval as 'MONTH' | 'YEAR',
        }),
      });
      audit(ctx, 'app.plan_created', app.id, { planSlug: plan.slug, amount: plan.amount });
      return {
        id: plan.id,
        slug: plan.slug,
        name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        interval: plan.interval,
        active: plan.active,
      };
    },
  },
  {
    name: 'set_plan_active',
    description:
      'Activate or ARCHIVE a plan by slug. Deactivating (active=false) archives it: existing ' +
      "subscriptions keep billing, but no new sign-ups. This is how you retire a plan — you " +
      "CANNOT change a plan's price in place (the price is registered with the payment provider " +
      'and is immutable), so to change pricing you archive the old plan here and create a ' +
      'replacement with create_plan. Reversible.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        slug: { type: 'string', minLength: 1 },
        active: { type: 'boolean' },
      },
      required: ['applicationId', 'slug', 'active'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx.tenantId, String(args.applicationId));
      const plan = await plansService.setActive(app.id, String(args.slug), args.active === true);
      audit(ctx, 'app.plan_active_changed', app.id, { planSlug: plan.slug, active: plan.active });
      return { slug: plan.slug, active: plan.active };
    },
  },
  {
    name: 'update_plan',
    description:
      "Edit a plan's ENTITLEMENTS ONLY — its display name, LICENSE seats/duration, or CREDIT " +
      'amount. You CANNOT change price, currency, or interval here: those are registered with ' +
      'the payment provider (Stripe/PayPal/Razorpay) and are immutable. To change pricing, ' +
      'ARCHIVE this plan (set_plan_active active=false) and CREATE a replacement (create_plan) — ' +
      'existing subscribers keep their old price, new sign-ups get the new plan.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        slug: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        licenseSeatsAllowed: { type: 'integer', minimum: 0, description: 'LICENSE plans only.' },
        licenseDurationDays: { type: 'integer', minimum: 0, description: 'LICENSE plans only.' },
        creditsAmount: { type: 'integer', minimum: 0, description: 'CREDIT plans only.' },
      },
      required: ['applicationId', 'slug'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx.tenantId, String(args.applicationId));
      const patch = {
        ...(args.name !== undefined && { name: String(args.name) }),
        ...(args.licenseSeatsAllowed !== undefined && {
          licenseSeatsAllowed: Number(args.licenseSeatsAllowed),
        }),
        ...(args.licenseDurationDays !== undefined && {
          licenseDurationDays: Number(args.licenseDurationDays),
        }),
        ...(args.creditsAmount !== undefined && { creditsAmount: Number(args.creditsAmount) }),
      };
      const plan = await plansService.updateEntitlements(app.id, String(args.slug), patch);
      audit(ctx, 'app.plan_entitlements_updated', app.id, {
        planSlug: plan.slug,
        fields: Object.keys(patch),
      });
      return {
        slug: plan.slug,
        name: plan.name,
        licenseSeatsAllowed: plan.licenseSeatsAllowed,
        licenseDurationDays: plan.licenseDurationDays,
        creditsAmount: plan.creditsAmount,
        // Echo the (immutable) price so the agent sees what it can't change here.
        amount: plan.amount,
        currency: plan.currency,
        interval: plan.interval,
      };
    },
  },
  {
    name: 'create_webhook_endpoint',
    description:
      'Register an outbound webhook endpoint for an application. Returns the endpoint id ' +
      'and the signing secret — the secret is shown ONCE here and cannot be retrieved later.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        events: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['applicationId', 'url', 'events'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx.tenantId, String(args.applicationId));
      const { endpoint, secret } = await webhookService.createEndpoint({
        applicationId: app.id,
        url: String(args.url),
        events: (args.events as string[]) ?? [],
      });
      audit(ctx, 'app.webhook_endpoint_created', app.id, {
        endpointId: endpoint.id,
        url: endpoint.url,
      });
      return {
        id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        enabled: endpoint.enabled,
        secret,
      };
    },
  },
  {
    name: 'update_webhook_endpoint',
    description:
      'Update an outbound webhook endpoint — its URL, subscribed events, or enabled flag. ' +
      'Only the fields you pass change. Does not rotate the signing secret.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        endpointId: { type: 'string', minLength: 1 },
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        events: { type: 'array', items: { type: 'string' } },
        enabled: { type: 'boolean' },
      },
      required: ['applicationId', 'endpointId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx.tenantId, String(args.applicationId));
      const endpoint = await webhookService.updateEndpoint({
        applicationId: app.id,
        endpointId: String(args.endpointId),
        ...(args.url !== undefined && { url: String(args.url) }),
        ...(args.events !== undefined && { events: args.events as string[] }),
        ...(args.enabled !== undefined && { enabled: args.enabled === true }),
      });
      audit(ctx, 'app.webhook_endpoint_updated', app.id, { endpointId: endpoint.id });
      return {
        id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        enabled: endpoint.enabled,
      };
    },
  },

  // ── Member management (write) — reuses tenantWorkspacesService, whose
  //    ensureCanManage enforces OWNER-manages-anyone / ADMIN-manages-MEMBER. ──
  {
    name: 'invite_member',
    description:
      'Invite a teammate to the workspace by email with a role (OWNER / ADMIN / MEMBER). ' +
      'Sends an invitation email with a secure link. An ADMIN can only invite MEMBERs; ' +
      'inviting an OWNER/ADMIN requires the OWNER role.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', minLength: 3, maxLength: 254 },
        role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
      },
      required: ['email', 'role'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const result = await tenantWorkspacesService.createInvitation({
        tenantId: ctx.tenantId,
        invitedById: ctx.tenantUserId,
        invitedByRole: ctx.role,
        email: String(args.email),
        role: String(args.role) as TenantRole,
        inviteUrl: `${env.PANEL_URL.replace(/\/$/, '')}/accept-invite?token={token}`,
      });
      audit(ctx, 'workspace.member_invited', null, {
        email: result.invitation.email,
        role: result.invitation.role,
        emailSent: result.emailSent,
      });
      // The raw invite token is intentionally NOT returned — it travels only in
      // the email. If delivery failed, the operator resends from the panel.
      return {
        invitationId: result.invitation.id,
        email: result.invitation.email,
        role: result.invitation.role,
        status: result.invitation.status,
        emailSent: result.emailSent,
      };
    },
  },
  {
    name: 'revoke_invitation',
    description:
      'Revoke a pending workspace invitation by its id (from list_invitations). ' +
      'Already-accepted invitations cannot be revoked — remove the member instead.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { invitationId: { type: 'string', minLength: 1 } },
      required: ['invitationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const inv = await tenantWorkspacesService.revokeInvitation({
        tenantId: ctx.tenantId,
        invitationId: String(args.invitationId),
        actorRole: ctx.role,
      });
      audit(ctx, 'workspace.invitation_revoked', null, { invitationId: inv.id, email: inv.email });
      return { invitationId: inv.id, email: inv.email, status: inv.status };
    },
  },
  {
    name: 'change_member_role',
    description:
      "Change a workspace member's role (OWNER / ADMIN / MEMBER). Identify the member by " +
      'tenantUserId (from list_members). Guards against demoting the last OWNER; an ADMIN ' +
      'can only manage MEMBERs.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        tenantUserId: { type: 'string', minLength: 1 },
        newRole: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
      },
      required: ['tenantUserId', 'newRole'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const membershipId = await membershipIdInTenant(ctx.tenantId, String(args.tenantUserId));
      const member = await tenantWorkspacesService.changeMemberRole({
        tenantId: ctx.tenantId,
        membershipId,
        actorRole: ctx.role,
        newRole: String(args.newRole) as TenantRole,
      });
      audit(ctx, 'workspace.member_role_changed', null, {
        tenantUserId: member.tenantUserId,
        newRole: member.role,
      });
      return { tenantUserId: member.tenantUserId, email: member.email, role: member.role };
    },
  },
  {
    name: 'remove_member',
    description:
      'Remove a member from the workspace by tenantUserId (from list_members). Reversible by ' +
      're-inviting. Guards against removing the last OWNER; an ADMIN can only remove MEMBERs.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { tenantUserId: { type: 'string', minLength: 1 } },
      required: ['tenantUserId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const tenantUserId = String(args.tenantUserId);
      const membershipId = await membershipIdInTenant(ctx.tenantId, tenantUserId);
      await tenantWorkspacesService.removeMember({
        tenantId: ctx.tenantId,
        membershipId,
        actorTenantUserId: ctx.tenantUserId,
        actorRole: ctx.role,
      });
      audit(ctx, 'workspace.member_removed', null, { tenantUserId });
      return { tenantUserId, removed: true };
    },
  },

  // ── Admin tools (mcp:operator:admin) — financial / secret-handling ──────────
  // These require the admin scope AND an OWNER/ADMIN role. The connector denies
  // them by default; the operator opts in per-tool. Still re-scoped by tenant.
  {
    name: 'configure_billing_provider',
    description:
      "Set an application's billing-provider credentials (Stripe / PayPal / Razorpay). " +
      'Credentials are AES-256-GCM encrypted at rest and never returned by any tool. ' +
      'SECURITY: the secret you pass travels through the MCP client — only use this from a ' +
      'trusted client. Leave webhook secrets blank to auto-configure them later in the panel.',
    write: true,
    admin: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        provider: { type: 'string', enum: ['stripe', 'paypal', 'razorpay'] },
        // Stripe
        apiKey: { type: 'string', description: 'Stripe secret key (sk_…).' },
        // PayPal
        clientId: { type: 'string' },
        clientSecret: { type: 'string' },
        // Razorpay
        keyId: { type: 'string' },
        keySecret: { type: 'string' },
        // Shared optional webhook secret/id (provider-specific meaning)
        webhookSecret: { type: 'string' },
        webhookId: { type: 'string' },
        mode: { type: 'string', enum: ['test', 'live'] },
        countries: { type: 'array', items: { type: 'string' } },
        enabled: { type: 'boolean' },
      },
      required: ['applicationId', 'provider'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx.tenantId, String(args.applicationId));
      const provider = String(args.provider) as 'stripe' | 'paypal' | 'razorpay';
      const mode = args.mode === 'test' || args.mode === 'live' ? (args.mode as BillingMode) : undefined;
      const options = {
        ...(args.countries !== undefined && { countries: args.countries as string[] }),
        ...(args.enabled !== undefined && { enabled: args.enabled === true }),
        ...(mode !== undefined && { mode }),
      };
      if (provider === 'stripe') {
        await billingCredentialsService.upsertStripe(
          app.id,
          { apiKey: String(args.apiKey ?? ''), webhookSecret: String(args.webhookSecret ?? '') },
          options,
        );
      } else if (provider === 'paypal') {
        await billingCredentialsService.upsertPaypal(
          app.id,
          {
            clientId: String(args.clientId ?? ''),
            clientSecret: String(args.clientSecret ?? ''),
            webhookId: String(args.webhookId ?? ''),
          },
          options,
        );
      } else {
        await billingCredentialsService.upsertRazorpay(
          app.id,
          {
            keyId: String(args.keyId ?? ''),
            keySecret: String(args.keySecret ?? ''),
            webhookSecret: String(args.webhookSecret ?? ''),
          },
          options,
        );
      }
      // Audit records only that creds were set — NEVER the secret values.
      audit(ctx, 'app.billing_credentials_configured', app.id, { provider, mode: mode ?? 'inferred' });
      return { applicationId: app.id, provider, configured: true };
    },
  },
  {
    name: 'cancel_subscription',
    description:
      'Cancel a specific subscription by id. By default cancels at period end for an active ' +
      'provider-backed subscription (so the customer keeps access until then); pass ' +
      '`atPeriodEnd: false` to cancel immediately. Irreversible — the subscription cannot be ' +
      'un-cancelled.',
    write: true,
    admin: true,
    inputSchema: {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', minLength: 1 },
        atPeriodEnd: { type: 'boolean', default: true },
      },
      required: ['subscriptionId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const subscriptionId = String(args.subscriptionId);
      // Resolve the subscription's application and confirm it's in this tenant
      // BEFORE acting — a subscription id from another workspace is treated as
      // not-found (no cross-tenant cancel, no existence probing).
      const sub = await prisma.subscription.findUnique({
        where: { id: subscriptionId },
        select: { applicationId: true },
      });
      if (!sub) {
        throw new RelipayError({
          statusCode: 404,
          code: 'SUBSCRIPTION_NOT_FOUND',
          message: `Subscription "${subscriptionId}" not found in this workspace.`,
          fix: 'Use recent_subscriptions to find a subscription id in this workspace.',
        });
      }
      const app = await loadAppInTenant(ctx.tenantId, sub.applicationId);
      const atPeriodEnd = args.atPeriodEnd !== false;
      const updated = await billingService.cancelSubscriptionById(app, subscriptionId, {
        atPeriodEnd,
      });
      audit(ctx, 'app.subscription_canceled', app.id, {
        subscriptionId,
        atPeriodEnd,
        status: updated.status,
      });
      return {
        id: updated.id,
        status: updated.status,
        cancelAt: updated.cancelAt?.toISOString() ?? null,
        canceledAt: updated.canceledAt?.toISOString() ?? null,
      };
    },
  },
];
