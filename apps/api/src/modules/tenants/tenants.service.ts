/**
 * Tenant service.
 *
 * A Tenant is the *outer* entity in ReliPay's two-level model:
 *   Tenant → Application → EndUser.
 *
 * One Tenant typically owns multiple Applications (e.g. a company with
 * staging/prod or a holding company with several SaaS products).
 *
 * Tenants are created via the bootstrap admin surface only. There is no
 * self-serve tenant signup in v1 — that ships with relipay.cloud.
 */

import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import type { Tenant } from '@prisma/client';

export interface CreateTenantInput {
  name: string;
  ownerEmail: string;
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
      throw new RelipayError({
        statusCode: 404,
        code: 'TENANT_NOT_FOUND',
        message: `Tenant "${id}" not found.`,
        fix: 'List tenants with GET /api/v1/admin/tenants to see valid ids.',
      });
    }
    return tenant;
  },

  async create(input: CreateTenantInput): Promise<Tenant> {
    return prisma.tenant.create({ data: input });
  },
};
