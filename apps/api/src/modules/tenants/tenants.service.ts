/**
 * Tenant service.
 *
 * A Tenant is the *outer* entity in Rekey's two-level model:
 *   Tenant → Application → EndUser.
 *
 * One Tenant typically owns multiple Applications (e.g. a company with
 * staging/prod or a holding company with several SaaS products).
 *
 * This is the bootstrap super-admin surface, but it is no longer the only
 * creation path. There are four `tenant.create` sites: here, operator password
 * sign-up and operator OAuth first-login (both `tenant-auth.service.ts`, gated by
 * `OPERATOR_SIGNUP_MODE`), and workspace-create
 * (`tenant-workspaces.service.ts`, gated by `WORKSPACE_CREATION`). Anything that
 * must hold for every workspace has to be enforced in all four, not just here.
 *
 * That is what `resolveNewTenantLimits` (lib/tenant-limits.ts) is for: it
 * resolves the deployment's `DEFAULT_TENANT_LIMITS` against any explicitly
 * passed limits and returns the `limits` fragment to spread into the create.
 * All four sites spread it. If you add a fifth `tenant.create`, spread it there
 * too — a workspace created without it starts unlimited, which is precisely the
 * hole the variable exists to close.
 */

import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import {
  countActiveEndUsers,
  countProductionApps,
  parseTenantLimits,
  resolveNewTenantLimits,
} from '../../lib/tenant-limits.js';
import type { Prisma, Tenant } from '@prisma/client';
import type { TenantLimits } from '@rekey.dev/shared-types';

export interface CreateTenantInput {
  name: string;
  ownerEmail: string;
  /**
   * Ceilings for this specific workspace, overriding `DEFAULT_TENANT_LIMITS`.
   * Omitted means "whatever this deployment defaults to"; `{}` means "unlimited,
   * deliberately". This is the bespoke-provisioning path, so an explicit value
   * always wins over the deployment default.
   */
  limits?: TenantLimits | undefined;
}

/** What the limits endpoints return — the ceilings plus what's used against them. */
export interface TenantLimitsView {
  limits: TenantLimits;
  usage: {
    /** Non-erased end-users across every Application in this workspace. */
    activeEndUsers: number;
    /** Applications in this workspace whose environment is PRODUCTION. */
    productionApps: number;
  };
}

export const tenantsService = {
  async list(opts?: { take?: number; skip?: number }): Promise<Tenant[]> {
    return prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  async get(id: string): Promise<Tenant> {
    const tenant = await prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new RekeyError({
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
        message: `Tenant "${id}" not found.`,
        fix: 'List tenants with GET /api/v1/admin/tenants to see valid ids.',
      });
    }
    return tenant;
  },

  async create(input: CreateTenantInput): Promise<Tenant> {
    const { limits, ...rest } = input;
    return prisma.tenant.create({
      data: { ...rest, ...resolveNewTenantLimits(limits) },
    });
  },

  /**
   * Read a workspace's ceilings plus current usage. Absent keys mean
   * unlimited — see lib/tenant-limits.ts.
   */
  async getLimits(id: string): Promise<TenantLimitsView> {
    const tenant = await this.get(id);
    return {
      limits: parseTenantLimits(tenant.limits),
      usage: {
        activeEndUsers: await countActiveEndUsers(id),
        productionApps: await countProductionApps(id),
      },
    };
  },

  /**
   * Replace a workspace's ceilings wholesale (PUT semantics — a key you omit
   * becomes unlimited, it does not keep its previous value).
   *
   * Setting a limit BELOW current usage is allowed on purpose: a workspace has
   * to be able to shrink, and the ceiling only ever blocks *new* end-users, so
   * doing this strands nobody. It just means no new sign-ups until the count
   * comes back under the line.
   */
  async setLimits(id: string, limits: TenantLimits): Promise<TenantLimitsView> {
    await this.get(id);
    await prisma.tenant.update({
      where: { id },
      data: { limits: limits as Prisma.InputJsonValue },
    });
    return this.getLimits(id);
  },
};
