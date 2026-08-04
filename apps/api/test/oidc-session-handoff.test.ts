/**
 * App-authorised session handoff:
 * `POST /api/v1/mcp/:slug/oauth/authorize/grant`.
 *
 * The interactive `/oauth/authorize` asks the end-user for a password because
 * this AS keeps no SSO session. This endpoint is the case where the caller is
 * the Application's OWN server and has already done that: it presents its
 * secret key plus the user's live access token and gets back an authorization
 * code.
 *
 * The claim this file has to hold up is that the endpoint grants no authority
 * the caller did not already have. So the negative cases carry the weight:
 * a publishable key must not reach it, a token from another Application must
 * not be honoured, a secret key must not mint codes on an Application it does
 * not belong to, and an impersonated session must not be handed on. The code
 * it produces must be indistinguishable from an interactive one — single-use,
 * PKCE-bound, 60 seconds — which is checked by redeeming it.
 *
 * Domain tables truncate before each test, so each case bootstraps its own
 * operator + app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

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

const REDIRECT = 'http://localhost:9876/cb';
const EU_PASSWORD = 'pw-one-two-three';

describe('app-authorised session handoff', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;

  interface Fixture {
    slug: string;
    appId: string;
    clientId: string;
    euEmail: string;
    euId: string;
    liveKey: string;
    publishableKey: string;
    operatorToken: string;
    /** A live end-user access token for `euEmail`. */
    userToken: string;
  }

  async function bootstrap(toggles: Record<string, boolean> = {}): Promise<Fixture> {
    const slug = `hand-${n++}-${Math.random().toString(36).slice(2, 7)}`;
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: EU_PASSWORD, workspaceName: 'Handoff Co' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'Handoff App', slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/auth-config`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { oidcEnabled: true, requireEmailVerification: true, ...toggles },
    });
    expect(patched.statusCode).toBe(200);
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'handoff-key', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const { publicKey } = await prisma.application.findUniqueOrThrow({
      where: { id: appId },
      select: { publicKey: true },
    });

    // Seeded through the operator route because `requireEmailVerification` is
    // on — public sign-up deliberately returns no session in that mode.
    const euEmail = `eu-${slug}@example.com`;
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { email: euEmail, password: EU_PASSWORD, emailVerified: true },
    });
    expect(created.statusCode).toBe(201);
    const euId = (created.json().data as { id: string }).id;

    const clientId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/register`,
        payload: { redirect_uris: [REDIRECT], client_name: 'Rekey Panel' },
      })
      .then((r) => (r.json() as { client_id: string }).client_id);

    const userToken = await signInEndUser(liveKey, euEmail);
    return { slug, appId, clientId, euEmail, euId, liveKey, publishableKey: publicKey, operatorToken, userToken };
  }

  async function signInEndUser(secretKey: string, email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { email, password: EU_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data as { accessToken: string }).accessToken;
  }

  /** Call the handoff endpoint with sensible defaults, overridable per case. */
  function handoff(
    fx: Fixture,
    opts: {
      challenge: string;
      key?: string;
      userToken?: string | null;
      slug?: string;
      clientId?: string;
      redirectUri?: string;
      method?: string;
      scope?: string;
      nonce?: string;
    },
  ) {
    const token = opts.userToken === undefined ? fx.userToken : opts.userToken;
    return app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${opts.slug ?? fx.slug}/oauth/authorize/grant`,
      headers: {
        authorization: `Bearer ${opts.key ?? fx.liveKey}`,
        ...(token ? { 'x-rekey-user-token': token } : {}),
      },
      payload: {
        client_id: opts.clientId ?? fx.clientId,
        redirect_uri: opts.redirectUri ?? REDIRECT,
        code_challenge: opts.challenge,
        code_challenge_method: opts.method ?? 'S256',
        scope: opts.scope ?? 'openid email',
        ...(opts.nonce !== undefined && { nonce: opts.nonce }),
      },
    });
  }

  // ---- The happy path, proven by redeeming the code ------------------------

  it('exchanges a live session for a code that redeems to an ID Token for that user', async () => {
    const fx = await bootstrap();
    const { verifier, challenge } = pkce();

    const granted = await handoff(fx, { challenge, nonce: 'n-once' });
    expect(granted.statusCode).toBe(200);
    const { code, expires_in } = granted.json() as { code: string; expires_in: number };
    expect(code).toBeTruthy();
    expect(expires_in).toBe(60);

    // Redeemed at the ordinary token endpoint — no special path.
    const tok = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: fx.clientId,
      }),
    });
    expect(tok.statusCode).toBe(200);
    const body = tok.json() as Record<string, string>;
    expect(body.id_token).toBeTruthy();

    const claims = jwt.decode(body.id_token) as Record<string, unknown>;
    // `sub` is the EndUser id — the identity the panel will federate on.
    expect(claims.sub).toBe(fx.euId);
    expect(claims.aud).toBe(fx.clientId);
    expect(claims.email).toBe(fx.euEmail);
    expect(claims.email_verified).toBe(true);
    expect(claims.nonce).toBe('n-once');
    expect(claims.auth_time).toBeTypeOf('number');
  });

  it('writes an audit event naming the application, the user and the client', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    expect((await handoff(fx, { challenge })).statusCode).toBe(200);

    // The event is recorded fire-and-forget; give it a beat to land.
    await new Promise((r) => setTimeout(r, 150));
    const events = await prisma.securityEvent.findMany({
      where: { type: 'user.session_handoff_granted', applicationId: fx.appId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(fx.euId);
    expect((events[0]!.metadata as Record<string, unknown>).clientId).toBe(fx.clientId);
  });

  // ---- The code must be an ordinary code ----------------------------------

  it('mints a single-use code — a replay of the same code is refused', async () => {
    const fx = await bootstrap();
    const { verifier, challenge } = pkce();
    const { code } = (await handoff(fx, { challenge })).json() as { code: string };

    const redeem = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/token`,
        ...form({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: fx.clientId,
        }),
      });

    expect((await redeem()).statusCode).toBe(200);
    const second = await redeem();
    expect(second.statusCode).toBe(400);
    expect((second.json() as { error: string }).error).toBe('invalid_grant');
  });

  it('binds the code to the PKCE challenge — a wrong verifier is refused', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const { code } = (await handoff(fx, { challenge })).json() as { code: string };

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({
        grant_type: 'authorization_code',
        code,
        code_verifier: pkce().verifier,
        redirect_uri: REDIRECT,
        client_id: fx.clientId,
      }),
    });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { error: string }).error).toBe('invalid_grant');
  });

  // ---- Credential gates ---------------------------------------------------

  it('refuses a publishable key', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, key: fx.publishableKey });
    expect(res.statusCode).toBe(401);
    // Refused by `requireApiKey` on the prefix, before the handler — the
    // browser-shipped credential can never reach this endpoint.
    expect((res.json().error as { code: string }).code).toBe('API_KEY_INVALID');
  });

  it('refuses a missing user token', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, userToken: null });
    expect(res.statusCode).toBe(401);
    expect((res.json().error as { code: string }).code).toBe('USER_TOKEN_MISSING');
  });

  it('refuses a garbage user token — the session must be real, not claimed', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, userToken: 'not.a.jwt' });
    expect(res.statusCode).toBe(401);
    expect((res.json().error as { code: string }).code).toBe('USER_TOKEN_INVALID');
  });

  it('refuses a user token issued by a different Application', async () => {
    const a = await bootstrap();
    const b = await bootstrap();
    const { challenge } = pkce();
    // B's secret key, A's user token: the cross-application guard.
    const res = await handoff(b, { challenge, userToken: a.userToken });
    expect(res.statusCode).toBe(401);
    // `USER_TOKEN_INVALID`, not `USER_TOKEN_WRONG_APPLICATION`: end-user access
    // tokens are HS256-signed with a key derived per Application, so A's token
    // fails B's signature check before anything reads its `applicationId`
    // claim. The cross-application guard is therefore cryptographic here and
    // the claim comparison in `requireUserSession` is defence in depth — this
    // asserts the stronger of the two actually fires.
    expect((res.json().error as { code: string }).code).toBe('USER_TOKEN_INVALID');
  });

  it("refuses a secret key that belongs to a different Application than the slug", async () => {
    const a = await bootstrap();
    const b = await bootstrap();
    const { challenge } = pkce();
    // B's key + B's user token, but pointed at A's slug. Without the explicit
    // slug/key check this would mint a code on the wrong Application.
    const res = await handoff(b, { challenge, slug: a.slug, clientId: a.clientId });
    expect(res.statusCode).toBe(403);
    expect((res.json().error as { code: string }).code).toBe('SESSION_HANDOFF_FORBIDDEN');
  });

  it('refuses an impersonated session — an operator cannot hand one on', async () => {
    const fx = await bootstrap();
    const imp = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${fx.appId}/end-users/${fx.euId}/impersonate`,
      headers: { authorization: `Bearer ${fx.operatorToken}` },
      payload: { reason: 'support ticket 123' },
    });
    expect(imp.statusCode).toBe(200);
    const impToken = (imp.json().data as { accessToken: string }).accessToken;

    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, userToken: impToken });
    expect(res.statusCode).toBe(403);
    expect((res.json().error as { code: string }).code).toBe('IMPERSONATION_ACTION_FORBIDDEN');
  });

  // ---- Request validation -------------------------------------------------

  it('refuses an unknown client_id', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, clientId: 'no-such-client' });
    expect(res.statusCode).toBe(400);
    expect((res.json().error as { code: string }).code).toBe('INVALID_GRANT_REQUEST');
  });

  it('refuses a redirect_uri that is not registered for the client', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, redirectUri: 'https://evil.example/cb' });
    expect(res.statusCode).toBe(400);
    expect((res.json().error as { code: string }).code).toBe('INVALID_GRANT_REQUEST');
  });

  it('refuses a PKCE method other than S256', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, method: 'plain' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a request whose scopes the Application cannot grant', async () => {
    const fx = await bootstrap();
    const { challenge } = pkce();
    const res = await handoff(fx, { challenge, scope: 'wat' });
    expect(res.statusCode).toBe(400);
    expect((res.json().error as { code: string }).code).toBe('INVALID_GRANT_REQUEST');
  });

  it('404s when the Application is not an OIDC provider', async () => {
    const fx = await bootstrap({ oidcEnabled: false, mcpEnabled: false });
    const { challenge } = pkce();
    // An explicit client_id because registration is unavailable on an app that
    // is neither an OIDC nor an MCP auth server, and a body missing a required
    // field would 400 in schema validation before reaching the gate under test.
    const res = await handoff(fx, { challenge, clientId: 'irrelevant' });
    expect(res.statusCode).toBe(404);
  });
});
