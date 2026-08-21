/**
 * Operator MCP WRITE tools — phase 1 (reversible workspace configuration).
 *
 * Most tools here mutate, and those are listed / dispatchable only when the
 * caller's token carries write capability (`mcp:operator:write` for the OAuth
 * path, `applications:write` for a PAT) AND their role clears the tool's
 * `minRole` (default ADMIN). The dispatcher in `tenant-mcp-server.ts` enforces
 * both before a handler runs — but every handler ALSO re-scopes by tenant, so a
 * dispatch bug can't become a cross-workspace write.
 *
 * ## FOUR TOOLS IN THIS FILE ARE READS, AND THE PARAGRAPH ABOVE IS NOT ABOUT THEM
 *
 * `list_usage_meters`, `list_plan_entitlements`, `list_plans` and
 * `list_api_keys` declare no `write`, no `admin` and no `minRole`. The
 * dispatcher only role-gates tools that declare one of those, so these four are
 * callable by ANY role, including a read-only PAT held by a MEMBER. They live
 * here because they are the read half of the write workflows, not because they
 * are gated like them.
 *
 * That sentence used to be absent, and its absence was the bug: this header
 * said every tool in the file was write-gated, so nobody checked what the four
 * reads were scoped by. The answer was "the workspace, and nothing else", while
 * their REST twins and the read-tool set both enforce per-application grants.
 *
 * App-targeted authorization for EVERY tool in this file — read and write —
 * lives in `loadAppInTenant` below. Read its docstring before adding a tool
 * that takes an `applicationId`.
 *
 * Reuse, not reimplementation: each handler calls the same service the panel
 * routes use (`applicationsService`, `plansService`, `webhookService`), so
 * validation, slug rules, provider registration, and secret generation behave
 * identically to the panel. Every successful write emits a `securityEvent`.
 *
 * Most tools here are reversible. The two that are not — `configure_billing_provider`
 * (the secret travels through the MCP client) and `cancel_subscription`
 * (irreversible) — carry `admin: true`, which demands the `mcp:operator:admin`
 * scope on top of the role check rather than plain write capability.
 * `remove_member` is exposed as an ordinary write tool because re-inviting undoes
 * it. Still deliberately absent: delete application, refund, and webhook-secret
 * rotation — no undo, and no confirmation step an agent can be trusted to have
 * surfaced to a human.
 */

import type { Application, TenantRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { RekeyError } from '../../lib/error.js';
import type { SecurityEventType } from '@rekey.dev/shared-types';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { apiKeysService } from '../api-keys/api-keys.service.js';
import { entitlementsService } from '../billing/entitlements.service.js';
import { usageService } from '../usage/usage.service.js';
import { applicationsService } from '../applications/applications.service.js';
import { planCheckoutReadiness, planCheckoutReadinessFor } from '../plans/plan-readiness.js';
import { plansService } from '../plans/plans.service.js';
import { webhookService } from '../webhooks/webhook.service.js';
import { billingService } from '../billing/billing.service.js';
import {
  billingCredentialsService,
  type BillingMode,
} from '../billing/credentials.service.js';
import { tenantWorkspacesService } from '../tenant-workspaces/tenant-workspaces.service.js';
import { organizationRolesService } from '../organization-roles/organization-roles.service.js';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import {
  accessibleApplicationIds,
  type OperatorTool,
  type OperatorToolContext,
} from './operator-tools.js';

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
    throw new RekeyError({
      statusCode: 404,
      code: 'MEMBERSHIP_NOT_FOUND',
      message: `No member with tenantUserId "${tenantUserId}" in this workspace.`,
      fix: 'Call list_members to see members and their tenantUserId values.',
    });
  }
  return membership.id;
}

