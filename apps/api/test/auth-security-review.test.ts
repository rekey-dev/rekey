/**
 * Regressions for the auth-surface hardening that landed in
 * 2.0.0-rc.1 — the `PATCH /users/me` self-service route, the OpenID Provider,
 * and the two email-verification switches, which merged within an hour of each
 * other and whose INTERACTION is where most of this came from.
 *
 * Every case here was reproduced against a running server before it was fixed.
 * They are written as "this exact request used to work, and must not" rather
 * than as coverage of the fix, because the fix is not the invariant — the
 * refusal is. Each `it` names the finding it belongs to.
 *
 * Domain tables truncate before each test, so each case bootstraps its own
 * operator, Application and end-user.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { PROFILE_METADATA_CLAIMS, OIDC_METADATA_NAMESPACE } from '../src/lib/oidc-profile.js';

const PASSWORD = 'pw-one-two-three';
const REDIRECT = 'http://localhost:9876/cb';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function form(payload: Record<string, string>): {
  headers: Record<string, string>;
  payload: string;
} {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  };
}

function decodeJwt(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

interface Fixture {
  slug: string;
  appId: string;
  liveKey: string;
  publishableKey: string;
  operatorToken: string;
}

describe('auth security review (2.0.0-rc.1)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;

  async function bootstrap(authConfig: Record<string, unknown> = {}): Promise<Fixture> {
    const slug = `sec-${n++}-${Math.random().toString(36).slice(2, 7)}`;
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: 'Sec Co' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'Sec App', slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    if (Object.keys(authConfig).length > 0) {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/auth-config`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: authConfig,
      });
      expect(patched.statusCode).toBe(200);
    }
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const { publicKey } = await prisma.application.findUniqueOrThrow({
      where: { id: appId },
      select: { publicKey: true },
    });
    return { slug, appId, liveKey, publishableKey: publicKey, operatorToken };
  }

  const signUp = (fx: Fixture, email: string, extra: Record<string, unknown> = {}, key?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key ?? fx.liveKey}` },
      payload: { email, password: PASSWORD, ...extra },
    });

  const signIn = (fx: Fixture, email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${fx.liveKey}` },
      payload: { email, password: PASSWORD },
    });

  const setAuthConfig = (fx: Fixture, patch: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${fx.appId}/auth-config`,
      headers: { authorization: `Bearer ${fx.operatorToken}` },
      payload: patch,
    });

  /** Seed a verified end-user with a password, through the operator route. */
  async function seedUser(
    fx: Fixture,
    email: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${fx.appId}/end-users`,
      headers: { authorization: `Bearer ${fx.operatorToken}` },
      payload: {
        email,
        password: PASSWORD,
        emailVerified: true,
        ...(metadata !== undefined && { metadata }),
      },
    });
    expect(created.statusCode).toBe(201);
    return (created.json().data as { id: string }).id;
  }

  async function registerClient(fx: Fixture): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/register`,
      payload: { redirect_uris: [REDIRECT], client_name: 'RP' },
    });
    expect(r.statusCode).toBe(201);
    return (r.json() as { client_id: string }).client_id;
  }

  /** Run the authorize form to a code, then redeem it. */
  async function grant(
    fx: Fixture,
    args: { clientId: string; email: string; scope?: string },
  ): Promise<Record<string, string>> {
    const { verifier, challenge } = pkce();
    const authorize = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/authorize`,
      ...form({
        response_type: 'code',
        client_id: args.clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(args.scope !== undefined && { scope: args.scope }),
        email: args.email,
        password: PASSWORD,
        consent: 'allow',
      }),
    });
    expect(authorize.statusCode).toBe(302);
    const code = new URL(authorize.headers.location as string).searchParams.get('code');
    expect(code).toBeTruthy();
    const tok = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: args.clientId,
      }),
    });
    expect(tok.statusCode).toBe(200);
    return tok.json() as Record<string, string>;
  }

  // ── 1. requireEmailVerification is bypassed by sign-up ──────────────────

  describe('1 — requireEmailVerification covers sign-up, not just sign-in', () => {
    it('sign-up hands back NO session, and the account is still created', async () => {
      const fx = await bootstrap({ requireEmailVerification: true });
      const res = await signUp(fx, 'fresh@example.com');

      // Used to be 201 with a working access + refresh token.
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      const body = res.json();
      expect(body.data).toBeUndefined();

      // The account exists — the refusal is of the session, not the sign-up —
      // and no refresh chain was opened.
      const user = await prisma.endUser.findFirstOrThrow({
        where: { applicationId: fx.appId, email: 'fresh@example.com' },
      });
      expect(user.emailVerified).toBe(false);
      expect(await prisma.refreshToken.count({ where: { endUserId: user.id } })).toBe(0);
    });

    it('the verification mail goes out even with the auto-send switch off', async () => {
      // Otherwise the two settings together mint accounts nobody can reach:
      // no session to re-send from, and no link ever posted. (The first half of
      // that is no longer true — POST /auth/resend-verification needs no
      // session — but a link the user never received is still the wrong
      // default, so this invariant stands.)
      //
      // `appUrl` because a send with no resolvable link is skipped outright
      // rather than mailing a button-less confirmation; that behaviour has its
      // own coverage in email-verification-config.test.ts.
      const fx = await bootstrap({
        requireEmailVerification: true,
        sendVerificationEmailOnSignUp: false,
        appUrl: 'https://app.example.com',
      });
      expect((await signUp(fx, 'stranded@example.com')).statusCode).toBe(403);

      const deadline = Date.now() + 4000;
      for (;;) {
        const count = await prisma.emailVerificationToken.count({
          where: { applicationId: fx.appId },
        });
        if (count > 0 || Date.now() > deadline) {
          expect(count).toBe(1);
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    });

    it('refresh re-checks, so flipping the switch on ends live unverified sessions', async () => {
      const fx = await bootstrap();
      const created = await signUp(fx, 'grandfathered@example.com');
      expect(created.statusCode).toBe(201);
      const { refreshToken } = created.json().data as { refreshToken: string };

      expect((await setAuthConfig(fx, { requireEmailVerification: true })).statusCode).toBe(200);

      // Used to keep renewing for the full 30-day refresh lifetime.
      const refreshed = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { authorization: `Bearer ${fx.liveKey}` },
        payload: { refreshToken },
      });
      expect(refreshed.statusCode).toBe(403);
      expect(refreshed.json().error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('confirming the address restores sign-up-then-sign-in', async () => {
      const fx = await bootstrap({ requireEmailVerification: true });
      await signUp(fx, 'confirms@example.com');
      const user = await prisma.endUser.findFirstOrThrow({
        where: { applicationId: fx.appId, email: 'confirms@example.com' },
      });
      // Drives the remedy the error's `fix` names, which is the one that has to
      // work: with no session, the user cannot re-send their own link, so an
      // operator marks the address verified.
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${fx.appId}/end-users/${user.id}`,
        headers: { authorization: `Bearer ${fx.operatorToken}` },
        payload: { emailVerified: true },
      });
      expect(patched.statusCode).toBe(200);
      expect((await signIn(fx, 'confirms@example.com')).statusCode).toBe(200);
    });
  });

  // ── 2. the IdP asserted email addresses it never verified ───────────────

  describe('2 — the `email` scope requires requireEmailVerification', () => {
    it('is neither advertised nor granted while the Application does not require it', async () => {
      const fx = await bootstrap({ oidcEnabled: true, requireEmailVerification: false });
      const md = await app
        .inject({ method: 'GET', url: `/api/v1/mcp/${fx.slug}/.well-known/openid-configuration` })
        .then((r) => r.json() as Record<string, unknown>);
      // Discovery must not promise what the provider will not honour.
      expect(md.scopes_supported).toEqual(['openid', 'profile']);
      expect(md.claims_supported).not.toContain('email');
      expect(md.claims_supported).not.toContain('email_verified');

      const clientId = await registerClient(fx);
      await seedUser(fx, 'unverified-claim@example.com');
      const tokens = await grant(fx, {
        clientId,
        email: 'unverified-claim@example.com',
        scope: 'openid email',
      });
      // `openid` survives; `email` is dropped rather than granted.
      expect(tokens.scope).toBe('openid');
      const claims = decodeJwt(tokens.id_token!);
      expect(claims).not.toHaveProperty('email');
      expect(claims).not.toHaveProperty('email_verified');

      const userinfo = await app
        .inject({
          method: 'GET',
          url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
        .then((r) => r.json() as Record<string, unknown>);
      expect(userinfo).not.toHaveProperty('email');
    });

    it('never ships `email_verified: false` — an unproven address is omitted, not flagged', async () => {
      const fx = await bootstrap({ oidcEnabled: true, requireEmailVerification: true });
      const clientId = await registerClient(fx);
      const euId = await seedUser(fx, 'was-verified@example.com');
      // Belt and braces: the operator un-verifies the address AFTER the grant
      // scope was minted, exactly as switching the requirement back off mid
      // refresh-chain would. The stale scope must not resurrect the claim.
      const tokens = await grant(fx, {
        clientId,
        email: 'was-verified@example.com',
        scope: 'openid email',
      });
      expect(tokens.scope).toBe('openid email');
      expect(decodeJwt(tokens.id_token!).email_verified).toBe(true);

      await prisma.endUser.update({ where: { id: euId }, data: { emailVerified: false } });
      const userinfo = await app
        .inject({
          method: 'GET',
          url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
        .then((r) => r.json() as Record<string, unknown>);
      expect(userinfo).not.toHaveProperty('email');
      expect(userinfo).not.toHaveProperty('email_verified');
    });
  });

  // ── 3. end-users controlled five OIDC identity claims ───────────────────

  describe('3 — profile claims come from an operator-only namespace', () => {
    it('a self-service PATCH cannot set preferred_username, name or picture', async () => {
      const fx = await bootstrap({ oidcEnabled: true });
      const created = await signUp(fx, 'impersonator@example.com');
      const { accessToken } = created.json().data as { accessToken: string };
      const clientId = await registerClient(fx);

      // The exact payload from the report. Writing the claim NAMES at the top
      // level is still allowed — they are the app's own fields — so the write
      // succeeds and simply is not an identity assertion.
      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/',
        headers: {
          authorization: `Bearer ${fx.publishableKey}`,
          'x-rekey-user-token': accessToken,
        },
        payload: {
          metadata: {
            preferred_username: 'admin',
            name: 'Site Administrator',
            picture: 'javascript:alert(document.domain)',
          },
        },
      });
      expect(patched.statusCode).toBe(200);

      const tokens = await grant(fx, {
        clientId,
        email: 'impersonator@example.com',
        scope: 'openid profile',
      });
      const claims = decodeJwt(tokens.id_token!);
      for (const claim of PROFILE_METADATA_CLAIMS) {
        expect(claims, claim).not.toHaveProperty(claim);
      }
      const userinfo = await app
        .inject({
          method: 'GET',
          url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
        .then((r) => r.json() as Record<string, unknown>);
      expect(userinfo).not.toHaveProperty('preferred_username');
      expect(userinfo).not.toHaveProperty('name');
      expect(userinfo).not.toHaveProperty('picture');
    });

    it('the reserved namespace is refused outright on end-user-reachable writes', async () => {
      const fx = await bootstrap({ oidcEnabled: true });
      const created = await signUp(fx, 'reserved@example.com');
      const { accessToken } = created.json().data as { accessToken: string };

      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/',
        headers: {
          authorization: `Bearer ${fx.publishableKey}`,
          'x-rekey-user-token': accessToken,
        },
        payload: { metadata: { [OIDC_METADATA_NAMESPACE]: { preferred_username: 'admin' } } },
      });
      expect(patched.statusCode).toBe(400);
      expect(patched.json().error.code).toBe('METADATA_KEY_RESERVED');

      // Same door, at creation time, with the browser-shipped key.
      const seeded = await signUp(
        fx,
        'reserved-at-signup@example.com',
        { metadata: { [OIDC_METADATA_NAMESPACE]: { preferred_username: 'admin' } } },
        fx.publishableKey,
      );
      expect(seeded.statusCode).toBe(400);
      expect(seeded.json().error.code).toBe('METADATA_KEY_RESERVED');

      // A SECRET key is the customer's own server, which IS the operator here.
      const byServer = await signUp(fx, 'server-set@example.com', {
        metadata: { [OIDC_METADATA_NAMESPACE]: { preferred_username: 'ada' } },
      });
      expect(byServer.statusCode).toBe(201);
    });

    it('an operator-written picture must be an https URL', async () => {
      const fx = await bootstrap({ oidcEnabled: true });
      const clientId = await registerClient(fx);
      await seedUser(fx, 'pictures@example.com', {
        [OIDC_METADATA_NAMESPACE]: {
          name: 'Ada',
          picture: 'javascript:alert(document.domain)',
        },
      });
      const claims = decodeJwt(
        (await grant(fx, { clientId, email: 'pictures@example.com', scope: 'openid profile' }))
          .id_token!,
      );
      expect(claims.name).toBe('Ada');
      // Dropped, not passed through for the relying party to render.
      expect(claims).not.toHaveProperty('picture');
    });
  });

  // ── 4. an unsatisfiable scope request became a full mcp:account grant ───

  describe('4 — an unsatisfiable non-empty scope request is invalid_scope', () => {
    it('`scope=openid` against an MCP-only app does not yield mcp:account', async () => {
      const fx = await bootstrap({ mcpEnabled: true, oidcEnabled: false });
      const clientId = await registerClient(fx);
      const r = await app.inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=S256&scope=openid&state=st`,
      });
      // Used to render the login form and mint a working mcp:account token.
      expect(r.statusCode).toBe(302);
      const loc = new URL(r.headers.location as string);
      expect(loc.searchParams.get('error')).toBe('invalid_scope');
      expect(loc.searchParams.get('state')).toBe('st');
    });

    it('`scope=admin root` is refused too, not answered with account access', async () => {
      const fx = await bootstrap({ mcpEnabled: true });
      const clientId = await registerClient(fx);
      const r = await app.inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkce().challenge}&code_challenge_method=S256&scope=admin+root`,
      });
      expect(r.statusCode).toBe(302);
      expect(new URL(r.headers.location as string).searchParams.get('error')).toBe('invalid_scope');
    });

    it('a request naming NO scope still falls back to mcp:account', async () => {
      // The fallback exists for pre-OIDC MCP clients that send no `scope`
      // parameter at all. That case keeps working — it is the only one.
      const fx = await bootstrap({ mcpEnabled: true });
      const clientId = await registerClient(fx);
      await seedUser(fx, 'no-scope@example.com');
      const tokens = await grant(fx, { clientId, email: 'no-scope@example.com' });
      expect(tokens.scope).toBe('mcp:account');
      const rpc = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}`,
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(rpc.statusCode).toBe(200);
    });
  });

  // ── 5. GDPR-erased users kept access on the OAuth surface ───────────────

  describe('5 — an erased end-user is refused at every OAuth/OIDC door', () => {
    /** Bootstrap an app + client + user holding a full grant, then erase. */
    async function grantThenErase(): Promise<{
      fx: Fixture;
      clientId: string;
      tokens: Record<string, string>;
      euId: string;
    }> {
      const fx = await bootstrap({
        mcpEnabled: true,
        oidcEnabled: true,
        requireEmailVerification: true,
      });
      const clientId = await registerClient(fx);
      const euId = await seedUser(fx, 'erased@example.com');
      const tokens = await grant(fx, {
        clientId,
        email: 'erased@example.com',
        scope: 'openid email mcp:account',
      });
      // Stamped directly rather than through the erase endpoint: it isolates
      // the token-resolving paths from erasure's own credential deletion,
      // which is the belt the braces here are for.
      await prisma.endUser.update({ where: { id: euId }, data: { erasedAt: new Date() } });
      return { fx, clientId, tokens, euId };
    }

    it('MCP tools/call get_profile returns 401, not the erased profile', async () => {
      const { fx, tokens } = await grantThenErase();
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}`,
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_profile', arguments: {} },
        }),
      });
      expect(r.statusCode).toBe(401);
      expect((r.json() as { error: string }).error).toBe('invalid_token');
    });

    it('the refresh grant refuses instead of minting a fresh access token', async () => {
      const { fx, clientId, tokens } = await grantThenErase();
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/token`,
        ...form({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token!,
          client_id: clientId,
        }),
      });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: string }).error).toBe('invalid_grant');
    });

    it('a code minted before the erasure yields no id_token after it', async () => {
      const fx = await bootstrap({ oidcEnabled: true, requireEmailVerification: true });
      const clientId = await registerClient(fx);
      const euId = await seedUser(fx, 'pre-erase-code@example.com');
      const { verifier, challenge } = pkce();
      const authorize = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/authorize`,
        ...form({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'openid email',
          email: 'pre-erase-code@example.com',
          password: PASSWORD,
          consent: 'allow',
        }),
      });
      const code = new URL(authorize.headers.location as string).searchParams.get('code')!;

      await prisma.endUser.update({ where: { id: euId }, data: { erasedAt: new Date() } });

      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/token`,
        ...form({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: clientId,
        }),
      });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error: string }).error).toBe('invalid_grant');
    });

    it("erasure itself deletes the user's mcp refresh tokens and pending codes", async () => {
      const fx = await bootstrap({
        mcpEnabled: true,
        oidcEnabled: true,
        requireEmailVerification: true,
      });
      const clientId = await registerClient(fx);
      const euId = await seedUser(fx, 'real-erase@example.com');
      await grant(fx, { clientId, email: 'real-erase@example.com', scope: 'openid mcp:account' });
      // A second, unredeemed code left pending at the moment of erasure.
      await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/authorize`,
        ...form({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
          scope: 'openid',
          email: 'real-erase@example.com',
          password: PASSWORD,
          consent: 'allow',
        }),
      });
      expect(await prisma.refreshToken.count({ where: { endUserId: euId, kind: 'mcp' } })).toBe(1);
      expect(await prisma.oAuthAuthCode.count({ where: { endUserId: euId } })).toBe(2);

      const erased = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${fx.appId}/end-users/${euId}?erasure=true`,
        headers: { authorization: `Bearer ${fx.operatorToken}` },
      });
      expect(erased.statusCode).toBe(200);
      expect(await prisma.refreshToken.count({ where: { endUserId: euId } })).toBe(0);
      expect(await prisma.oAuthAuthCode.count({ where: { endUserId: euId } })).toBe(0);
    });
  });

  // ── 6. the 16KB metadata cap covered one of three writers ───────────────

  describe('6 — the metadata ceiling applies to every writer', () => {
    it('sign-up refuses an oversized blob instead of storing it forever', async () => {
      const fx = await bootstrap();
      const res = await signUp(fx, 'fat-signup@example.com', {
        metadata: { blob: 'x'.repeat(200 * 1024) },
      });
      // Used to store 204,811 bytes and permanently brick that user's own
      // PATCH route: the cap is measured post-merge, so every later write
      // failed on bytes they could no longer remove.
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('METADATA_TOO_LARGE');
      expect(
        await prisma.endUser.count({
          where: { applicationId: fx.appId, email: 'fat-signup@example.com' },
        }),
      ).toBe(0);
    });

    it('the operator create and patch routes refuse it too', async () => {
      const fx = await bootstrap();
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${fx.appId}/end-users`,
        headers: { authorization: `Bearer ${fx.operatorToken}` },
        payload: { email: 'fat-operator@example.com', metadata: { blob: 'x'.repeat(200 * 1024) } },
      });
      expect(created.statusCode).toBe(400);
      expect(created.json().error.code).toBe('METADATA_TOO_LARGE');

      const euId = await seedUser(fx, 'fat-patch@example.com');
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${fx.appId}/end-users/${euId}`,
        headers: { authorization: `Bearer ${fx.operatorToken}` },
        payload: { metadata: { blob: 'x'.repeat(200 * 1024) } },
      });
      expect(patched.statusCode).toBe(400);
      expect(patched.json().error.code).toBe('METADATA_TOO_LARGE');
    });

    it('an over-long claim is dropped, so no giant id_token or userinfo body', async () => {
      const fx = await bootstrap({ oidcEnabled: true });
      const clientId = await registerClient(fx);
      // Well inside the 16KB object cap, and previously produced a
      // 164,620-byte id_token via a 120KB `name`. 12KB is the same shape.
      await seedUser(fx, 'long-claim@example.com', {
        [OIDC_METADATA_NAMESPACE]: { name: 'y'.repeat(12 * 1024), given_name: 'Ada' },
      });
      const tokens = await grant(fx, {
        clientId,
        email: 'long-claim@example.com',
        scope: 'openid profile',
      });
      expect(tokens.id_token!.length).toBeLessThan(4096);
      const claims = decodeJwt(tokens.id_token!);
      expect(claims).not.toHaveProperty('name');
      expect(claims.given_name).toBe('Ada');

      const userinfo = await app.inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      expect(userinfo.body.length).toBeLessThan(4096);
    });
  });

  // ── 7. magic-link sign-in discarded the mailbox proof ──────────────────

  describe('7 — magic-link sign-in records the proof it collected', () => {
    it('an existing unverified password user comes out verified', async () => {
      const fx = await bootstrap({ methods: ['password', 'magic_link'] });
      const created = await signUp(fx, 'magic@example.com');
      expect(created.statusCode).toBe(201);
      const before = await prisma.endUser.findFirstOrThrow({
        where: { applicationId: fx.appId, email: 'magic@example.com' },
      });
      expect(before.emailVerified).toBe(false);

      const { magicLinkToken } = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/magic-link/request',
          headers: { authorization: `Bearer ${fx.liveKey}` },
          payload: { email: 'magic@example.com' },
        })
        .then((r) => r.json().data as { magicLinkToken: string });
      const verified = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: { authorization: `Bearer ${fx.liveKey}` },
        payload: { token: magicLinkToken },
      });
      expect(verified.statusCode).toBe(200);

      const after = await prisma.endUser.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.emailVerified).toBe(true);
    });

    it('so the gate is not bypassable by magic link — it is satisfiable by it', async () => {
      const fx = await bootstrap({ methods: ['password', 'magic_link'] });
      expect((await signUp(fx, 'gate@example.com')).statusCode).toBe(201);
      expect((await setAuthConfig(fx, { requireEmailVerification: true })).statusCode).toBe(200);
      // Password sign-in is refused while the address is unconfirmed…
      expect((await signIn(fx, 'gate@example.com')).statusCode).toBe(403);

      const { magicLinkToken } = await app
        .inject({
          method: 'POST',
          url: '/api/v1/auth/magic-link/request',
          headers: { authorization: `Bearer ${fx.liveKey}` },
          payload: { email: 'gate@example.com' },
        })
        .then((r) => r.json().data as { magicLinkToken: string });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/magic-link/verify',
            headers: { authorization: `Bearer ${fx.liveKey}` },
            payload: { token: magicLinkToken },
          })
        ).statusCode,
      ).toBe(200);

      // …and afterwards it works, because the proof was kept rather than
      // spent on one session and thrown away.
      expect((await signIn(fx, 'gate@example.com')).statusCode).toBe(200);
    });
  });

  // ── 8. open dynamic client registration on a public IdP ────────────────

  describe('8 — dynamic client registration is a toggle', () => {
    it('defaults open, because MCP clients self-register and nothing else can', async () => {
      const fx = await bootstrap({ mcpEnabled: true });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/mcp/${fx.slug}/oauth/register`,
            payload: { redirect_uris: [REDIRECT] },
          })
        ).statusCode,
      ).toBe(201);
    });

    it('closed: registration 403s and neither discovery document advertises it', async () => {
      const fx = await bootstrap({
        mcpEnabled: true,
        oidcEnabled: true,
        dynamicClientRegistration: false,
      });
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/register`,
        payload: { redirect_uris: [REDIRECT], client_name: 'Rogue Relying Party' },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('CLIENT_REGISTRATION_DISABLED');
      expect(await prisma.oAuthClient.count({ where: { applicationId: fx.appId } })).toBe(0);

      for (const path of ['oauth-authorization-server', 'openid-configuration']) {
        const md = await app
          .inject({ method: 'GET', url: `/api/v1/mcp/${fx.slug}/.well-known/${path}` })
          .then((res) => res.json() as Record<string, unknown>);
        expect(md, path).not.toHaveProperty('registration_endpoint');
      }
    });

    it('closing it does not break clients that already registered', async () => {
      const fx = await bootstrap({ oidcEnabled: true, requireEmailVerification: true });
      const clientId = await registerClient(fx);
      await seedUser(fx, 'already-registered@example.com');
      expect(
        (await setAuthConfig(fx, { dynamicClientRegistration: false })).statusCode,
      ).toBe(200);
      const tokens = await grant(fx, {
        clientId,
        email: 'already-registered@example.com',
        scope: 'openid',
      });
      expect(tokens.id_token).toBeTruthy();
    });
  });

  // ── the allowlist that blocks id_token-as-access-token ─────────────────

  describe('id_token-as-access-token stays blocked structurally', () => {
    it('the profile claim allowlist can never name a token-authenticating claim', async () => {
      // `PROFILE_METADATA_CLAIMS` is sourced from `EndUser.metadata`. If any of
      // these names entered it, an operator (or, before finding 3, an end-user)
      // could put `typ: "mcp_access"` and another Application's `applicationId`
      // into an ID Token — which is signed by the same deployment and would
      // then pass `verifyMcpAccessToken`. That is cross-application account
      // takeover, gated today by this list and nothing else.
      const forbidden = ['typ', 'applicationId', 'gen', 'sub', 'iss', 'aud', 'exp', 'iat', 'scope'];
      for (const claim of forbidden) {
        expect(PROFILE_METADATA_CLAIMS as readonly string[], claim).not.toContain(claim);
      }
    });

    it('issueIdToken strips them even if a caller passes them explicitly', async () => {
      // The structural half of the same defence: widening `IssueIdTokenArgs.claims`
      // must not be able to reintroduce the hole either.
      const { issueIdToken } = await import('../src/lib/jwt.js');
      const { getActiveSigningKey } = await import('../src/lib/signing-keys.js');
      const key = await getActiveSigningKey();
      const { token } = issueIdToken({
        issuer: 'https://issuer.test.invalid/api/v1/mcp/x',
        endUserId: 'eu_real',
        clientId: 'client_1',
        key,
        authTime: new Date(),
        claims: {
          typ: 'mcp_access',
          applicationId: 'app_victim',
          gen: 99,
          scope: 'mcp:account',
          sub: 'eu_attacker',
          name: 'Ada',
        },
      });
      const claims = decodeJwt(token);
      expect(claims.typ).toBeUndefined();
      expect(claims.applicationId).toBeUndefined();
      expect(claims.gen).toBeUndefined();
      expect(claims.scope).toBeUndefined();
      // `sub` is the argument's, never the caller's claims bag.
      expect(claims.sub).toBe('eu_real');
      expect(claims.name).toBe('Ada');
    });

    it('an ID Token is still rejected as a bearer token on the MCP endpoint', async () => {
      const fx = await bootstrap({ mcpEnabled: true, oidcEnabled: true });
      const clientId = await registerClient(fx);
      await seedUser(fx, 'substitution@example.com');
      const tokens = await grant(fx, {
        clientId,
        email: 'substitution@example.com',
        scope: 'openid mcp:account',
      });
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}`,
        headers: {
          authorization: `Bearer ${tokens.id_token}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(r.statusCode).toBe(401);
    });
  });
});
