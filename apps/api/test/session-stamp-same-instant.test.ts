/**
 * Tokens minted in the same second as a claim.
 *
 * `iat` is whole seconds. A session token is also answered for by its refresh
 * family, which the claim revokes. A token that names no session (MCP access)
 * has only its issue time, so it carries milliseconds and is refused when
 * minted at or before the stamp. The clock is frozen so "the same second" is
 * not left to chance.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { RekeyError } from '../src/lib/error.js';
import { issueMagicLinkToken } from '../src/lib/magic-link.js';
import { boundStamp, sessionBasis } from '../src/lib/session-basis.js';
import { accessTokenEndedByStamp, unanchoredTokenEnded } from '../src/lib/session-stamp.js';
import { mcpOAuthService } from '../src/modules/mcp/oauth.service.js';
import { operatorMcpOAuthService } from '../src/modules/tenant-mcp/oauth.service.js';

// Ahead of the real clock, so a code generated after freezing is never older
// than one a test spent before it; 400 ms into its second.
const FROZEN = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000 + 400);
const PASSWORD = 'attacker-pw-one-two-three';
const stale = (): RekeyError => new RekeyError({ statusCode: 400, code: 'STALE', message: 'stale', fix: 'none' });

describe('Tokens minted in the same second as a claim', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const freeze = (): void => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN);
  };
  const tenant = (url: string, payload: unknown, accessToken?: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant${url}`,
      ...(accessToken && { headers: { authorization: `Bearer ${accessToken}` } }),
      payload: payload as never,
    });
  const operatorMe = (accessToken: string): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: { authorization: `Bearer ${accessToken}` } });

  it('the comparison itself: seconds and strict with a session id, milliseconds and inclusive without one', () => {
    const stamp = new Date('2026-10-13T09:00:00.400Z');
    const second = Math.floor(stamp.getTime() / 1000);
    expect(accessTokenEndedByStamp({ iat: second, sid: 's' }, stamp), 'the stamping request keeps its own session').toBe(false);
    expect(accessTokenEndedByStamp({ iat: second - 1, sid: 's' }, stamp)).toBe(true);
    expect(unanchoredTokenEnded({ iat_ms: stamp.getTime() }, stamp), 'minted at the stamp').toBe(true);
    expect(unanchoredTokenEnded({ iat_ms: stamp.getTime() - 300 }, stamp), 'same second, earlier').toBe(true);
    expect(unanchoredTokenEnded({ iat_ms: stamp.getTime() + 1 }, stamp), 'same second, later').toBe(false);
    expect(unanchoredTokenEnded({}, stamp), 'no milliseconds: not a token this API mints').toBe(true);
    expect(unanchoredTokenEnded({}, null), 'refused with no stamp too').toBe(true);
    expect(accessTokenEndedByStamp({ iat: second }, stamp), 'an access token with no session is refused through the second').toBe(true);
    expect(accessTokenEndedByStamp({ iat: second + 1 }, stamp)).toBe(false);
    expect(unanchoredTokenEnded({ iat_ms: 1 }, null)).toBe(false);
    expect(boundStamp(undefined), 'a challenge with no bound stamp is bound to nothing').toBeUndefined();
    expect(boundStamp(0)).toBeNull();
    expect(boundStamp(stamp.getTime())).toEqual(stamp);
  });

  it('an operator: the first registrant\'s panel and MCP tokens end with the claim, the prover\'s start after it', async () => {
    freeze();
    const email = `same-second-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const signUp = await tenant('/auth/sign-up', { email, password: PASSWORD, workspaceName: 'Staging' });
    expect(signUp.statusCode, signUp.body).toBe(201);
    const attacker = signUp.json().data as { accessToken: string; user: { id: string }; activeTenantId: string };
    const row = await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } });
    const grant = {
      tenantUserId: attacker.user.id,
      tenantId: attacker.activeTenantId,
      clientId: 'client-1',
      scope: 'mcp:operator',
    };
    const before = await operatorMcpOAuthService.issueTokens({ ...grant, grant: { basis: sessionBasis(row, stale) } });
    const beforeToken = String(before!.access_token);
    expect((await operatorMcpOAuthService.introspect(beforeToken)).active).toBe(true);
    expect((await operatorMe(attacker.accessToken)).statusCode).toBe(200);

    const link = await tenant('/auth/magic-link/request', { email });
    const verified = await tenant('/auth/magic-link/verify', { token: (link.json().data as { token: string }).token });
    expect(verified.statusCode, verified.body).toBe(200);
    const prover = verified.json().data as { accessToken: string };
    const claimed = await prisma.tenantUser.findUniqueOrThrow({ where: { id: attacker.user.id } });
    expect(claimed.sessionsInvalidBefore?.getTime(), 'the clock did not move').toBe(FROZEN.getTime());

    expect((await operatorMcpOAuthService.introspect(beforeToken)).active, 'an MCP token from before the claim').toBe(false);
    expect((await operatorMe(attacker.accessToken)).statusCode, 'a panel token from before the claim').toBe(401);
    expect((await operatorMe(prover.accessToken)).statusCode, 'the session of whoever proved the mailbox').toBe(200);

    vi.setSystemTime(new Date(FROZEN.getTime() + 1));
    const after = await operatorMcpOAuthService.issueTokens({ ...grant, grant: { basis: sessionBasis(claimed, stale) } });
    expect(
      (await operatorMcpOAuthService.introspect(String(after!.access_token))).active,
      'an MCP token minted a millisecond after the claim',
    ).toBe(true);
  });

  it('an end user: an MCP token minted in the claim\'s second ends with it, one minted after does not', async () => {
    const slug = `ss-${Math.random().toString(36).slice(2, 8)}`;
    const op = await tenant('/auth/sign-up', { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: slug });
    const operator = { authorization: `Bearer ${(op.json().data as { accessToken: string }).accessToken}` };
    const applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    const created = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const application = await prisma.application.update({
      where: { id: applicationId },
      data: {
        authConfig: {
          ...(created.authConfig as Record<string, unknown>),
          methods: ['password', 'magic_link'],
          appUrl: 'https://app.example.com',
        },
      },
    });
    const pk = { authorization: `Bearer ${application.publicKey}` };
    const auth = (url: string, payload: unknown): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'POST', url: `/api/v1/auth${url}`, headers: pk, payload: payload as never });
    const me = (accessToken: string): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { ...pk, 'x-rekey-user-token': accessToken } });

    freeze();
    const email = 'victim@example.com';
    const signUp = await auth('/sign-up', { email, password: PASSWORD });
    expect(signUp.statusCode, signUp.body).toBe(201);
    const attacker = signUp.json().data as { accessToken: string; endUser: { id: string } };
    const row = await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } });
    const before = await mcpOAuthService.issueTokens(application, row, 'openid email', 'client-1', null);
    const beforeToken = String(before.access_token);
    expect((await mcpOAuthService.userInfo(application, beforeToken)).ok).toBe(true);

    const link = await issueMagicLinkToken({ applicationId, endUserId: attacker.endUser.id, email });
    const verified = await auth('/magic-link/verify', { token: link.raw });
    expect(verified.statusCode, verified.body).toBe(200);
    const prover = verified.json().data as { accessToken: string };
    const claimed = await prisma.endUser.findUniqueOrThrow({ where: { id: attacker.endUser.id } });
    expect(claimed.sessionsInvalidBefore?.getTime(), 'the clock did not move').toBe(FROZEN.getTime());

    expect((await mcpOAuthService.userInfo(application, beforeToken)).ok, 'an MCP token from before the claim').toBe(false);
    expect((await me(attacker.accessToken)).statusCode, 'a session token from before the claim').toBe(401);
    expect((await me(prover.accessToken)).statusCode, 'the session of whoever proved the mailbox').toBe(200);

    vi.setSystemTime(new Date(FROZEN.getTime() + 1));
    const after = await mcpOAuthService.issueTokens(application, claimed, 'openid email', 'client-1', null);
    expect(
      (await mcpOAuthService.userInfo(application, String(after.access_token))).ok,
      'an MCP token minted a millisecond after the claim',
    ).toBe(true);
  });

  describe('an MFA challenge minted in the second every session was ended', () => {
    it('operator: the challenge from before sign-out everywhere is refused with a correct code, and a fresh sign-in passes', async () => {
      const email = `mfa-op-${Math.random().toString(36).slice(2, 8)}@example.com`;
      const signUp = await tenant('/auth/sign-up', { email, password: PASSWORD, workspaceName: 'Staging' });
      const session = signUp.json().data as { accessToken: string; user: { id: string } };
      await prisma.tenantUser.update({ where: { id: session.user.id }, data: { emailVerified: true } });
      const setup = await tenant('/auth/mfa/setup', {}, session.accessToken);
      expect(setup.statusCode, setup.body).toBe(201);
      const totp = OTPAuth.URI.parse((setup.json().data as { otpauthUrl: string }).otpauthUrl) as OTPAuth.TOTP;
      const confirmed = await tenant(
        '/auth/mfa/setup-confirm',
        { code: totp.generate({ timestamp: Date.now() - 30_000 }) },
        session.accessToken,
      );
      expect(confirmed.statusCode, confirmed.body).toBe(200);

      freeze();
      const signIn = await tenant('/auth/sign-in', { email, password: PASSWORD });
      const challenge = (signIn.json().data as { mfaChallengeToken: string }).mfaChallengeToken;
      expect(challenge).toBeTruthy();
      vi.setSystemTime(new Date(FROZEN.getTime() + 100));
      const { tenantAuthService } = await import('../src/modules/tenant-auth/tenant-auth.service.js');
      await tenantAuthService.signOutEverywhere(session.user.id);
      vi.setSystemTime(new Date(FROZEN.getTime() + 200));

      const stale = await tenant('/auth/mfa-verify', { mfaChallengeToken: challenge, code: totp.generate() });
      expect(stale.statusCode, `a challenge from before the revocation became a session: ${stale.body.slice(0, 200)}`).toBe(401);
      expect(stale.json().error.code).toBe('MFA_CHALLENGE_INVALID');
      expect(await prisma.tenantRefreshToken.count({ where: { tenantUserId: session.user.id, revokedAt: null } })).toBe(0);

      // The fix, followed: "Sign in again to obtain a fresh challenge token". A new time step, so the code is new too.
      vi.setSystemTime(new Date(FROZEN.getTime() + 31_000));
      const again = await tenant('/auth/sign-in', { email, password: PASSWORD });
      const fresh = (again.json().data as { mfaChallengeToken: string }).mfaChallengeToken;
      const passed = await tenant('/auth/mfa-verify', { mfaChallengeToken: fresh, code: totp.generate() });
      expect(passed.statusCode, passed.body).toBe(200);

      // The binding by itself, where the clock cannot help: a challenge that
      // says its first factor saw no stamp, dated after the stamp the account
      // now has (as one minted on an instance with a fast clock would be).
      vi.setSystemTime(new Date(FROZEN.getTime() + 62_000));
      const { issueTenantMfaChallengeToken } = await import('../src/lib/tenant-jwt.js');
      const unbound = issueTenantMfaChallengeToken(session.user.id, { basisStamp: null }).token;
      const refused = await tenant('/auth/mfa-verify', { mfaChallengeToken: unbound, code: totp.generate() });
      expect(refused.statusCode, refused.body.slice(0, 200)).toBe(401);
      expect(refused.json().error.code).toBe('MFA_CHALLENGE_INVALID');
    });

    it('end user: the challenge from before sign-out everywhere is refused with a correct code, and a fresh sign-in passes', async () => {
      const slug = `mfa-${Math.random().toString(36).slice(2, 8)}`;
      const op = await tenant('/auth/sign-up', { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: slug });
      const operator = { authorization: `Bearer ${(op.json().data as { accessToken: string }).accessToken}` };
      const applicationId = await app
        .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
        .then((r) => (r.json().data as { id: string }).id);
      const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
      const pk = { authorization: `Bearer ${application.publicKey}` };
      const auth = (url: string, payload: unknown, token?: string): Promise<LightMyRequestResponse> =>
        app.inject({
          method: 'POST',
          url: `/api/v1/auth${url}`,
          headers: { ...pk, ...(token && { 'x-rekey-user-token': token }) },
          payload: payload as never,
        });
      const email = 'mfa-user@example.com';
      const signUp = await auth('/sign-up', { email, password: PASSWORD });
      const session = signUp.json().data as { accessToken: string; endUser: { id: string } };
      await prisma.endUser.update({ where: { id: session.endUser.id }, data: { emailVerified: true } });
      const setup = await auth('/mfa/setup', {}, session.accessToken);
      expect(setup.statusCode, setup.body).toBe(201);
      const totp = OTPAuth.URI.parse((setup.json().data as { otpauthUrl: string }).otpauthUrl) as OTPAuth.TOTP;
      const confirmed = await auth(
        '/mfa/setup-confirm',
        { code: totp.generate({ timestamp: Date.now() - 30_000 }), currentPassword: PASSWORD },
        session.accessToken,
      );
      expect(confirmed.statusCode, confirmed.body).toBe(200);

      freeze();
      const signIn = await auth('/sign-in', { email, password: PASSWORD });
      const challenge = (signIn.json().data as { mfaChallengeToken: string }).mfaChallengeToken;
      expect(challenge).toBeTruthy();
      vi.setSystemTime(new Date(FROZEN.getTime() + 100));
      const { authService } = await import('../src/modules/auth/auth.service.js');
      await authService.signOutEverywhere(session.endUser.id);
      vi.setSystemTime(new Date(FROZEN.getTime() + 200));

      const stale = await auth('/mfa-verify', { mfaChallengeToken: challenge, code: totp.generate() });
      expect(stale.statusCode, `a challenge from before the revocation became a session: ${stale.body.slice(0, 200)}`).toBe(401);
      expect(stale.json().error.code).toBe('MFA_CHALLENGE_INVALID');
      expect(await prisma.refreshToken.count({ where: { endUserId: session.endUser.id, revokedAt: null } })).toBe(0);

      vi.setSystemTime(new Date(FROZEN.getTime() + 31_000));
      const again = await auth('/sign-in', { email, password: PASSWORD });
      const fresh = (again.json().data as { mfaChallengeToken: string }).mfaChallengeToken;
      const passed = await auth('/mfa-verify', { mfaChallengeToken: fresh, code: totp.generate() });
      expect(passed.statusCode, passed.body).toBe(200);

      vi.setSystemTime(new Date(FROZEN.getTime() + 62_000));
      const { issueMfaChallengeToken } = await import('../src/lib/jwt.js');
      const unbound = issueMfaChallengeToken(session.endUser.id, applicationId, application.tokenGeneration, {
        basisStamp: null,
      }).token;
      const refused = await auth('/mfa-verify', { mfaChallengeToken: unbound, code: totp.generate() });
      expect(refused.statusCode, refused.body.slice(0, 200)).toBe(401);
      expect(refused.json().error.code).toBe('MFA_CHALLENGE_INVALID');
    });
  });
});