/**
 * Load an application and assert the caller may reach it — same workspace AND
 * within their per-application grants.
 *
 * `applicationsService.get` is NOT tenant-scoped (it fetches by id alone), so
 * every app-targeted tool MUST funnel through here — otherwise an operator
 * could pass another tenant's applicationId and mutate it. The not-found,
 * wrong-tenant and not-granted cases return the SAME error so the caller can't
 * probe which application ids exist outside what they may see.
 *
 * The GRANT half was missing, and it mattered for the four READ tools that live
 * in this file — `list_plans`, `list_plan_entitlements`, `list_usage_meters`,
 * `list_api_keys`. They carry neither `write` nor `admin` nor a `minRole`, so
 * the dispatcher in `tenant-mcp-server.ts` leaves them open to any role, and a
 * workspace MEMBER with zero grants could read the plan and pricing catalogue
 * and API-key metadata for every Application in the workspace. Their REST
 * equivalents enforce grants; the read-tool set in `operator-tools.ts`
 * grant-scopes MEMBERs correctly. This file was the seam between the two.
 *
 * ## What this is NOT
 *
 * `accessibleApplicationIds` models `need: 'read'` and only that. It ignores
 * `ApplicationGrant.role` (an `APP_VIEWER` is in the set) and it hands the whole
 * workspace to a `legacyWorkspaceRead` MEMBER — both of which `ensureAppAccess`
 * refuses for a WRITE (see `legacyWriteDenied` / `grantDenied` in
 * `lib/app-access.ts`).
 *
 * So this call is not what authorizes the writes in this file. The dispatcher's
 * `role >= ADMIN` gate is, and this is a redundant read check on top of it,
 * harmless because OWNER/ADMIN receive the whole workspace here anyway. Adding
 * a write tool with `minRole: 'MEMBER'` would NOT be protected by this line: a
 * legacy member would get a workspace-wide write that REST answers 403 for.
 * If that day comes, give this helper a `need` parameter mirroring
 * `ensureAppAccess` rather than assuming it already covers you.
 *
 * The grandfathered `legacyWorkspaceRead` exception survives here deliberately,
 * because it survives over REST too — this is parity, not a gap.
 */
