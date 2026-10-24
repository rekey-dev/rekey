/**
 * Operator MCP WRITE tools, phase 1 (reversible workspace configuration).
 *
 * Most tools here mutate, and those are listed / dispatchable only when the
 * caller's token carries write capability (`mcp:operator:write` for the OAuth
 * path, `applications:write` for a PAT) AND their role clears the tool's
 * `minRole` (default ADMIN). The dispatcher in `tenant-mcp-server.ts` enforces
 * both before a handler runs, but every handler ALSO re-scopes by tenant, so a
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
 * App-targeted authorization for EVERY tool in this file, read and write,
 * lives in `loadAppInTenant` below. Read its docstring before adding a tool
 * that takes an `applicationId`.
 *
 * Reuse, not reimplementation: each handler calls the same service the panel
 * routes use (`applicationsService`, `plansService`, `webhookService`), so
 * validation, slug rules, provider registration, and secret generation behave
 * identically to the panel. Every successful write emits a `securityEvent`.
 *
 * Write tier is for configuration that grants nobody authority. A tool carries
 * `admin: true`, which demands the `mcp:operator:admin` scope on top of the
 * role check, when it is irreversible, moves a secret through the MCP client,
 * or could turn a write token into admin power, a credential or a copy of
 * end-user data: `configure_billing_provider`, `cancel_subscription`,
 * `mint_api_key`, `update_auth_config` (it decides where sign-in links land),
 * the two webhook endpoint tools (they pick where every event is posted) and
 * `change_member_role`. The capped tools stay in write tier for MEMBER-level
 * work and call `assertAdminTierFor` before anything that touches OWNER or
 * ADMIN authority. `test/operator-mcp-write-tier-escalation.test.ts` holds a
 * ruling for every write tool and fails when a new one has none.
 *
 * Still deliberately absent: delete application and webhook-secret rotation,
 * no undo, and no confirmation step an agent can be trusted to have surfaced
 * to a human.
 */

