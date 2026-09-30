/**
 * An API key may only be minted with scopes the API enforces. An unknown
 * string used to be stored and returned 201, so a typo became a permission
 * that silently never matched. Every mint path is covered: the super-admin
 * route, the tenant route, the operator PAT route and the MCP `mint_api_key`
 * tool. Keys already stored are untouched; this is a create-time check only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ELEVATED_API_KEY_SCOPES, STANDARD_API_KEY_SCOPES } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorWriteTools } from '../src/modules/tenant-mcp/operator-write-tools.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const EVERY_SCOPE = ['*', ...STANDARD_API_KEY_SCOPES, ...ELEVATED_API_KEY_SCOPES];

describe('API key scope validation at mint', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.99.0.1';
  const inject = (opts: Record<string, unknown>) => app.inject({ remoteAddress: ip, ...opts } as never);
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function world(): Promise<{ ownerToken: string; appId: string; tenantId: string; userId: string; membershipId: string }> {
    ip = `10.99.${++n}.1`;
    const tag = `aksv-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Scope Co' },
    });
    expect(su.statusCode, su.body).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;
    const created = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(ownerToken),
      payload: { name: tag, slug: tag },
    });
    const appId = (created.json().data as { id: string }).id;
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const membership = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantId: application.tenantId, role: 'OWNER' },
    });
    return {
      ownerToken,
      appId,
      tenantId: application.tenantId,
      userId: membership.tenantUserId,
      membershipId: membership.id,
    };
  }

  function expectUnknownScope(res: { statusCode: number; json: () => { error: { code: string; message: string; fix: string } } }, bad: string): void {
    expect(res.statusCode).toBe(400);
    const error = res.json().error;
    expect(error.code).toBe('API_KEY_SCOPE_UNKNOWN');
    expect(error.message).toContain(bad);
    for (const scope of EVERY_SCOPE) expect(error.fix).toContain(scope);
  }

  it('the tenant route refuses an unknown scope and mints nothing', async () => {
    const w = await world();
    const res = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/api-keys`,
      headers: auth(w.ownerToken),
      payload: { name: 'typo', scopes: ['auth:read', 'not:a:real:scope'] },
    });
    expectUnknownScope(res, 'not:a:real:scope');
    expect(await prisma.apiKey.count({ where: { applicationId: w.appId } })).toBe(0);
  });

  it('the tenant route still accepts every documented scope, and the default', async () => {
    const w = await world();
    const every = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/api-keys`,
      headers: auth(w.ownerToken),
      payload: { name: 'every', scopes: EVERY_SCOPE },
    });
    expect(every.statusCode, every.body).toBe(201);
    const byDefault = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/api-keys`,
      headers: auth(w.ownerToken),
      payload: { name: 'default' },
    });
    expect(byDefault.statusCode, byDefault.body).toBe(201);
    expect((byDefault.json().data as { apiKey: { scopes: string[] } }).apiKey.scopes).toEqual(['*']);
  });

  it('the super-admin route refuses an unknown scope', async () => {
    const w = await world();
    const res = await inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${w.appId}/api-keys`,
      headers: auth(ADMIN_KEY),
      payload: { name: 'typo', scopes: ['billing:reed'] },
    });
    expectUnknownScope(res, 'billing:reed');
    expect(await prisma.apiKey.count({ where: { applicationId: w.appId } })).toBe(0);
  });

  it('the operator PAT route refuses an unknown scope', async () => {
    const w = await world();
    const pat = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: auth(w.ownerToken),
      payload: { name: 'pat', scopes: ['keys:mint'] },
    }).then((r) => (r.json().data as { rawToken: string }).rawToken);
    const res = await inject({
      method: 'POST',
      url: `/api/v1/tenant/operator/applications/${w.appId}/api-keys`,
      headers: auth(pat),
      payload: { name: 'typo', scopes: ['auth:*'] },
    });
    expectUnknownScope(res, 'auth:*');
    expect(await prisma.apiKey.count({ where: { applicationId: w.appId } })).toBe(0);
  });

  it('the MCP mint_api_key tool refuses an unknown scope', async () => {
    const w = await world();
    const tool = operatorWriteTools.find((t) => t.name === 'mint_api_key')!;
    await expect(
      tool.handler(
        {
          tenantUserId: w.userId,
          tenantId: w.tenantId,
          role: 'OWNER',
          tenantMembershipId: w.membershipId,
          scopes: UNRESTRICTED,
          canWrite: true,
          canAdmin: true,
        },
        { applicationId: w.appId, name: 'typo', scopes: ['credits:grants'] },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'API_KEY_SCOPE_UNKNOWN' });
    expect(await prisma.apiKey.count({ where: { applicationId: w.appId } })).toBe(0);
  });
});