async function loadAppInTenant(
  ctx: OperatorToolContext,
  applicationId: string,
): Promise<Application> {
  // Both resolved unconditionally and in parallel, so every rejection path
  // costs the same work. Checking the tenant first and the grants only on a
  // hit made the two distinguishable by latency: one query for "not in this
  // workspace", four for "in it but not yours". The response bodies were
  // already identical; this makes the timing identical too.
  const [app, readable] = await Promise.all([
    prisma.application.findUnique({ where: { id: applicationId } }),
    accessibleApplicationIds(ctx),
  ]);
  if (!app || app.tenantId !== ctx.tenantId || !readable.includes(app.id)) {
    throw new RekeyError({
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
  type: SecurityEventType,
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


/**
 * Organization-role writes need organizations switched on for the Application.
 *
 * The refusal is the product surface, not just a guard: an agent asking to
 * create `content-manager` on an Application with organizations off should be
 * told to enable them (and how) rather than getting a role nobody can hold.
 * Mirrors `requireOrganizationsEnabled` on the REST side.
 */
function assertOrganizationsEnabled(app: Application): void {
  const config = AuthConfigSchema.parse(app.authConfig);
  if (!config.organizationsEnabled) {
    throw new RekeyError({
      statusCode: 400,
      code: 'ORGANIZATIONS_NOT_ENABLED',
      message: `Organizations are not enabled on "${app.slug}", so it has no use for custom organization roles.`,
      fix: 'Call update_auth_config with { applicationId, organizationsEnabled: true } first, then retry.',
    });
  }
}

export const operatorWriteTools: OperatorTool[] = [
  {
    name: 'list_organization_roles',
    description:
      "List an application's ORGANIZATION role catalog: the role names assignable to a " +
      'member of an organization. Each entry has a `baseRole` of OWNER/ADMIN/MEMBER, which ' +
      'is the authority tier the name inherits and the only thing Rekey gates on. Note this ' +
      'is a different axis from an end-user\'s application-wide `role` (see get_end_user): ' +
      'application role is one value per user across the whole app, organization role is per ' +
      '(organization, user). Readable even when organizations are disabled.',
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string', minLength: 1 } },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const config = AuthConfigSchema.parse(app.authConfig);
      const roles = await organizationRolesService.list(app.id);
      return {
        applicationId: app.id,
        organizationsEnabled: config.organizationsEnabled === true,
        ...(config.organizationsEnabled
          ? {}
          : {
              note:
                'Organizations are disabled on this application, so these roles cannot be ' +
                'assigned yet. Call update_auth_config with organizationsEnabled: true to ' +
                'turn the feature on.',
            }),
        roles,
      };
    },
  },
  {
    name: 'create_organization_role',
    description:
      'Define a custom ORGANIZATION role on an application (e.g. "content-manager"). ' +
      '`baseRole` picks the authority tier it inherits (OWNER, ADMIN or MEMBER), and Rekey ' +
      'enforces permissions on that tier, never on the name, so a "content-manager" on tier ' +
      'MEMBER can do exactly what MEMBER can. Requires organizations to be enabled on the ' +
      'application. Names are lowercase (letters, digits, hyphens, underscores); OWNER, ' +
      'ADMIN and MEMBER are reserved built-ins.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 2, maxLength: 40 },
        baseRole: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
        description: { type: 'string', maxLength: 240 },
        isDefault: {
          type: 'boolean',
          description: 'Assign this role when an invitation omits one. Demotes the previous default.',
        },
      },
      required: ['applicationId', 'name', 'baseRole'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      assertOrganizationsEnabled(app);
      const created = await organizationRolesService.create({
        applicationId: app.id,
        name: String(args.name),
        baseRole: args.baseRole as 'OWNER' | 'ADMIN' | 'MEMBER',
        ...(args.description !== undefined && { description: String(args.description) }),
        ...(args.isDefault !== undefined && { isDefault: args.isDefault === true }),
      });
      audit(ctx, 'app.organization_role_created', app.id, {
        name: created.name,
        baseRole: created.baseRole,
      });
      return created;
    },
  },
  {
    name: 'update_organization_role',
    description:
      "Edit an organization role's description, authority tier, or default flag. The NAME is " +
      'immutable because memberships store it by value, so renaming means deleting with ' +
      '`reassignTo` instead. A built-in role (OWNER/ADMIN/MEMBER) cannot be re-tiered. ' +
      'Changing `baseRole` changes what every member already holding this role may do, in ' +
      'every organization in the application.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 40 },
        baseRole: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER'] },
        description: { type: ['string', 'null'], maxLength: 240 },
        isDefault: { type: 'boolean' },
      },
      required: ['applicationId', 'name'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      assertOrganizationsEnabled(app);
      const updated = await organizationRolesService.update({
        applicationId: app.id,
        name: String(args.name),
        ...(args.description !== undefined && {
          description: args.description === null ? null : String(args.description),
        }),
        ...(args.baseRole !== undefined && {
          baseRole: args.baseRole as 'OWNER' | 'ADMIN' | 'MEMBER',
        }),
        ...(args.isDefault !== undefined && { isDefault: args.isDefault === true }),
      });
      audit(ctx, 'app.organization_role_updated', app.id, {
        name: updated.name,
        baseRole: updated.baseRole,
      });
      return updated;
    },
  },
  {
    name: 'delete_organization_role',
    description:
      'Delete a custom organization role. Built-ins and the default role cannot be deleted. ' +
      'If memberships or pending invitations still reference the role, pass `reassignTo` ' +
      'with another role name, and holders are moved and the role dropped in one transaction. ' +
      'Reassigning an OWNER-tier role to a lower tier is refused, because it would leave ' +
      'organizations without an owner.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 40 },
        reassignTo: { type: 'string', minLength: 1, maxLength: 40 },
      },
      required: ['applicationId', 'name'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      assertOrganizationsEnabled(app);
      const result = await organizationRolesService.remove({
        applicationId: app.id,
        name: String(args.name),
        ...(args.reassignTo !== undefined && { reassignTo: String(args.reassignTo) }),
      });
      audit(ctx, 'app.organization_role_deleted', app.id, {
        name: String(args.name),
        ...(args.reassignTo !== undefined && { reassignedTo: String(args.reassignTo) }),
      });
      return result;
    },
  },

  {
    name: 'create_usage_meter',
    description:
      'Create a usage meter — what an agent product actually bills on. `slug` is what your ' +
      'server records against (`usage.record`), `unit` is the thing counted (tokens, calls, ' +
      'seconds). A meter only COUNTS until a plan gives it a USAGE entitlement: set that ' +
      'with put_plan_entitlement, using the meter slug as `key`, `quantity` for the included ' +
      'allowance, and `creditsPerUnit` to charge for overage instead of capping.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        slug: { type: 'string', minLength: 1, maxLength: 40 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        unit: { type: 'string', minLength: 1, maxLength: 40 },
        creditsPerUnit: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          description:
            'Credits charged per unit past the included quota. Omit to only COUNT usage ' +
            'rather than charge for it.',
        },
      },
      required: ['applicationId', 'slug', 'name', 'unit'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const meter = await usageService.createMeter({
        applicationId: app.id,
        slug: String(args.slug),
        name: String(args.name),
        unit: String(args.unit),
        ...(args.creditsPerUnit !== undefined && {
          creditsPerUnit: Number(args.creditsPerUnit),
        }),
      });
      return { meter };
    },
  },
  {
    name: 'list_usage_meters',
    description:
      'Meters on an application. Use a slug here as the `key` of a USAGE entitlement to give ' +
      'a plan an allowance on it.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string', minLength: 1 } },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      return { meters: await usageService.listMeters(app.id) };
    },
  },
  {
    name: 'put_plan_entitlement',
    description:
      'Create or replace ONE entitlement on a plan. This is what actually gates access — ' +
      'a plan with no entitlements grants nothing, whatever it costs. `kind` is FEATURE ' +
      '(a flag or limit, needs `key` and usually `valueType`+`value`), CREDIT (a credit ' +
      'grant per period, needs `quantity`), USAGE (an included quota for a meter, `key` is ' +
      'the meter slug and `quantity` the included units; `creditsPerUnit` prices overage ' +
      'instead of capping), or LICENSE (needs `licenseKind`). Upserts on (plan, kind, key).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        planSlug: { type: 'string', minLength: 1 },
        kind: { type: 'string', enum: ['FEATURE', 'CREDIT', 'USAGE', 'LICENSE'] },
        key: { type: 'string', maxLength: 60 },
        valueType: { type: 'string', enum: ['BOOL', 'INT', 'STRING'] },
        value: { type: 'string', maxLength: 200 },
        quantity: { type: 'integer', minimum: 0 },
        creditsPerUnit: { type: 'integer', minimum: 0 },
        licenseKind: { type: 'string', enum: ['PERPETUAL', 'TIMED', 'SEATS'] },
        rollover: { type: 'boolean' },
      },
      required: ['applicationId', 'planSlug', 'kind'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const plan = await plansService.getBySlug(app.id, String(args.planSlug));
      const ent = await entitlementsService.upsert({
        planId: plan.id,
        kind: args.kind as never,
        ...(args.key !== undefined && { key: String(args.key) }),
        ...(args.valueType !== undefined && { valueType: args.valueType as never }),
        ...(args.value !== undefined && { value: String(args.value) }),
        ...(args.quantity !== undefined && { quantity: Number(args.quantity) }),
        ...(args.creditsPerUnit !== undefined && { creditsPerUnit: Number(args.creditsPerUnit) }),
        ...(args.licenseKind !== undefined && { licenseKind: args.licenseKind as never }),
        ...(args.rollover !== undefined && { rollover: args.rollover === true }),
      });
      audit(ctx, 'app.plan_entitlement_updated', app.id, {
        planSlug: plan.slug,
        kind: ent.kind,
        key: ent.key,
      });
      return { planSlug: plan.slug, entitlement: ent };
    },
  },
  {
    name: 'list_plan_entitlements',
    description:
      'What a plan actually grants. Read this back after put_plan_entitlement — a priced ' +
      'plan with an empty list gates nothing.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        planSlug: { type: 'string', minLength: 1 },
      },
      required: ['applicationId', 'planSlug'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const plan = await plansService.getBySlug(app.id, String(args.planSlug));
      return { planSlug: plan.slug, entitlements: await entitlementsService.listForPlan(plan.id) };
    },
  },
  {
    name: 'list_plans',
    description:
      'Plans on an application, including inactive ones. Slugs for the other tools. Each plan ' +
      'carries `checkout.ready` — false means a buyer sent to checkout for it is refused, and ' +
      '`checkout.blockers` says by which provider and how to repair it. Check it after ' +
      'configuring a billing provider: plans register with the provider when they are CREATED, ' +
      'so any plan created before the credentials existed has no price behind it and connecting ' +
      'the provider afterwards does not repair it.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string', minLength: 1 } },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const plans = await plansService.listForApplication(app.id, true);
      const readiness = await planCheckoutReadiness(app.id, plans);
      return {
        plans: plans.map((plan) => ({
          ...plan,
          checkout: readiness.get(plan.id) ?? { ready: true, blockers: [] },
        })),
      };
    },
  },
  {
    name: 'register_plan_with_provider',
    description:
      'Register an existing plan with the billing provider, giving it a price so it can be ' +
      'bought. The repair for `checkout.ready: false` on a plan created before the provider ' +
      'was configured. Idempotent: a plan that already has a price is answered from the row ' +
      'without calling the provider. A plan the provider previously refused is reactivated on ' +
      'success, because it was deactivated by Rekey rather than by you; a plan you retired on ' +
      'purpose keeps its `active: false`, since this registers rather than publishes.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        planSlug: { type: 'string', minLength: 1 },
      },
      required: ['applicationId', 'planSlug'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const plan = await plansService.registerWithProvider(app.id, String(args.planSlug));
      // Its REST twin records `app.plan_updated` and this file's header claims
      // every write tool leaves a trail. A tool that mints a live price at a
      // payment provider is not the one to be missing from the audit log.
      //
      // Through `audit` like every other write tool here, not a hand-rolled
      // call. The hand-rolled one omitted `ip` and `userAgent`, so the single
      // most consequential entry in this file was also the only one that could
      // not be traced to a request, and it wrote `via: 'mcp'` where the rest
      // of the file writes `via: 'operator_mcp'`, which quietly breaks any
      // query that filters on it.
      audit(ctx, 'app.plan_updated', app.id, {
        planSlug: plan.slug,
        registrationStatus: plan.registrationStatus,
      });
      return { plan, checkout: await planCheckoutReadinessFor(app.id, plan) };
    },
  },
  {
    name: 'list_api_keys',
    description:
      'API keys on an application — id, name, prefix, scopes, last use. Never the key ' +
      'itself; it is hashed at rest.',
    write: false,
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string', minLength: 1 } },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      return { apiKeys: await apiKeysService.listForApplication(app.id) };
    },
  },
  {
    name: 'revoke_api_key',
    description:
      'Revoke an API key immediately. Ships with mint_api_key deliberately: an agent that ' +
      'retries a mint has no other way to clean up its own orphans, and the per-application ' +
      'key cap counts active keys.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        apiKeyId: { type: 'string', minLength: 1 },
      },
      required: ['applicationId', 'apiKeyId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      await apiKeysService.revoke(app.id, String(args.apiKeyId));
      audit(ctx, 'app.api_key.revoked', app.id, { apiKeyId: String(args.apiKeyId) });
      return { revoked: true, apiKeyId: String(args.apiKeyId) };
    },
  },
  {
    name: 'mint_api_key',
    description:
      'Mint a server-side API key (rp_live_… / rp_test_…) for an Application. Returns the ' +
      'raw key EXACTLY ONCE — it is hashed at rest and cannot be retrieved again. Scopes ' +
      'default to full access; pass a narrower list to restrict the key. Optional ' +
      '`expiresAt` is an ISO-8601 datetime in the future.',
    write: true,
    // Admin tier, for the same reason `configure_billing_provider` is: a secret
    // crosses the MCP client. Here it crosses outward — the raw key is
    // serialised into the tool result and lands in the agent transcript and the
    // model provider's logs.
    //
    // It also closes an escalation. The REST twin requires the `keys:mint` PAT
    // scope ("the highest-privilege scope"), but MCP write access is derived
    // from `applications:write` alone, so a PAT holding only
    // ['read','applications:write'] could mint over MCP what the same token is
    // refused over REST. `canAdmin` is false for every PAT, so admin tier makes
    // this OAuth-consent-only and the two surfaces agree again.
    admin: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 80 },
        scopes: { type: 'array', items: { type: 'string' } },
        expiresAt: { type: 'string', format: 'date-time' },
      },
      required: ['applicationId', 'name'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));

      // Empty scopes mean full access in the service, which is the same default
      // the panel's mint form applies. Passing a list narrows the key.
      const scopes = Array.isArray(args.scopes) ? args.scopes.map(String) : [];

      let expiresAt: Date | undefined;
      if (typeof args.expiresAt === 'string' && args.expiresAt !== '') {
        const parsed = new Date(args.expiresAt);
        if (Number.isNaN(parsed.getTime())) {
          throw new RekeyError({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            message: `expiresAt "${args.expiresAt}" is not a valid ISO-8601 datetime.`,
            fix: 'Pass an ISO-8601 datetime in the future, or omit it for a non-expiring key.',
          });
        }
        expiresAt = parsed;
      }

      const result = await apiKeysService.create({
        applicationId: app.id,
        name: String(args.name),
        scopes,
        ...(expiresAt !== undefined && { expiresAt }),
      });

      // The key itself is never audited — only that one was minted, by whom,
      // and for which application. Same rule the panel's route follows.
      audit(ctx, 'app.api_key.created', app.id, {
        apiKeyId: result.apiKey.id,
        name: result.apiKey.name,
        scopes: result.apiKey.scopes,
      });

      return {
        applicationId: app.id,
        applicationSlug: app.slug,
        id: result.apiKey.id,
        name: result.apiKey.name,
        keyPrefix: result.apiKey.keyPrefix,
        scopes: result.apiKey.scopes,
        expiresAt: result.apiKey.expiresAt,
        // Shown once. There is no endpoint that can return it again.
        rawKey: result.rawKey,
        warning: 'Store this now — the raw key is hashed at rest and cannot be retrieved again.',
      };
    },
  },
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
      'and `signupMode` to control public sign-up. It deliberately cannot turn this ' +
      'application into a public OpenID Provider (`oidcEnabled`) or reopen client ' +
      'registration (`dynamicClientRegistration`); those stay operator-console decisions.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        methods: { type: 'array', items: { type: 'string' } },
        // Bounds copied from the PATCH /auth-config route so the two surfaces
        // agree, not because this tool goes through it: the handler calls
        // `applicationsService.updateAuthConfig` directly, and the only bound
        // ENFORCED on this path is AuthConfigSchema's 8..1024. They used to be
        // 6..256, which advertised 6 and 7 as valid when the shared schema
        // refuses them outright. Anything between 129 and 1024 is still
        // storable here and not over REST; narrowing what is advertised keeps
        // an agent from opening that gap by accident.
        passwordMinLength: { type: 'integer', minimum: 8, maximum: 128 },
        redirectUrls: { type: 'array', items: { type: 'string' } },
        appUrl: {
          type: ['string', 'null'],
          description:
            'Base URL of the customer application that transactional emails link back to. ' +
            'Null or "" clears it; with nothing resolvable the email CTA button is omitted.',
        },
        hostedAuthorizeUrl: {
          type: ['string', 'null'],
          description:
            "Where to send the browser for the sign-in half of this application's OpenID " +
            'Connect flow. Unset, the API renders its own email + password page, which is a ' +
            'dead end for users who sign in with Google and have no password. Null or "" ' +
            'turns delegation back off. SECURITY: this is a redirect target in a live ' +
            "sign-in flow, so only ever set it to a page the application's own operator " +
            'controls. The API refuses to delegate to its own authorize endpoint.',
        },
        organizationsEnabled: { type: 'boolean' },
        signupMode: { type: 'string', enum: ['public', 'secret_only', 'invite_only'] },
        mfa: { type: 'string', enum: ['off', 'optional', 'required'] },
        mcpEnabled: { type: 'boolean' },
        tokenAlg: {
          type: 'string',
          enum: ['HS256', 'RS256'],
          description:
            'Signature alg for NEW end-user access tokens. RS256 tokens verify offline ' +
            'against GET /.well-known/jwks.json; HS256 (default) requires the API. ' +
            'Switching never breaks outstanding tokens, since the API verifies both.',
        },
        passwordBreachCheckEnabled: { type: 'boolean' },
        sendVerificationEmailOnSignUp: {
          type: 'boolean',
          description: 'Send the verification email automatically on password sign-up. Default true.',
        },
        requireEmailVerification: {
          type: 'boolean',
          description:
            'Refuse password sign-in until the end-user confirms their address (403 EMAIL_NOT_VERIFIED). Default false; applies to existing unverified accounts immediately.',
        },
      },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const patch = {
        ...(args.methods !== undefined && { methods: args.methods as string[] }),
        ...(args.passwordMinLength !== undefined && {
          passwordMinLength: Number(args.passwordMinLength),
        }),
        ...(args.redirectUrls !== undefined && { redirectUrls: args.redirectUrls as string[] }),
        ...(args.appUrl !== undefined && {
          appUrl: args.appUrl === null ? null : String(args.appUrl),
        }),
        ...(args.hostedAuthorizeUrl !== undefined && {
          hostedAuthorizeUrl:
            args.hostedAuthorizeUrl === null ? null : String(args.hostedAuthorizeUrl),
        }),
        ...(args.organizationsEnabled !== undefined && {
          organizationsEnabled: args.organizationsEnabled === true,
        }),
        ...(args.signupMode !== undefined && {
          signupMode: args.signupMode as 'public' | 'secret_only' | 'invite_only',
        }),
        ...(args.mfa !== undefined && { mfa: args.mfa as 'off' | 'optional' | 'required' }),
        ...(args.mcpEnabled !== undefined && { mcpEnabled: args.mcpEnabled === true }),
        ...(args.tokenAlg !== undefined && { tokenAlg: args.tokenAlg as 'HS256' | 'RS256' }),
        ...(args.passwordBreachCheckEnabled !== undefined && {
          passwordBreachCheckEnabled: args.passwordBreachCheckEnabled === true,
        }),
        ...(args.sendVerificationEmailOnSignUp !== undefined && {
          sendVerificationEmailOnSignUp: args.sendVerificationEmailOnSignUp === true,
        }),
        ...(args.requireEmailVerification !== undefined && {
          requireEmailVerification: args.requireEmailVerification === true,
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
      '(e.g. cents). Defaults: currency USD, interval MONTH, kind SUBSCRIPTION.\n\n' +
      'Each `kind` needs its own fields, and the API refuses the plan without them:\n' +
      '- SUBSCRIPTION: nothing extra. `interval` applies. Free trials are held in this ' +
      'release and a plan cannot carry one.\n' +
      '- CREDIT: `creditsAmount`. A one-off pack of credits, not a recurring charge.\n' +
      '- LICENSE: `licenseKind`, plus `licenseDurationDays` for TIMED and ' +
      '`licenseSeatsAllowed` for SEATS.\n' +
      '- USAGE: `meterSlug` (see list_usage_meters) and `pricePerUnitCents`.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        slug: { type: 'string', minLength: 1, maxLength: 40 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        amount: { type: 'integer', minimum: 0, maximum: 2147483647 },
        currency: { type: 'string', minLength: 3, maxLength: 3 },
        interval: { type: 'string', enum: ['MONTH', 'YEAR'] },
        kind: {
          type: 'string',
          enum: ['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT'],
          description:
            'Defaults to SUBSCRIPTION. Without this, a credit pack or a license cannot be ' +
            'created at all, only a recurring subscription.',
        },
        creditsAmount: {
          // 1, not 0. The service refuses `creditsAmount <= 0` with
          // PLAN_CREDITS_AMOUNT_REQUIRED and the REST body says `minimum: 1`,
          // so advertising 0 would tell an agent a value is valid and then
          // refuse it — the exact defect this pass narrowed passwordMinLength
          // to remove.
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
          description: 'CREDIT plans: how many credits the purchase grants. Required for that kind.',
        },
        licenseKind: {
          type: 'string',
          enum: ['PERPETUAL', 'TIMED', 'SEATS'],
          description: 'LICENSE plans: required for that kind.',
        },
        licenseDurationDays: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
          description: 'LICENSE plans with licenseKind TIMED: required for that combination.',
        },
        licenseSeatsAllowed: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
          description: 'LICENSE plans with licenseKind SEATS: required for that combination.',
        },
        meterSlug: {
          type: 'string',
          minLength: 1,
          maxLength: 40,
          description: 'USAGE plans: the usage meter this plan bills against. Required for that kind.',
        },
        pricePerUnitCents: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          description: 'USAGE plans: charge per metered unit past the included quota.',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          // Provider-reserved keys (stripe / paypal / razorpay) are stripped by
          // the service: naming a price id here would otherwise make the plan
          // charge for someone else's product.
          description: 'Free-form operator metadata stored on the plan.',
        },
      },
      required: ['applicationId', 'slug', 'name', 'amount'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const plan = await plansService.create({
        applicationId: app.id,
        slug: String(args.slug),
        name: String(args.name),
        amount: Number(args.amount),
        ...(args.currency !== undefined && { currency: String(args.currency) }),
        ...(args.interval !== undefined && {
          interval: args.interval as 'MONTH' | 'YEAR',
        }),
        ...(args.kind !== undefined && {
          kind: args.kind as 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT',
        }),
        ...(args.creditsAmount !== undefined && { creditsAmount: Number(args.creditsAmount) }),
        ...(args.licenseKind !== undefined && {
          licenseKind: args.licenseKind as 'PERPETUAL' | 'TIMED' | 'SEATS',
        }),
        ...(args.licenseDurationDays !== undefined && {
          licenseDurationDays: Number(args.licenseDurationDays),
        }),
        ...(args.licenseSeatsAllowed !== undefined && {
          licenseSeatsAllowed: Number(args.licenseSeatsAllowed),
        }),
        ...(args.meterSlug !== undefined && { meterSlug: String(args.meterSlug) }),
        ...(args.pricePerUnitCents !== undefined && {
          pricePerUnitCents: Number(args.pricePerUnitCents),
        }),
        ...(args.metadata !== undefined && {
          metadata: args.metadata as Record<string, unknown>,
        }),
      });
      audit(ctx, 'app.plan_created', app.id, {
        planSlug: plan.slug,
        amount: plan.amount,
        kind: plan.kind,
      });
      return {
        id: plan.id,
        slug: plan.slug,
        name: plan.name,
        // Echo the kind and its per-kind field, so the caller can see that a
        // credit pack really was created as a credit pack rather than silently
        // defaulting to a subscription.
        kind: plan.kind,
        amount: plan.amount,
        currency: plan.currency,
        interval: plan.interval,
        creditsAmount: plan.creditsAmount,
        trialDays: plan.trialDays,
        licenseKind: plan.licenseKind,
        licenseDurationDays: plan.licenseDurationDays,
        licenseSeatsAllowed: plan.licenseSeatsAllowed,
        meterSlug: plan.meterSlug,
        pricePerUnitCents: plan.pricePerUnitCents,
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
      'replacement with create_plan UNDER A DIFFERENT SLUG. Archiving does not release the slug: ' +
      'it is the identifier integrations pass to checkout, so reusing it is refused with ' +
      'PLAN_SLUG_TAKEN. Reversible.',
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
      const app = await loadAppInTenant(ctx, String(args.applicationId));
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
      'ARCHIVE this plan (set_plan_active active=false) and CREATE a replacement (create_plan) ' +
      'under a DIFFERENT slug, because archiving does not release the old one. Existing ' +
      'subscribers keep their old price, new sign-ups get the new plan.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        slug: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        licenseSeatsAllowed: { type: 'integer', minimum: 0, description: 'LICENSE plans only.', maximum: 2147483647 },
        licenseDurationDays: { type: 'integer', minimum: 0, description: 'LICENSE plans only.', maximum: 2147483647 },
        creditsAmount: { type: 'integer', minimum: 0, description: 'CREDIT plans only.', maximum: 2147483647 },
      },
      required: ['applicationId', 'slug'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
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
      const app = await loadAppInTenant(ctx, String(args.applicationId));
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
      const app = await loadAppInTenant(ctx, String(args.applicationId));
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
        // PANEL_URL has no default (a Rekey default would email a self-hoster's
        // operators a link to OUR panel). Without it we cannot build a usable
        // invite link, so omit the key entirely rather than send a broken one
        // — `exactOptionalPropertyTypes` means an explicit undefined is not the
        // same as absent.
        ...(env.PANEL_URL
          ? { inviteUrl: `${env.PANEL_URL.replace(/\/$/, '')}/accept-invite?token={token}` }
          : {}),
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
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const provider = String(args.provider) as 'stripe' | 'paypal' | 'razorpay';
      const mode = args.mode === 'test' || args.mode === 'live' ? (args.mode as BillingMode) : undefined;
      const options = {
        ...(args.countries !== undefined && { countries: args.countries as string[] }),
        ...(args.enabled !== undefined && { enabled: args.enabled === true }),
        ...(mode !== undefined && { mode }),
      };
      if (provider === 'stripe') {
        await billingCredentialsService.upsertCredentials(
          app.id,
          'stripe',
          { apiKey: String(args.apiKey ?? ''), webhookSecret: String(args.webhookSecret ?? '') },
          options,
        );
      } else if (provider === 'paypal') {
        await billingCredentialsService.upsertCredentials(
          app.id,
          'paypal',
          {
            clientId: String(args.clientId ?? ''),
            clientSecret: String(args.clientSecret ?? ''),
            webhookId: String(args.webhookId ?? ''),
          },
          options,
        );
      } else {
        await billingCredentialsService.upsertCredentials(
          app.id,
          'razorpay',
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
      //
      // The tenant filter is IN the query, not applied afterwards. Looking the
      // row up by id alone and then checking its application made this an
      // existence oracle: a foreign subscription id answered
      // `APPLICATION_NOT_FOUND` while an absent one answered
      // `SUBSCRIPTION_NOT_FOUND`, and the first of those interpolated the
      // FOREIGN application id into the message it handed back. Two codes and a
      // leaked id, from the comment that says neither happens.
      const sub = await prisma.subscription.findFirst({
        where: { id: subscriptionId, application: { tenantId: ctx.tenantId } },
        select: { applicationId: true },
      });
      if (!sub) {
        throw new RekeyError({
          statusCode: 404,
          code: 'SUBSCRIPTION_NOT_FOUND',
          message: `Subscription "${subscriptionId}" not found in this workspace.`,
          fix: 'Use recent_subscriptions to find a subscription id in this workspace.',
        });
      }
      const app = await loadAppInTenant(ctx, sub.applicationId);
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