import type { Application, TenantRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { maskIp, mayReadRawIps } from '../../lib/ip-mask.js';
import { env } from '../../config/env.js';
import { RekeyError } from '../../lib/error.js';
import type { SecurityEventType } from '@rekey.dev/shared-types';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { apiKeysService } from '../api-keys/api-keys.service.js';
import { assertMayMintScopes } from '../api-keys/elevated-scopes.js';
import { accessContextFromTool } from '../../lib/access-context.js';
import { entitlementsService } from '../billing/entitlements.service.js';
import { usageService } from '../usage/usage.service.js';
import { applicationsService } from '../applications/applications.service.js';
import { refreshWebhookAfterEdit, webhookStateBeforeEdit } from '../billing/webhook-registration.js';
import { plansService } from '../plans/plans.service.js';
import { webhookService } from '../webhooks/webhook.service.js';
import { billingService } from '../billing/billing.service.js';
import {
  billingCredentialsService,
  type BillingMode,
  type BillingProviderName,
} from '../billing/credentials.service.js';
import { getModule, registryNames } from '../billing/providers/registry.js';
import { tenantWorkspacesService } from '../tenant-workspaces/tenant-workspaces.service.js';
import { organizationRolesService } from '../organization-roles/organization-roles.service.js';
import { API_KEY_SCOPES, AuthConfigSchema, SIGNUP_DOMAIN_LIST_MAX, SignupRestrictionsSchema } from '@rekey.dev/shared-types';
import { devicesService } from '../devices/devices.service.js';
import { assertEndUserInApplication } from '../../lib/end-users.js';
import {
  accessibleApplicationIds,
  type OperatorTool,
  type OperatorToolContext,
} from './operator-tools.js';
import { assertAdminTierFor } from './admin-tier.js';

/**
 * Resolve a workspace member's membership id from their tenant-user id, scoped
 * to the operator's tenant. A tenant-user id from another workspace is
 * indistinguishable from a non-existent one (no cross-tenant reach).
 */
async function membershipIdInTenant(tenantId: string, tenantUserId: string): Promise<string> {
  return (await membershipInTenant(tenantId, tenantUserId)).id;
}

async function membershipInTenant(tenantId: string, tenantUserId: string): Promise<{ id: string; role: TenantRole }> {
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
  return { id: membership.id, role: membership.role };
}

/**
 * Load an application and assert the caller may reach it, same workspace AND
 * within their per-application grants.
 *
 * `applicationsService.get` is NOT tenant-scoped (it fetches by id alone), so
 * every app-targeted tool MUST funnel through here, otherwise an operator
 * could pass another tenant's applicationId and mutate it. The not-found,
 * wrong-tenant and not-granted cases return the SAME error so the caller can't
 * probe which application ids exist outside what they may see.
 *
 * The GRANT half was missing, and it mattered for the four READ tools that live
 * in this file, `list_plans`, `list_plan_entitlements`, `list_usage_meters`,
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
 * workspace to a `legacyWorkspaceRead` MEMBER, both of which `ensureAppAccess`
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
 * because it survives over REST too, this is parity, not a gap.
 */
export async function loadAppInTenant(
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

const WELCOME_EMAIL_VALUES = ['on_signup', 'on_verified', 'off'] as const;

/** Checked here because this server does not validate tool arguments against their schema. */
function parseWelcomeEmail(value: unknown): (typeof WELCOME_EMAIL_VALUES)[number] {
  const match = WELCOME_EMAIL_VALUES.find((v) => v === value);
  if (match === undefined) {
    throw new RekeyError({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: `welcomeEmail "${String(value)}" is not one of ${WELCOME_EMAIL_VALUES.join(', ')}.`,
      fix: 'Pass welcomeEmail as "on_signup", "on_verified" or "off".',
    });
  }
  return match;
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

/** The same audit trail, for write tools that live in their own file. */
export { audit as auditOperatorWrite };


/**
 * Organization-role writes need organizations switched on for the Application.
 *
 * The refusal is the product surface, not just a guard: an agent asking to
 * create `content-manager` on an Application with organizations off should be
 * told to enable them (and how) rather than getting a role nobody can hold.
 * Mirrors `requireOrganizationsEnabled` on the REST side.
 */
export function assertOrganizationsEnabled(app: Application): void {
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

const PRIVILEGED_ORG_ROLE = 'an OWNER- or ADMIN-tier organization role';

/**
 * Security: an organization role above MEMBER tier is authority over a
 * customer's organization, so write tier may only create, edit, reassign onto
 * or delete MEMBER-tier roles.
 */
async function assertWriteTierMayTouchRole(
  ctx: OperatorToolContext,
  applicationId: string,
  roleName: string,
  action: string,
): Promise<void> {
  const tiers = await organizationRolesService.baseRoleMap(applicationId);
  const tier = tiers.get(roleName);
  if (tier !== undefined && tier !== 'MEMBER') assertAdminTierFor(ctx, `${action} ${PRIVILEGED_ORG_ROLE}`);
}

/** Shared by the device and support tools: the end-user must be in an app the operator can read. */
export async function loadEndUserInApp(
  ctx: OperatorToolContext,
  applicationId: string,
  endUserId: string,
): Promise<Application> {
  const app = await loadAppInTenant(ctx, applicationId);
  await assertEndUserInApplication(app.id, endUserId, 'Use get_end_user to find the id.');
  return app;
}

function deviceView(ctx: OperatorToolContext, d: {
  id: string;
  fingerprint: string;
  label: string | null;
  status: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenIp: string | null;
  releasedAt: Date | null;
  blockedAt: Date | null;
  blockedReason: string | null;
}) {
  return {
    id: d.id,
    fingerprint: d.fingerprint,
    label: d.label,
    status: d.status,
    firstSeenAt: d.firstSeenAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    lastSeenIp: mayReadRawIps(ctx.role, accessContextFromTool(ctx).scopes) ? d.lastSeenIp : maskIp(d.lastSeenIp),
    releasedAt: d.releasedAt?.toISOString() ?? null,
    blockedAt: d.blockedAt?.toISOString() ?? null,
    blockedReason: d.blockedReason,
  };
}

const DEVICE_TOOL_ARGS = {
  applicationId: { type: 'string', minLength: 1 },
  endUserId: { type: 'string', minLength: 1 },
  deviceId: { type: 'string', minLength: 1 },
} as const;

/** A stored list that matches nothing takes the provider out of routing, so a malformed code is refused, not saved. */
function currencyCodes(value: unknown): string[] {
  const codes = Array.isArray(value) ? value : [];
  const bad = codes.find((c) => typeof c !== 'string' || !/^[A-Za-z]{3}$/.test(c));
  if (bad !== undefined) {
    throw new RekeyError({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: `"${String(bad)}" is not an ISO 4217 currency code.`,
      fix: 'Pass three-letter codes such as "USD" or "INR", or an empty array for a provider that is used for no checkout.',
    });
  }
  return codes as string[];
}

export const operatorWriteTools: OperatorTool[] = [
  {
    name: 'list_devices',
    description:
      "List an end-user's devices, the machines they have signed in from, newest activity " +
      'first, including released and blocked ones. Read-only. See docs/devices.md.',
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: DEVICE_TOOL_ARGS.applicationId,
        endUserId: DEVICE_TOOL_ARGS.endUserId,
        status: { type: 'string', enum: ['ACTIVE', 'RELEASED', 'BLOCKED'] },
      },
      required: ['applicationId', 'endUserId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadEndUserInApp(ctx, String(args.applicationId), String(args.endUserId));
      const status = args.status === undefined ? undefined : (String(args.status) as 'ACTIVE' | 'RELEASED' | 'BLOCKED');
      const { items, total } = await devicesService.listForEndUser(app.id, String(args.endUserId), { status, take: 100 });
      return { total, devices: items.map((d) => deviceView(ctx, d)) };
    },
  },
  {
    name: 'release_device',
    description:
      "Release one of an end-user's devices: gives the slot back against max_devices and revokes " +
      'every session minted on it. Idempotent. A BLOCKED device must be unblocked first.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: DEVICE_TOOL_ARGS,
      required: ['applicationId', 'endUserId', 'deviceId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadEndUserInApp(ctx, String(args.applicationId), String(args.endUserId));
      const r = await devicesService.release({
        applicationId: app.id,
        endUserId: String(args.endUserId),
        deviceId: String(args.deviceId),
        actor: { type: 'operator', id: ctx.tenantUserId },
      });
      return { device: deviceView(ctx, r.device), sessionsRevoked: r.sessionsRevoked };
    },
  },
  {
    name: 'block_device',
    description:
      'Block a device: sign-in from that fingerprint is refused (DEVICE_BLOCKED) until unblocked, ' +
      'and its sessions are revoked now. The reason is operator-facing only. Idempotent.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { ...DEVICE_TOOL_ARGS, reason: { type: 'string', maxLength: 500 } },
      required: ['applicationId', 'endUserId', 'deviceId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadEndUserInApp(ctx, String(args.applicationId), String(args.endUserId));
      const r = await devicesService.block({
        applicationId: app.id,
        endUserId: String(args.endUserId),
        deviceId: String(args.deviceId),
        reason: args.reason === undefined ? undefined : String(args.reason),
        operatorUserId: ctx.tenantUserId,
      });
      return { device: deviceView(ctx, r.device), sessionsRevoked: r.sessionsRevoked };
    },
  },
  {
    name: 'unblock_device',
    description:
      'Lift a block. The device comes back as RELEASED and takes a slot again only on its next ' +
      'sign-in, subject to max_devices. Idempotent.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: DEVICE_TOOL_ARGS,
      required: ['applicationId', 'endUserId', 'deviceId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadEndUserInApp(ctx, String(args.applicationId), String(args.endUserId));
      const device = await devicesService.unblock({
        applicationId: app.id,
        endUserId: String(args.endUserId),
        deviceId: String(args.deviceId),
        operatorUserId: ctx.tenantUserId,
      });
      return { device: deviceView(ctx, device) };
    },
  },
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
      'ADMIN and MEMBER are reserved built-ins. A `baseRole` of OWNER or ADMIN needs admin ' +
      'access (the mcp:operator:admin scope); write access creates MEMBER-tier roles only.',
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
      if (args.baseRole !== 'MEMBER') assertAdminTierFor(ctx, `Creating ${PRIVILEGED_ORG_ROLE}`);
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
      'every organization in the application. Editing a role that is OWNER or ADMIN tier, or ' +
      'raising one to those tiers, needs admin access (the mcp:operator:admin scope).',
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
      await assertWriteTierMayTouchRole(ctx, app.id, String(args.name), 'Editing');
      if (args.baseRole !== undefined && args.baseRole !== 'MEMBER') {
        assertAdminTierFor(ctx, `Raising a role to ${PRIVILEGED_ORG_ROLE}`);
      }
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
      'organizations without an owner. Deleting an OWNER- or ADMIN-tier role, or reassigning ' +
      'holders onto one, needs admin access (the mcp:operator:admin scope).',
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
      await assertWriteTierMayTouchRole(ctx, app.id, String(args.name), 'Deleting');
      if (args.reassignTo !== undefined) {
        await assertWriteTierMayTouchRole(ctx, app.id, String(args.reassignTo), 'Reassigning members onto');
      }
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
      'Create a usage meter, what an agent product actually bills on. `slug` is what your ' +
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
      'Create or replace ONE entitlement on a plan. This is what actually gates access, ' +
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
      'What a plan actually grants. Read this back after put_plan_entitlement, a priced ' +
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
    name: 'list_api_keys',
    description:
      'API keys on an application, id, name, prefix, scopes, last use. Never the key ' +
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
      'raw key EXACTLY ONCE, it is hashed at rest and cannot be retrieved again. Scopes ' +
      'default to full access; pass a narrower list to restrict the key. Valid scopes: ' +
      `${API_KEY_SCOPES.join(', ')}; any other value is refused with API_KEY_SCOPE_UNKNOWN. Optional ` +
      '`expiresAt` is an ISO-8601 datetime in the future.',
    write: true,
    // Admin tier, for the same reason `configure_billing_provider` is: a secret
    // crosses the MCP client. Here it crosses outward, the raw key is
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
      // An elevated scope needs the authority of what it does, see elevated-scopes.ts.
      await assertMayMintScopes(accessContextFromTool({ ...ctx, scopes: ctx.scopes }), app.id, scopes);

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
        revealsEndUserIps: mayReadRawIps(ctx.role, accessContextFromTool(ctx).scopes),
        createdByTenantUserId: ctx.tenantUserId,
        ...(expiresAt !== undefined && { expiresAt }),
      });

      // The key itself is never audited, only that one was minted, by whom,
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
        warning: 'Store this now. The raw key is hashed at rest and cannot be retrieved again.',
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
      'registration (`dynamicClientRegistration`); those stay operator-console decisions. ' +
      'Needs admin access (the mcp:operator:admin scope).',
    write: true,
    // Security: `appUrl` and `redirectUrls` decide where magic-link and reset
    // tokens land, and this tool can switch off MFA and verification, so a
    // write-tier token holding it could take over every end-user account.
    admin: true,
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
            'controls. The API refuses to delegate to its own authorize endpoint. That page ' +
            'must show a consent screen (POST /oauth/authorize/preview) before it calls ' +
            '/oauth/authorize/grant.',
        },
        organizationsEnabled: { type: 'boolean' },
        signupMode: { type: 'string', enum: ['public', 'secret_only', 'invite_only'] },
        signupRestrictions: {
          type: ['object', 'null'],
          description:
            'Which email domains may self sign-up. Replaces the stored rules as a whole; null ' +
            'removes them. `example.com` matches that domain only, `*.example.com` its ' +
            'subdomains. A blocked domain wins over an allowed one. Operator-created and ' +
            'imported users are not checked.',
          properties: {
            allowedDomains: {
              type: 'array',
              maxItems: SIGNUP_DOMAIN_LIST_MAX,
              items: { type: 'string', maxLength: 260 },
            },
            blockedDomains: {
              type: 'array',
              maxItems: SIGNUP_DOMAIN_LIST_MAX,
              items: { type: 'string', maxLength: 260 },
            },
            blockDisposable: { type: 'boolean' },
          },
          additionalProperties: false,
        },
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
        deviceBinding: {
          type: 'string',
          enum: ['optional', 'required'],
          description:
            'Whether primary sign-in flows must carry a device binding. "optional" (default) ' +
            'records a device when the client sends one; "required" refuses sign-in without ' +
            'one. Refresh is never gated.',
        },
        deviceRelease: {
          type: 'string',
          enum: ['self_service', 'server_only'],
          description:
            'Who may release a device. "self_service" (default) lets the end-user release ' +
            'their own; "server_only" refuses that from a browser key, so releases go through ' +
            'the operator or a secret key. Only meaningful with deviceBinding "required".',
        },
        accountDeletion: {
          type: 'string',
          enum: ['self_service', 'server_only', 'off'],
          description:
            'Who may erase an account with DELETE /users/me. "self_service" (default): the end-user ' +
            'from a browser with a password or MFA code, or a secret key. "server_only": a secret key ' +
            'only. "off": nobody; only an operator erasure removes an account.',
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
        welcomeEmail: {
          type: 'string',
          enum: ['on_signup', 'on_verified', 'off'],
          description:
            'When a new account gets the welcome mail. on_signup (default): at creation, but an unverified address waits for verification while requireEmailVerification is on. on_verified: always after verification. off: never.',
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
        ...(args.signupRestrictions !== undefined && {
          signupRestrictions:
            args.signupRestrictions === null
              ? null
              : SignupRestrictionsSchema.parse(args.signupRestrictions),
        }),
        ...(args.mfa !== undefined && { mfa: args.mfa as 'off' | 'optional' | 'required' }),
        ...(args.mcpEnabled !== undefined && { mcpEnabled: args.mcpEnabled === true }),
        ...(args.tokenAlg !== undefined && { tokenAlg: args.tokenAlg as 'HS256' | 'RS256' }),
        ...(args.deviceBinding !== undefined && {
          deviceBinding: args.deviceBinding as 'optional' | 'required',
        }),
        ...(args.deviceRelease !== undefined && {
          deviceRelease: args.deviceRelease as 'self_service' | 'server_only',
        }),
        ...(args.accountDeletion !== undefined && {
          accountDeletion: args.accountDeletion as 'self_service' | 'server_only' | 'off',
        }),
        ...(args.passwordBreachCheckEnabled !== undefined && {
          passwordBreachCheckEnabled: args.passwordBreachCheckEnabled === true,
        }),
        ...(args.sendVerificationEmailOnSignUp !== undefined && {
          sendVerificationEmailOnSignUp: args.sendVerificationEmailOnSignUp === true,
        }),
        ...(args.requireEmailVerification !== undefined && {
          requireEmailVerification: args.requireEmailVerification === true,
        }),
        ...(args.welcomeEmail !== undefined && {
          welcomeEmail: parseWelcomeEmail(args.welcomeEmail),
        }),
      };
      const updated = await applicationsService.updateAuthConfig({
        applicationId: app.id,
        patch,
        actorTenantUserId: ctx.tenantUserId,
      });
      audit(ctx, 'app.auth_config_updated', app.id, {
        fields: Object.keys(patch),
        ...(patch.deviceRelease !== undefined && { deviceRelease: patch.deviceRelease }),
        ...(patch.accountDeletion !== undefined && { accountDeletion: patch.accountDeletion }),
      });
      return { id: updated.id, slug: updated.slug, authConfig: updated.authConfig };
    },
  },
  {
    name: 'create_webhook_endpoint',
    description:
      'Register an outbound webhook endpoint for an application. Returns the endpoint id ' +
      'and the signing secret, the secret is shown ONCE here and cannot be retrieved later. ' +
      'Needs admin access (the mcp:operator:admin scope).',
    write: true,
    // Security: the URL receives every subscribed event with its end-user
    // data, and the signing secret is returned, so a write-tier token holding
    // this could copy the Application's event stream to a host of its choosing.
    admin: true,
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
        createdByTenantUserId: ctx.tenantUserId,
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
      'Update an outbound webhook endpoint, its URL, subscribed events, or enabled flag. ' +
      'Only the fields you pass change. Does not rotate the signing secret. Needs admin ' +
      'access (the mcp:operator:admin scope).',
    write: true,
    // Security: re-pointing the URL redirects the event stream, see create_webhook_endpoint.
    admin: true,
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
        actorTenantUserId: ctx.tenantUserId,
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

  // ── Member management (write), reuses tenantWorkspacesService, whose
  //    ensureCanManage enforces OWNER-manages-anyone / ADMIN-manages-MEMBER. ──
  {
    name: 'invite_member',
    description:
      'Invite a teammate to the workspace by email with a role (OWNER / ADMIN / MEMBER). ' +
      'Sends an invitation email with a secure link. Write access invites MEMBERs only: ' +
      'inviting an OWNER or ADMIN needs the OWNER role and admin access (the ' +
      'mcp:operator:admin scope).',
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
      // Security: an OWNER or ADMIN invitation to an address the caller picks is a new admin seat.
      if (args.role !== 'MEMBER') assertAdminTierFor(ctx, 'Inviting an OWNER or ADMIN');
      const result = await tenantWorkspacesService.createInvitation({
        tenantId: ctx.tenantId,
        invitedById: ctx.tenantUserId,
        invitedByRole: ctx.role,
        email: String(args.email),
        role: String(args.role) as TenantRole,
        // PANEL_URL has no default (a Rekey default would email a self-hoster's
        // operators a link to OUR panel). Without it we cannot build a usable
        // invite link, so omit the key entirely rather than send a broken one
        //, `exactOptionalPropertyTypes` means an explicit undefined is not the
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
      // The raw invite token is intentionally NOT returned, it travels only in
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
      'Already-accepted invitations cannot be revoked, remove the member instead.',
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
    confirmedOperatorOnly: 'change what a member of the workspace can do',
    description:
      "Change a workspace member's role (OWNER / ADMIN / MEMBER). Identify the member by " +
      'tenantUserId (from list_members). Guards against demoting the last OWNER; an ADMIN ' +
      'can only manage MEMBERs. Needs admin access (the mcp:operator:admin scope).',
    write: true,
    // Security: every useful role change grants or removes OWNER or ADMIN
    // authority, so nothing of this tool is left for write tier.
    admin: true,
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
      're-inviting. Guards against removing the last OWNER; an ADMIN can only remove MEMBERs. ' +
      'Write access removes MEMBERs only: removing an OWNER or ADMIN needs admin access (the ' +
      'mcp:operator:admin scope).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { tenantUserId: { type: 'string', minLength: 1 } },
      required: ['tenantUserId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const tenantUserId = String(args.tenantUserId);
      const membership = await membershipInTenant(ctx.tenantId, tenantUserId);
      // Security: removing the other owners and admins leaves the token's holder in sole control.
      if (membership.role !== 'MEMBER') assertAdminTierFor(ctx, 'Removing an OWNER or ADMIN');
      const membershipId = membership.id;
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

  // ── Admin tools (mcp:operator:admin), financial / secret-handling ──────────
  // These require the admin scope AND an OWNER/ADMIN role. Still re-scoped by tenant.
  {
    name: 'configure_billing_provider',
    confirmedOperatorOnly: 'store billing provider credentials',
    description:
      "Set an application's billing-provider credentials. Providers: " +
      registryNames.map((n) => `${n} (${getModule(n)!.credentialSchema.map((f) => f.key).join(', ')})`).join('; ') +
      '. Credentials are AES-256-GCM encrypted at rest and never returned by any tool. ' +
      'SECURITY: the secret you pass travels through the MCP client, only use this from a ' +
      'trusted client. Omit a field to keep its stored value on an edit; leave webhook secrets ' +
      'blank to auto-configure them later in the panel where the provider supports it. ' +
      '"external" is an inbound-only provider for your own billing system: it takes only ' +
      'webhookSecret, the HMAC key that system signs events with (see docs/external-billing.md).',
    write: true,
    admin: true,
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1 },
        provider: { type: 'string', enum: registryNames },
        // Stripe
        apiKey: { type: 'string', description: 'Stripe secret key (sk_…).' },
        // PayPal
        clientId: { type: 'string' },
        clientSecret: { type: 'string' },
        // Razorpay
        keyId: { type: 'string' },
        keySecret: { type: 'string' },
        // Shared webhook secret/id (provider-specific meaning; the only field
        // the external provider takes)
        webhookSecret: { type: 'string' },
        webhookId: { type: 'string' },
        mode: { type: 'string', enum: ['test', 'live'] },
        countries: { type: 'array', items: { type: 'string' } },
        currencies: {
          type: 'array',
          items: { type: 'string' },
          description:
            'ISO 4217 currencies this provider account can charge (Razorpay without international payments: ["INR"]). Empty means none: the provider is not used for any checkout. Left out on a new provider, it starts with the currencies that provider usually charges; left out on an existing one, the list stays as it is. A price in another currency is never routed to it.',
        },
        enabled: { type: 'boolean' },
      },
      required: ['applicationId', 'provider'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const app = await loadAppInTenant(ctx, String(args.applicationId));
      const provider = String(args.provider) as BillingProviderName;
      const module = getModule(provider);
      if (!module) {
        throw new RekeyError({
          statusCode: 400,
          code: 'BILLING_PROVIDER_UNKNOWN',
          message: `"${provider}" is not a registered billing provider.`,
          fix: `Use one of: ${registryNames.join(', ')}.`,
        });
      }
      const mode = args.mode === 'test' || args.mode === 'live' ? (args.mode as BillingMode) : undefined;
      const options = {
        ...(args.countries !== undefined && { countries: args.countries as string[] }),
        ...(args.currencies !== undefined && { currencies: currencyCodes(args.currencies) }),
        ...(args.enabled !== undefined && { enabled: args.enabled === true }),
        ...(mode !== undefined && { mode }),
        operatorId: ctx.tenantUserId,
      };
      // The field set is whatever the module declares, so a fourth provider is
      // not a fourth branch. A field the caller omits is omitted from the
      // request, and the credentials service keeps its stored value; a field
      // passed as "" is cleared, which is what a blank optional webhook field
      // has always meant. The old per-provider branches sent "" for every
      // omitted key, so an edit through MCP wiped the fields it did not name.
      const data: Record<string, string> = {};
      for (const field of module.credentialSchema) {
        const value = args[field.key];
        if (value !== undefined) data[field.key] = String(value);
      }
      const before = await webhookStateBeforeEdit(app.id, provider);
      await billingCredentialsService.upsertCredentials(app.id, provider, data, options);
      const webhook = await refreshWebhookAfterEdit(app.id, provider, app.slug, before, data);
      // Audit records only that creds were set, NEVER the secret values.
      audit(ctx, 'app.billing_credentials_configured', app.id, { provider, mode: mode ?? 'inferred', webhook });
      return { applicationId: app.id, provider, configured: true, webhook };
    },
  },
  {
    name: 'cancel_subscription',
    description:
      'Cancel a specific subscription by id. By default cancels at period end for an active ' +
      'provider-backed subscription (so the customer keeps access until then); pass ' +
      '`atPeriodEnd: false` to cancel immediately. Irreversible, the subscription cannot be ' +
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
      // BEFORE acting, a subscription id from another workspace is treated as
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
        operatorId: ctx.tenantUserId,
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
