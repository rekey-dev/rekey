import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma.js';
import { loadAppInTenant } from '../src/modules/tenant-mcp/operator-write-tools.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';

async function viewerMember(): Promise<{ ctx: OperatorToolContext; applicationId: string }> {
  const tag = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({ data: { name: `WS ${tag}`, ownerEmail: `owner-${tag}@example.com` } });
  const app = await prisma.application.create({
    data: { tenantId: tenant.id, name: 'App', slug: `grant-${tag}`, publicKey: `pk_${tag}`, authConfig: {}, billingConfig: {} },
  });
  const user = await prisma.tenantUser.create({ data: { email: `viewer-${tag}@example.com` } });
  const membership = await prisma.tenantMembership.create({
    data: { tenantUserId: user.id, tenantId: tenant.id, role: 'MEMBER' },
  });
  await prisma.applicationGrant.create({
    data: { tenantMembershipId: membership.id, applicationId: app.id, role: 'APP_VIEWER' },
  });
  return {
    applicationId: app.id,
    ctx: {
      tenantUserId: user.id,
      tenantId: tenant.id,
      role: 'MEMBER',
      tenantMembershipId: membership.id,
      canWrite: true,
      canAdmin: false,
      scopes: UNRESTRICTED,
    },
  };
}

describe('operator MCP application loader honours the grant level', () => {
  it('lets a viewer-grant member read but refuses a write', async () => {
    const { ctx, applicationId } = await viewerMember();

    await expect(loadAppInTenant(ctx, applicationId, 'read')).resolves.toMatchObject({ id: applicationId });
    await expect(loadAppInTenant(ctx, applicationId, 'write')).rejects.toMatchObject({
      statusCode: 403,
      code: 'APP_ACCESS_DENIED',
    });
    await expect(loadAppInTenant(ctx, applicationId, 'billing-write')).rejects.toMatchObject({ statusCode: 403 });
  });
});
