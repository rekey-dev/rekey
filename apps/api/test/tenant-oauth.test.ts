/**
 * Operator (panel) OAuth — social login for OPERATORS, not end-users.
 *
 * Verifies the provider-agnostic start/callback flow: configured-provider
 * discovery, authorization-URL build, verified-email gate, match-or-create of
 * a TenantUser (new → auto-creates an OWNER workspace; existing → signs into
 * it), and unknown-provider rejection. A mock provider is injected via the
 * registry so no real token exchange happens; the registry is restored after.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import type { OAuthProvider, OAuthIdentityResult } from '../src/modules/oauth/providers/index.js';
import { GoogleProvider } from '../src/modules/oauth/providers/google.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

// Mutable identity the mock returns from exchange(). Tests set it per case.
let nextIdentity: OAuthIdentityResult = { providerAccountId: 'g-default', email: 'def@example.com', emailVerified: true };

const mockGoogle: OAuthProvider = {
  name: 'google',
  buildAuthUrl: ({ config, state }) =>
    `https://accounts.google.test/o/oauth2/v2/auth?client_id=${encodeURIComponent(config.clientId)}` +
    `&redirect_uri=${encodeURIComponent(config.redirectUri)}&state=${encodeURIComponent(state)}`,
  exchange: async () => nextIdentity,
};

describe('Operator OAuth (panel social login)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    registerOAuthProvider(mockGoogle); // overwrite the real Google in the shared registry
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    registerOAuthProvider(new GoogleProvider()); // restore for other test files (singleFork shares the registry)
    await app.close();
  });

  beforeEach(() => {
    nextIdentity = { providerAccountId: 'g-default', email: 'def@example.com', emailVerified: true };
  });

  afterEach(() => {
    // Some cases below flip the signup mode; restore the default so the
    // earlier cases (and other files) keep their 'open' assumption.
    delete process.env.OPERATOR_SIGNUP_MODE;
  });

  const start = (provider: string, state = 'csrf-state-123') =>
    app.inject({ method: 'POST', url: `/api/v1/tenant/auth/oauth/${provider}/start`, payload: { state } });
  const callback = (provider: string, code = 'auth-code', inviteKey?: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/auth/oauth/${provider}/callback`,
      payload: { code, ...(inviteKey ? { inviteKey } : {}) },
    });
  const mintInvite = () =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/operator-invites',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: {},
      })
      .then((r) => (r.json().data as { rawToken: string }).rawToken);

  it('lists configured providers from server env', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenant/auth/oauth/providers' });
    expect(res.statusCode).toBe(200);
    const { providers } = res.json().data as { providers: string[] };
    expect(providers).toContain('google');
    expect(providers).toContain('github');
  });

  it('start returns an authorization URL carrying state + the panel redirect URI', async () => {
    const res = await start('google', 'state-abc');
    expect(res.statusCode).toBe(200);
    const { authorizationUrl } = res.json().data as { authorizationUrl: string };
    expect(authorizationUrl).toContain('state=state-abc');
    expect(authorizationUrl).toContain(
      encodeURIComponent('https://panel.test.local/login/oauth/google/callback'),
    );
    expect(authorizationUrl).toContain('test-google-client-id');
  });

  it('callback for a new operator auto-creates an OWNER workspace + mints a session', async () => {
    nextIdentity = { providerAccountId: 'g-new', email: 'NewOp@Example.com', emailVerified: true };
    const res = await callback('google');
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      mfaRequired: boolean;
      accessToken?: string;
      user: { email: string };
      memberships: Array<{ role: string }>;
      activeRole?: string;
    };
    expect(data.mfaRequired).toBe(false);
    expect(data.accessToken).toBeTruthy();
    expect(data.user.email).toBe('newop@example.com'); // lowercased
    expect(data.memberships).toHaveLength(1);
    expect(data.activeRole).toBe('OWNER');

    // Operator persisted with no password (OAuth-only) + verified email.
    const op = await prisma.tenantUser.findUnique({ where: { email: 'newop@example.com' } });
    expect(op?.passwordHash).toBeNull();
    expect(op?.emailVerified).toBe(true);
  });

  it('callback for an existing operator signs into their workspace (no duplicate)', async () => {
    // Pre-create an operator via password sign-up.
    const signUp = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'existing@example.com', password: 'pw-one-two-three', workspaceName: 'Existing WS' },
      })
      .then((r) => r.json().data as { user: { id: string } });

    nextIdentity = { providerAccountId: 'g-existing', email: 'existing@example.com', emailVerified: true };
    const res = await callback('google');
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { user: { id: string; email: string }; memberships: Array<{ tenantName: string }> };
    expect(data.user.id).toBe(signUp.user.id); // same operator, matched by email
    expect(data.memberships.some((m) => m.tenantName === 'Existing WS')).toBe(true);

    // No duplicate operator row.
    expect(await prisma.tenantUser.count({ where: { email: 'existing@example.com' } })).toBe(1);
  });

  it('refuses an unverified provider email', async () => {
    nextIdentity = { providerAccountId: 'g-unverified', email: 'sketchy@example.com', emailVerified: false };
    const res = await callback('google');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('OAUTH_EMAIL_NOT_VERIFIED');
    expect(await prisma.tenantUser.count({ where: { email: 'sketchy@example.com' } })).toBe(0);
  });

  it('refuses a provider with no email', async () => {
    nextIdentity = { providerAccountId: 'g-noemail', email: null, emailVerified: false };
    const res = await callback('google');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OAUTH_NO_EMAIL');
  });

  it('rejects a provider that is not an operator OAuth provider', async () => {
    const res = await start('microsoft');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('OAUTH_PROVIDER_UNKNOWN');
  });

  // ---------- OPERATOR_SIGNUP_MODE gating on the OAuth-first-login path ----------

  it('closed: an EXISTING operator can still sign in via OAuth', async () => {
    // Create while open.
    await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: 'oauth-existing@example.com', password: 'pw-one-two-three', workspaceName: 'WS' },
    });

    process.env.OPERATOR_SIGNUP_MODE = 'closed';
    nextIdentity = { providerAccountId: 'g-ex', email: 'oauth-existing@example.com', emailVerified: true };
    const res = await callback('google');
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { user: { email: string } }).user.email).toBe('oauth-existing@example.com');
  });

  it('closed: a NEW operator cannot be created via OAuth', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'closed';
    nextIdentity = { providerAccountId: 'g-blocked', email: 'oauth-blocked@example.com', emailVerified: true };
    const res = await callback('google');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OPERATOR_SIGNUP_CLOSED');
    expect(await prisma.tenantUser.count({ where: { email: 'oauth-blocked@example.com' } })).toBe(0);
  });

  it('invite: OAuth new-operator without a key is refused (OPERATOR_INVITE_REQUIRED)', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    nextIdentity = { providerAccountId: 'g-nokey', email: 'oauth-nokey@example.com', emailVerified: true };
    const res = await callback('google');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OPERATOR_INVITE_REQUIRED');
    expect(await prisma.tenantUser.count({ where: { email: 'oauth-nokey@example.com' } })).toBe(0);
  });

  it('invite: OAuth new-operator with a valid key is created and consumes the key', async () => {
    process.env.OPERATOR_SIGNUP_MODE = 'invite';
    const rawToken = await mintInvite();
    nextIdentity = { providerAccountId: 'g-key', email: 'oauth-key@example.com', emailVerified: true };

    const res = await callback('google', 'auth-code', rawToken);
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { activeRole: string }).activeRole).toBe('OWNER');

    const op = await prisma.tenantUser.findUnique({ where: { email: 'oauth-key@example.com' } });
    expect(op).not.toBeNull();
    const invite = await prisma.operatorInvite.findFirst({ where: { usedByTenantUserId: op!.id } });
    expect(invite?.usedAt).not.toBeNull();

    // The same key cannot create a second operator.
    nextIdentity = { providerAccountId: 'g-key2', email: 'oauth-key2@example.com', emailVerified: true };
    const replay = await callback('google', 'auth-code', rawToken);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('OPERATOR_INVITE_USED');
  });
});
