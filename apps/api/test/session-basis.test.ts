/**
 * A session is written only while the account row is still the one its
 * credential was checked against. These tests put a revocation of every
 * session at the exact point between the check and the write, one path at a
 * time, where the race test (claim-session-race.test.ts) relies on timing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import bcrypt from 'bcryptjs';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { RekeyError } from '../src/lib/error.js';
import { sessionBasis } from '../src/lib/session-basis.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { mfaService } from '../src/modules/mfa/mfa.service.js';
import { mcpOAuthService, OAuthError } from '../src/modules/mcp/oauth.service.js';
import { operatorMcpOAuthService } from '../src/modules/tenant-mcp/oauth.service.js';
import { tenantAuthService } from '../src/modules/tenant-auth/tenant-auth.service.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

const EMAIL = 'holder@example.com';
const PASSWORD = 'first-pw-one-two-three';

describe('A session is refused when the account moved on after its credential was checked', () => {
  operatorsConfirmTheirEmail();
  let app: FastifyInstance;
  let applicationId: string;
  let secretKey: string;
  let publishableKey: string;
  let operatorId: string;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    const slug = `basis-${Math.random().toString(36).slice(2, 8)}`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: slug },
    });
    const data = signUp.json().data as { accessToken: string; user: { id: string }; activeTenantId: string };
    operatorId = data.user.id;
    tenantId = data.activeTenantId;
    const operator = { authorization: `Bearer ${data.accessToken}` };
    applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: operator,
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: operator,
      payload: { methods: ['password', 'magic_link'], appUrl: 'https://app.example.com' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
  });

  const sk = (): Record<string, string> => ({ authorization: `Bearer ${secretKey}` });
  const pk = (): Record<string, string> => ({ authorization: `Bearer ${publishableKey}` });
  const post = (url: string, payload: unknown, headers: Record<string, string>): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'POST', url: `/api/v1/auth${url}`, headers, payload: payload as never });

  async function signUp(): Promise<{ id: string; accessToken: string }> {
    const res = await post('/sign-up', { email: EMAIL, password: PASSWORD }, pk());
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { id: data.endUser.id, accessToken: data.accessToken };
  }

  async function magicLink(): Promise<string> {
    const res = await post('/magic-link/request', { email: EMAIL }, sk());
    return (res.json().data as { magicLinkToken: string }).magicLinkToken;
  }

  /** Run `between` once, at the point after a first factor verified and before its session is written. */
  function afterTheCredentialCheck(between: () => Promise<unknown>): void {
    const isEnrolled = mfaService.isEnrolled.bind(mfaService);
    let done = false;
    vi.spyOn(mfaService, 'isEnrolled').mockImplementation(async (id) => {
      if (!done) {
        done = true;
        await between();
      }
      return isEnrolled(id);
    });
  }

  it('a password sign-in that verified just before a claim answers 401 INVALID_CREDENTIALS and writes no session', async () => {
    const { id } = await signUp();
    const token = await magicLink();
    let owner: LightMyRequestResponse | undefined;
    afterTheCredentialCheck(async () => {
      owner = await post('/magic-link/verify', { token }, pk());
    });
    const res = await post('/sign-in', { email: EMAIL, password: PASSWORD }, pk());
    expect(owner?.statusCode, owner?.body).toBe(200);
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(await prisma.refreshToken.count({ where: { endUserId: id, revokedAt: null } })).toBe(1);
  });

  it('a bcrypt upgrade that verified before a claim does not put the removed password back', async () => {
    const { id } = await signUp();
    await prisma.endUser.update({ where: { id }, data: { passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    const token = await magicLink();
    const upgrade = authService.upgradeVerifiedHash.bind(authService);
    vi.spyOn(authService, 'upgradeVerifiedHash').mockImplementation(async (user, password) => {
      const owner = await post('/magic-link/verify', { token }, pk());
      expect(owner.statusCode, owner.body).toBe(200);
      return upgrade(user, password);
    });
    const res = await post('/sign-in', { email: EMAIL, password: PASSWORD }, pk());
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    const row = await prisma.endUser.findUniqueOrThrow({ where: { id }, select: { passwordHash: true } });
    expect(row.passwordHash, 'the claim removed the password and the upgrade must not restore it').toBeNull();
    vi.restoreAllMocks();
    expect((await post('/sign-in', { email: EMAIL, password: PASSWORD }, pk())).statusCode).toBe(401);
  });

  it('a bcrypt upgrade that loses to another upgrade of the same password still signs in', async () => {
    const { id } = await signUp();
    await prisma.endUser.update({ where: { id }, data: { passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    const upgrade = authService.upgradeVerifiedHash.bind(authService);
    vi.spyOn(authService, 'upgradeVerifiedHash').mockImplementation(async (user, password) => {
      await upgrade(user, password);
      return upgrade(user, password);
    });
    const res = await post('/sign-in', { email: EMAIL, password: PASSWORD }, pk());
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a sign-in link verified just before sign-out everywhere answers 401 CREDENTIAL_SUPERSEDED, and its fix works', async () => {
    const { id } = await signUp();
    await prisma.endUser.update({ where: { id }, data: { emailVerified: true } });
    const token = await magicLink();
    afterTheCredentialCheck(() => authService.signOutEverywhere(id));
    const res = await post('/magic-link/verify', { token }, pk());
    expect(res.statusCode, res.body).toBe(401);
    expect(res.json().error.code).toBe('CREDENTIAL_SUPERSEDED');
    expect(await prisma.refreshToken.count({ where: { endUserId: id, revokedAt: null } })).toBe(0);

    // The fix, followed literally: the link is spent, a new one signs in.
    expect((await post('/magic-link/verify', { token }, pk())).statusCode).toBe(401);
    const again = await post('/magic-link/verify', { token: await magicLink() }, pk());
    expect(again.statusCode, again.body).toBe(200);
  });

  it('a session cannot mint another one after every session was ended: 401 USER_TOKEN_INVALID', async () => {
    const { id } = await signUp();
    const admitted = await prisma.endUser.findUniqueOrThrow({ where: { id }, select: { sessionsInvalidBefore: true } });
    await authService.signOutEverywhere(id);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const mint = authService.switchActiveOrganization({
      application,
      endUserId: id,
      activeOrganizationId: null,
      impersonation: undefined,
      sessionStamp: admitted.sessionsInvalidBefore,
    });
    await expect(mint).rejects.toMatchObject({ code: 'USER_TOKEN_INVALID', statusCode: 401 });
    expect(await prisma.refreshToken.count({ where: { endUserId: id, revokedAt: null } })).toBe(0);
    // "Sign in again."
    expect((await post('/sign-in', { email: EMAIL, password: PASSWORD }, pk())).statusCode).toBe(200);
  });

  it('an end-user MCP code exchange is refused when the stamp moved after the code was read', async () => {
    const { id } = await signUp();
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const user = await prisma.endUser.findUniqueOrThrow({ where: { id } });
    await authService.signOutEverywhere(id);
    await expect(
      mcpOAuthService.issueTokens(application, user, 'mcp:account', 'client-1', null),
    ).rejects.toBeInstanceOf(OAuthError);
    expect(await prisma.refreshToken.count({ where: { endUserId: id, kind: 'mcp' } })).toBe(0);
    const current = await prisma.endUser.findUniqueOrThrow({ where: { id } });
    await expect(mcpOAuthService.issueTokens(application, current, 'mcp:account', 'client-1', null)).resolves.toBeTruthy();
  });

  it('an operator cannot switch workspace, and an operator MCP code cannot be exchanged, after every session was ended', async () => {
    const admitted = await prisma.tenantUser.findUniqueOrThrow({ where: { id: operatorId } });
    await tenantAuthService.signOutEverywhere(operatorId);
    await expect(
      tenantAuthService.switchWorkspace({
        tenantUserId: operatorId,
        targetTenantId: tenantId,
        sessionStamp: admitted.sessionsInvalidBefore,
      }),
    ).rejects.toMatchObject({ code: 'TENANT_SESSION_INVALID', statusCode: 401 });
    const grant = {
      tenantUserId: operatorId,
      tenantId,
      clientId: 'client-1',
      scope: 'mcp:operator',
    };
    const stale = sessionBasis(admitted, () => new RekeyError({ statusCode: 400, code: 'STALE', message: 'stale', fix: 'none' }));
    await expect(operatorMcpOAuthService.issueTokens({ ...grant, grant: { basis: stale } })).rejects.toMatchObject({
      code: 'STALE',
    });
    expect(await prisma.tenantRefreshToken.count({ where: { tenantUserId: operatorId, revokedAt: null } })).toBe(0);
    expect(await prisma.tenantMcpRefreshToken.count({ where: { tenantUserId: operatorId } })).toBe(0);
  });
});
