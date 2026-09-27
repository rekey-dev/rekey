/**
 * Operator MCP tools for organization MEMBERSHIP: find an organization, add an
 * end-user to it, and set their role from the Application's catalog.
 *
 * The catalog tools (`*_organization_role`) live in `operator-write-tools.ts`;
 * these assign from it. Both reuse the operator REST routes' services, so the
 * rules are the panel's: operator authority skips the organization's own role
 * hierarchy but never the catalog, and a role that is unknown or disabled is
 * refused. The service records the security event, so every surface audits.
 *
 * Authorization is the same as every other operator write tool: the dispatcher
 * demands write capability and role >= ADMIN, `organizations:write` narrows a
 * restricted MEMBER, and each handler re-scopes through `loadAppInTenant` so an
 * Application in another workspace reads as not found.
 */

import { z } from 'zod';
import { RekeyError } from '../../lib/error.js';
import {
  organizationsService,
  type OperatorMembershipActor,
} from '../organizations/organizations.service.js';
import type { OperatorTool, OperatorToolContext } from './operator-tools.js';
import { assertOrganizationsEnabled, loadAppInTenant } from './operator-write-tools.js';

const LIST_ORGANIZATIONS_MAX = 100;
const ROLE_NAME_MAX = 40;
const ID_MAX = 200;
const QUERY_MAX = 100;

/**
 * The services' `fix` strings point at REST routes and the panel, which an
 * agent holding only this MCP connection cannot call. Swap them for the tool
 * that repairs the problem, keeping the code and message the REST twin sends.
 */
const MCP_FIX: Readonly<Record<string, string>> = {
  ORGANIZATION_NOT_FOUND: 'Call list_organizations with this applicationId to see the organization ids.',
  END_USER_NOT_FOUND: 'Call get_end_user with this applicationId and the email address to find the id.',
  ORGANIZATION_ROLE_UNKNOWN:
    'Call list_organization_roles to see the assignable names, or create_organization_role to define this one.',
  ORGANIZATION_ROLE_DISABLED:
    'Call list_organization_roles and pick a role that is not disabled. Re-enabling a role is done in the panel.',
  ORGANIZATION_ALREADY_MEMBER: 'Call set_organization_member_role to change the role of the existing membership.',
  ORGANIZATION_MEMBER_NOT_FOUND: 'Call add_organization_member to add them with a role instead.',
};

async function withMcpFix<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const fix = e instanceof RekeyError ? MCP_FIX[e.code] : undefined;
    if (!(e instanceof RekeyError) || fix === undefined) throw e;
    throw new RekeyError({ statusCode: e.statusCode, code: e.code, message: e.message, fix, cause: e });
  }
}

/**
 * Parse tool arguments against the same bounds the JSON Schema advertises.
 * Without it `String(args.x)` turned a missing argument into the id
 * "undefined" and let an over-long role name reach the service.
 */
function parseArgs<T extends z.ZodTypeAny>(schema: T, tool: string, args: Record<string, unknown>): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`)
    .join('; ');
  throw new RekeyError({
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: `Invalid arguments for ${tool}: ${issues}.`,
    fix: `Check the arguments against ${tool}'s inputSchema in tools/list.`,
  });
}

function actorFrom(ctx: OperatorToolContext): OperatorMembershipActor {
  return {
    tenantUserId: ctx.tenantUserId,
    tenantId: ctx.tenantId,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
    via: 'operator_mcp',
  };
}

const id = z.string().min(1).max(ID_MAX);
const roleName = z.string().min(1).max(ROLE_NAME_MAX);

