/**
 * Token lifetimes come from the environment.
 *
 * Four values that were hard-coded (15 minutes and 30 days, for end-users
 * and for operators) are deployment settings now. Pinned here: the defaults
 * are the old constants, and each issuer actually reads its setting rather
 * than a private copy of the number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { issueTenantAccessToken } from '../src/lib/tenant-jwt.js';
import { issueUserAccessToken } from '../src/lib/jwt.js';
import { issueRefreshToken, revokeAllForEndUser } from '../src/lib/refresh-tokens.js';
import { issueTenantRefreshToken, revokeAllTenantRefreshTokensForUser } from '../src/lib/tenant-refresh-tokens.js';

function lifetimeOf(token: string): number {
  const claims = jwt.decode(token) as { iat: number; exp: number };
  return claims.exp - claims.iat;
}

describe('token lifetimes', () => {
  it('defaults are the values that used to be hard-coded', () => {
    expect(env.END_USER_ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(env.END_USER_REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(env.OPERATOR_ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
    expect(env.OPERATOR_REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });

  it('the operator access token lasts OPERATOR_ACCESS_TOKEN_TTL_SECONDS', () => {
    const { token, expiresAt } = issueTenantAccessToken('user_1', 'tenant_1', 'MEMBER');
    expect(lifetimeOf(token)).toBe(env.OPERATOR_ACCESS_TOKEN_TTL_SECONDS);
    expect(Math.round((expiresAt.getTime() - Date.now()) / 1000)).toBeCloseTo(env.OPERATOR_ACCESS_TOKEN_TTL_SECONDS, -1);
  });

  it('the end-user access token lasts END_USER_ACCESS_TOKEN_TTL_SECONDS', () => {
    // Third positional is the Application's tokenGeneration.
    const issued = issueUserAccessToken('eu_1', 'app_1', 0, {});
    expect(lifetimeOf(issued.token)).toBe(env.END_USER_ACCESS_TOKEN_TTL_SECONDS);
  });

  it('an explicit lifetime still wins over the setting', () => {
    const { token } = issueTenantAccessToken('user_1', 'tenant_1', 'MEMBER', { lifetimeSeconds: 120 });
    expect(lifetimeOf(token)).toBe(120);
  });
});

describe('refresh lifetimes and the session kill switch', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const inject = (opts: Record<string, unknown>) => app.inject({ remoteAddress: '10.97.1.1', ...opts } as never);
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const tag = `ttl-${Math.random().toString(36).slice(2, 8)}`;

  it('refresh tokens last the configured days, for end-users and operators', async () => {
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `${tag}-op@example.com`, password: 'pw-one-two-three', workspaceName: 'TTL Co' },
    });
    expect(su.statusCode).toBe(201);
    const { accessToken, user } = su.json().data as { accessToken: string; user: { id: string } };
    const mk = await inject({ method: 'POST', url: '/api/v1/tenant/applications', headers: auth(accessToken), payload: { name: tag, slug: tag } });
    expect(mk.statusCode).toBe(201);
    const appId = (mk.json().data as { id: string }).id;
    const eu = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(accessToken),
      payload: { email: `${tag}-eu@example.com`, password: 'pw-one-two-three', emailVerified: true },
    });
    expect(eu.statusCode).toBe(201);
    const euid = (eu.json().data as { id?: string; endUser?: { id: string } }).id ?? (eu.json().data as { endUser: { id: string } }).endUser.id;

    const day = 24 * 60 * 60 * 1000;
    const euRefresh = await issueRefreshToken(appId, euid);
    expect(Math.abs(euRefresh.record.expiresAt.getTime() - Date.now() - env.END_USER_REFRESH_TOKEN_TTL_DAYS * day)).toBeLessThan(5_000);
    const opRefresh = await issueTenantRefreshToken(user.id);
    expect(Math.abs(opRefresh.record.expiresAt.getTime() - Date.now() - env.OPERATOR_REFRESH_TOKEN_TTL_DAYS * day)).toBeLessThan(5_000);
  });

  it('an end-user access token minted before sign-out-everywhere is refused on both session routes', async () => {
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `${tag}-euop@example.com`, password: 'pw-one-two-three', workspaceName: 'EU Kill Co' },
    });
    const opToken = (su.json().data as { accessToken: string }).accessToken;
    const mk = await inject({ method: 'POST', url: '/api/v1/tenant/applications', headers: auth(opToken), payload: { name: `${tag}-eu`, slug: `${tag}-eu` } });
    const appId = (mk.json().data as { id: string }).id;
    const key = await inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${appId}/api-keys`,
      headers: auth(process.env.SUPER_ADMIN_KEY!),
      payload: { name: 'k', mode: 'live' },
    });
    expect(key.statusCode).toBe(201);
    const liveKey = (key.json().data as { rawKey: string }).rawKey;
    const eu = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(opToken),
      payload: { email: `${tag}-victim@example.com`, password: 'pw-one-two-three', emailVerified: true },
    });
    expect(eu.statusCode).toBe(201);
    const euid = (eu.json().data as { id?: string; endUser?: { id: string } }).id ?? (eu.json().data as { endUser: { id: string } }).endUser.id;
    const signIn = await inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: auth(liveKey),
      payload: { email: `${tag}-victim@example.com`, password: 'pw-one-two-three' },
    });
    expect(signIn.statusCode).toBe(200);
    const userToken = (signIn.json().data as { accessToken: string }).accessToken;
    const me = (t: string) => inject({ method: 'GET', url: '/api/v1/users/me', headers: { ...auth(liveKey), 'x-rekey-user-token': t } });
    const authMe = (t: string) => inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-rekey-user-token': t } });
    expect((await me(userToken)).statusCode).toBe(200);
    expect((await authMe(userToken)).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1_100));
    await revokeAllForEndUser(euid);
    const after = await me(userToken);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('USER_TOKEN_INVALID');
    // /auth/me is the SDK's user read and takes the same door.
    expect((await authMe(userToken)).statusCode).toBe(401);
    // The stamp never leaves the server.
    const again = await inject({ method: 'POST', url: '/api/v1/auth/sign-in', headers: auth(liveKey), payload: { email: `${tag}-victim@example.com`, password: 'pw-one-two-three' } });
    expect(again.statusCode).toBe(200);
    expect(JSON.stringify(again.json())).not.toContain('sessionsInvalidBefore');
    expect((await me((again.json().data as { accessToken: string }).accessToken)).statusCode).toBe(200);
  });

  it('an operator access token minted before sign-out-everywhere is refused, whatever its lifetime', async () => {
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `${tag}-kill@example.com`, password: 'pw-one-two-three', workspaceName: 'Kill Co' },
    });
    const { accessToken, user } = su.json().data as { accessToken: string; user: { id: string } };
    expect((await inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(accessToken) })).statusCode).toBe(200);
    // Force the stamp into the past second so the token's iat is strictly before it.
    await new Promise((r) => setTimeout(r, 1_100));
    await revokeAllTenantRefreshTokensForUser(user.id);
    const after = await inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(accessToken) });
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('TENANT_SESSION_INVALID');
    // A fresh sign-in is minted after the stamp and works.
    const again = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email: `${tag}-kill@example.com`, password: 'pw-one-two-three' },
    });
    expect(again.statusCode).toBe(200);
    const fresh = (again.json().data as { accessToken: string }).accessToken;
    expect((await inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth(fresh) })).statusCode).toBe(200);
  });
});
