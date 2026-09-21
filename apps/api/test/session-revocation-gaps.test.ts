/**
 * Two gaps from the final security review of the session work.
 *
 *   1. An impersonation token could mint a real session. The org switch routes
 *      re-mint a token pair and did not refuse impersonation, so a 5-minute,
 *      revocable, attributed token became a 30-day refresh chain as the
 *      end-user that survived ending the impersonation. Both routes refuse
 *      now, and `issuePair` refuses on its own as a backstop. Each assertion
 *      pins its own message, so removing either guard fails a test here even
 *      though the other would still answer 403.
 *
 *   2. Revoke-all never reached MCP OAuth. An operator's password reset or
 *      sign-out everywhere left their MCP refresh tokens live and their MCP
 *      access tokens accepted. The end-user MCP endpoint had the same hole for
 *      the access token's one-hour life.
 *
 * `iat` and the stamp compare at second granularity (lib/session-stamp.ts), so
 * a token minted in the same second as a revocation survives it by design.
 * Every stamp test waits past the second before revoking.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { operatorMcpOAuthService } from '../src/modules/tenant-mcp/oauth.service.js';

const PASSWORD = 'pw-one-two-three';
const OP_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const EU_REDIRECT = 'http://localhost:9876/cb';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function pastTheSecond(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1100));
}

describe('session revocation gaps', () => {
  let app: FastifyInstance;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const tag = (label: string) => `${label}-${++n}-${Math.random().toString(36).slice(2, 7)}`;

  interface Operator {
    id: string;
    email: string;
    accessToken: string;
    tenantId: string;
  }

  async function makeOperator(label: string): Promise<Operator> {
    const email = `op-${tag(label)}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName: 'WS' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const d = res.json().data as { accessToken: string; activeTenantId: string; user: { id: string } };
    return { id: d.user.id, email, accessToken: d.accessToken, tenantId: d.activeTenantId };
  }

  // ---------------------------------------------------------------------------
  // 1. Impersonation cannot mint a session
  // ---------------------------------------------------------------------------

  describe('impersonation', () => {
    interface Fixture {
      op: Operator;
      application: { id: string; slug: string };
      liveKey: string;
      endUserId: string;
      endUserToken: string;
    }

    async function bootstrap(label: string): Promise<Fixture> {
      const op = await makeOperator(label);
      const slug = tag(label);
      const application = await app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/applications/',
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { name: `App ${slug}`, slug },
        })
        .then((r) => r.json().data as { id: string; slug: string });
      const liveKey = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${application.id}/api-keys`,
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { name: 'k', mode: 'live' },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
      const row = await prisma.application.findUniqueOrThrow({ where: { id: application.id } });
      await prisma.application.update({
        where: { id: application.id },
        data: {
          authConfig: { ...(row.authConfig as object), organizationsEnabled: true } as never,
        },
      });
      const eu = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/sign-up',
          headers: { authorization: `Bearer ${liveKey}` },
          payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
        })
        .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
      return { op, application, liveKey, endUserId: eu.endUser.id, endUserToken: eu.accessToken };
    }

    async function impersonate(f: Fixture): Promise<{ token: string; impersonationId: string }> {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${f.application.id}/end-users/${f.endUserId}/impersonate`,
        headers: { authorization: `Bearer ${f.op.accessToken}` },
        payload: { reason: 'support' },
      });
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json().data as { accessToken: string; impersonationId: string };
      return { token: d.accessToken, impersonationId: d.impersonationId };
    }

    function asUser(f: Fixture, token: string, method: 'POST' | 'DELETE', url: string, payload?: unknown) {
      return app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
        ...(payload !== undefined ? { payload } : {}),
      } as never);
    }

    const refreshRows = (endUserId: string) => prisma.refreshToken.count({ where: { endUserId } });

    it('clear-active-organization refuses an impersonation token and mints nothing', async () => {
      const f = await bootstrap('imp-clear');
      const { token } = await impersonate(f);
      const before = await refreshRows(f.endUserId);

      const res = await asUser(f, token, 'POST', '/api/v1/users/me/organizations/clear-active-organization');
      // Was 200 with a refreshToken that outlived the impersonation.
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('IMPERSONATION_ACTION_FORBIDDEN');
      expect(res.json().error.message).toContain('switch the active organization');
      expect(res.body).not.toContain('refreshToken');
      expect(await refreshRows(f.endUserId)).toBe(before);
    });

    it('switch refuses an impersonation token for an org the user really belongs to', async () => {
      const f = await bootstrap('imp-switch');
      const created = await asUser(f, f.endUserToken, 'POST', '/api/v1/users/me/organizations/', {
        name: 'Team',
        slug: tag('team'),
      });
      expect(created.statusCode, created.body).toBe(201);
      const orgId = (created.json().data as { organization: { id: string } }).organization.id;

      const { token } = await impersonate(f);
      const before = await refreshRows(f.endUserId);
      const res = await asUser(f, token, 'POST', `/api/v1/users/me/organizations/${orgId}/switch`);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('IMPERSONATION_ACTION_FORBIDDEN');
      expect(res.json().error.message).toContain('switch the active organization');
      expect(await refreshRows(f.endUserId)).toBe(before);

      // The user's own session still switches: the guard is about who is acting.
      const own = await asUser(f, f.endUserToken, 'POST', `/api/v1/users/me/organizations/${orgId}/switch`);
      expect(own.statusCode, own.body).toBe(200);
      expect((own.json().data as { refreshToken: string }).refreshToken).toBeTruthy();
    });

    it('issuePair refuses an impersonated origin on its own, whatever route asked', async () => {
      // Straight at the service, with no route guard in front: the shape a
      // future route that forgets `refuseWhileImpersonating` would have.
      const f = await bootstrap('imp-backstop');
      const { impersonationId } = await impersonate(f);
      const application = await prisma.application.findUniqueOrThrow({ where: { id: f.application.id } });
      const before = await refreshRows(f.endUserId);

      await expect(
        authService.switchActiveOrganization({
          application,
          endUserId: f.endUserId,
          activeOrganizationId: null,
          impersonation: { auditId: impersonationId, operatorUserId: f.op.id },
        }),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'IMPERSONATION_ACTION_FORBIDDEN',
        message: expect.stringContaining('mint a new session'),
      });
      expect(await refreshRows(f.endUserId)).toBe(before);

      // Same call without impersonation mints, so the refusal is the guard.
      const ok = await authService.switchActiveOrganization({
        application,
        endUserId: f.endUserId,
        activeOrganizationId: null,
        impersonation: undefined,
      });
      expect(ok.refreshToken).toBeTruthy();
    });

    it('the reproduction: nothing survives ending the impersonation', async () => {
      const f = await bootstrap('imp-repro');
      const { token } = await impersonate(f);
      const minted = await asUser(f, token, 'POST', '/api/v1/users/me/organizations/clear-active-organization');
      expect(minted.statusCode).toBe(403);

      const ended = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${f.application.id}/end-users/${f.endUserId}/impersonate/end`,
        headers: { authorization: `Bearer ${f.op.accessToken}` },
      });
      expect(ended.statusCode).toBe(200);
      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/',
        headers: { authorization: `Bearer ${f.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(after.statusCode).toBe(401);
    });

    it('cannot link or unlink an OAuth provider', async () => {
      const f = await bootstrap('imp-link');
      const { token } = await impersonate(f);
      const link = await asUser(f, token, 'POST', '/api/v1/auth/oauth/google/link/complete', { code: 'x' });
      expect(link.statusCode, link.body).toBe(403);
      expect(link.json().error.code).toBe('IMPERSONATION_ACTION_FORBIDDEN');
      const unlink = await asUser(f, token, 'DELETE', '/api/v1/auth/oauth/google');
      expect(unlink.statusCode, unlink.body).toBe(403);
      expect(unlink.json().error.code).toBe('IMPERSONATION_ACTION_FORBIDDEN');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Revoke-all reaches operator MCP OAuth
  // ---------------------------------------------------------------------------

  describe('operator MCP OAuth', () => {
    interface Connection {
      clientId: string;
      accessToken: string;
      refreshToken: string;
    }

    async function connect(op: Operator): Promise<Connection> {
      const client = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/register',
        payload: { redirect_uris: [OP_REDIRECT], client_name: 'Claude' },
      });
      expect(client.statusCode, client.body).toBe(201);
      const clientId = (client.json() as { client_id: string }).client_id;
      const { verifier, challenge } = pkce();
      const grant = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/grant',
        headers: { authorization: `Bearer ${op.accessToken}` },
        payload: {
          client_id: clientId,
          redirect_uri: OP_REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:operator:read',
          tenant_id: op.tenantId,
          approve: true,
        },
      });
      expect(grant.statusCode, grant.body).toBe(200);
      const code = new URL((grant.json() as { data: { redirect: string } }).data.redirect).searchParams.get('code');
      const token = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/token',
        payload: {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: OP_REDIRECT,
          client_id: clientId,
        },
      });
      expect(token.statusCode, token.body).toBe(200);
      const t = token.json() as { access_token: string; refresh_token: string };
      return { clientId, accessToken: t.access_token, refreshToken: t.refresh_token };
    }

    const rpc = (accessToken: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });

    const refresh = (c: Connection) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/token',
        payload: { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId },
      });

    async function expectMcpEnded(c: Connection): Promise<void> {
      const refreshed = await refresh(c);
      expect(refreshed.statusCode, refreshed.body).toBe(400);
      expect(refreshed.json().error).toBe('invalid_grant');
      const call = await rpc(c.accessToken);
      expect(call.statusCode, call.body).toBe(401);
      expect(await operatorMcpOAuthService.introspect(c.accessToken)).toEqual({ active: false });
    }

    it('sign-out everywhere revokes the MCP refresh token and refuses the issued access token', async () => {
      const op = await makeOperator('mcp-soe');
      const c = await connect(op);
      expect((await rpc(c.accessToken)).statusCode).toBe(200);

      await pastTheSecond();
      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-out-everywhere',
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect(out.statusCode, out.body).toBe(200);
      await expectMcpEnded(c);
    });

    it('a password reset does the same', async () => {
      const op = await makeOperator('mcp-reset');
      const c = await connect(op);
      expect((await rpc(c.accessToken)).statusCode).toBe(200);

      await pastTheSecond();
      const forgot = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/forgot-password',
        payload: { email: op.email },
      });
      const { resetToken } = forgot.json().data as { resetToken: string };
      const reset = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/reset-password',
        payload: { token: resetToken, newPassword: 'brand-new-password' },
      });
      expect(reset.statusCode, reset.body).toBe(200);
      await expectMcpEnded(c);
    });

    it('a single-session revoke leaves MCP working', async () => {
      const op = await makeOperator('mcp-single');
      const c = await connect(op);

      // A second panel session, then revoke it from the first.
      const second = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email: op.email, password: PASSWORD },
      });
      expect(second.statusCode, second.body).toBe(200);
      const newest = await prisma.tenantRefreshToken.findFirstOrThrow({
        where: { tenantUserId: op.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });

      // Past the second, so a stamp written here would refuse the MCP token.
      await pastTheSecond();
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/auth/sessions/${newest.id}`,
        headers: { authorization: `Bearer ${op.accessToken}` },
      });
      expect(revoked.statusCode, revoked.body).toBe(200);

      expect((await rpc(c.accessToken)).statusCode).toBe(200);
      expect((await refresh(c)).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // 2b. End-user MCP access tokens honour the stamp
  // ---------------------------------------------------------------------------

  describe('end-user MCP', () => {
    it('an access token issued before sign-out everywhere is refused', async () => {
      const op = await makeOperator('eu-mcp');
      const slug = tag('eumcp');
      const appId = await app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/applications',
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { name: 'MCP App', slug },
        })
        .then((r) => (r.json().data as { id: string }).id);
      const row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      await prisma.application.update({
        where: { id: appId },
        data: { authConfig: { ...(row.authConfig as object), mcpEnabled: true } as never },
      });
      const liveKey = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/api-keys`,
          headers: { authorization: `Bearer ${op.accessToken}` },
          payload: { name: 'k', mode: 'live', scopes: ['*'] },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
      const signUp = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: PASSWORD },
      });
      expect(signUp.statusCode, signUp.body).toBe(201);
      const userToken = (signUp.json().data as { accessToken: string }).accessToken;

      const clientId = await app
        .inject({
          method: 'POST',
          url: `/api/v1/mcp/${slug}/oauth/register`,
          payload: { redirect_uris: [EU_REDIRECT], client_name: 'Agent' },
        })
        .then((r) => (r.json() as { client_id: string }).client_id);
      const { verifier, challenge } = pkce();
      const granted = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/authorize/grant`,
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userToken },
        payload: {
          client_id: clientId,
          redirect_uri: EU_REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:account',
        },
      });
      expect(granted.statusCode, granted.body).toBe(200);
      const tok = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/token`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          grant_type: 'authorization_code',
          code: (granted.json() as { code: string }).code,
          code_verifier: verifier,
          redirect_uri: EU_REDIRECT,
          client_id: clientId,
        }).toString(),
      });
      expect(tok.statusCode, tok.body).toBe(200);
      const mcpToken = (tok.json() as { access_token: string }).access_token;

      const call = () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/mcp/${slug}`,
          headers: { authorization: `Bearer ${mcpToken}` },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        });
      expect((await call()).statusCode).toBe(200);

      await pastTheSecond();
      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-out-everywhere',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': userToken },
      });
      expect(out.statusCode, out.body).toBe(200);

      // Was 200 for the rest of the token's hour.
      const after = await call();
      expect(after.statusCode, after.body).toBe(401);
      expect(after.json().error).toBe('invalid_token');
    });
  });
});