const ListArgs = z
  .object({
    applicationId: id,
    query: z.string().max(QUERY_MAX).optional(),
    limit: z.number().int().min(1).max(LIST_ORGANIZATIONS_MAX).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

const AddArgs = z
  .object({ applicationId: id, organizationId: id, endUserId: id, role: roleName.optional() })
  .strict();

const SetRoleArgs = z
  .object({ applicationId: id, organizationId: id, endUserId: id, role: roleName })
  .strict();

const ID_ARG = { type: 'string', minLength: 1, maxLength: ID_MAX } as const;

const ROLE_ARG = {
  type: 'string',
  minLength: 1,
  maxLength: ROLE_NAME_MAX,
  description:
    'A role NAME from list_organization_roles, e.g. "OWNER" or a custom "content-manager". ' +
    'Case-sensitive. A disabled role is refused.',
} as const;

export const operatorOrganizationTools: OperatorTool[] = [
  {
    name: 'list_organizations',
    description:
      'List the organizations in an application, newest first, with member and pending-' +
      'invitation counts. `query` narrows to a case-insensitive match on name or slug. Pages ' +
      `with \`limit\` (default and maximum ${LIST_ORGANIZATIONS_MAX}) and \`offset\`; \`total\` ` +
      'counts every match and `hasMore` says whether another page exists. Use an `id` here as ' +
      '`organizationId` for add_organization_member and set_organization_member_role. ' +
      'Readable even when organizations are disabled.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: ID_ARG,
        query: { type: 'string', maxLength: QUERY_MAX, description: 'Substring of the name or slug.' },
        limit: { type: 'integer', minimum: 1, maximum: LIST_ORGANIZATIONS_MAX },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const args = parseArgs(ListArgs, 'list_organizations', raw);
      const app = await loadAppInTenant(ctx, args.applicationId);
      const take = args.limit ?? LIST_ORGANIZATIONS_MAX;
      const skip = args.offset ?? 0;
      const [organizations, total] = await Promise.all([
        organizationsService.adminList({ applicationId: app.id, take, skip, query: args.query }),
        organizationsService.adminCount({ applicationId: app.id, query: args.query }),
      ]);
      return {
        applicationId: app.id,
        total,
        limit: take,
        offset: skip,
        hasMore: skip + organizations.length < total,
        organizations: organizations.map((o) => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
          memberCount: o.memberCount,
          pendingInvitationCount: o.pendingInvitationCount,
          createdAt: o.createdAt.toISOString(),
        })),
      };
    },
  },
  {
    name: 'add_organization_member',
    description:
      'Add an existing end-user of the application to one of its organizations with an ' +
      "ORGANIZATION role from the catalog. Omit `role` to use the catalog's default role. " +
      "This is operator authority: the organization's own hierarchy (only an OWNER may make " +
      'an OWNER) does not apply, but the role must exist in list_organization_roles and not ' +
      'be disabled. Refused if the end-user is already a member; use ' +
      'set_organization_member_role for that. Requires organizations to be enabled.',
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { applicationId: ID_ARG, organizationId: ID_ARG, endUserId: ID_ARG, role: ROLE_ARG },
      required: ['applicationId', 'organizationId', 'endUserId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const args = parseArgs(AddArgs, 'add_organization_member', raw);
      const app = await loadAppInTenant(ctx, args.applicationId);
      assertOrganizationsEnabled(app);
      const membership = await withMcpFix(() =>
        organizationsService.adminAddMember({
          applicationId: app.id,
          organizationId: args.organizationId,
          endUserId: args.endUserId,
          ...(args.role !== undefined && { role: args.role }),
          actor: actorFrom(ctx),
        }),
      );
      return { ...membership, createdAt: membership.createdAt.toISOString() };
    },
  },
  {
    name: 'set_organization_member_role',
    description:
      "Change an organization member's ORGANIZATION role to another name from the catalog " +
      '(list_organization_roles). The end-user must already be a member; use ' +
      'add_organization_member otherwise. This is operator authority, so there is no ' +
      "last-owner guard: demoting an organization's only OWNER-tier member leaves it without " +
      'an owner until you assign one. Requires organizations to be enabled.',
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { applicationId: ID_ARG, organizationId: ID_ARG, endUserId: ID_ARG, role: ROLE_ARG },
      required: ['applicationId', 'organizationId', 'endUserId', 'role'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const args = parseArgs(SetRoleArgs, 'set_organization_member_role', raw);
      const app = await loadAppInTenant(ctx, args.applicationId);
      assertOrganizationsEnabled(app);
      const membership = await withMcpFix(() =>
        organizationsService.adminSetMemberRole({
          applicationId: app.id,
          organizationId: args.organizationId,
          endUserId: args.endUserId,
          role: args.role,
          actor: actorFrom(ctx),
        }),
      );
      return { ...membership, createdAt: membership.createdAt.toISOString() };
    },
  },
];
