/**
 * The hosted portal as the authorization page.
 *
 * For an Application with the hosted portal on and no `hostedAuthorizeUrl`,
 * `/oauth/authorize` stores the validated request and sends the browser to
 * the portal with an opaque id. The portal reads it back through `/preview`
 * and answers through `/grant` or `/deny`, with the publishable key, the
 * user's token and the deployment caller secret.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { makeEndUser } from './device-fixtures.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const CALLER_SECRET = 'caller-secret-for-portal-authorization-tests';
const PORTAL = { 'x-rekey-caller-secret': CALLER_SECRET };
const PASSWORD = 'pw-one-two-three';
const REDIRECT = 'http://127.0.0.1:53682/callback';
const PORTAL_ORIGIN = new URL(process.env.PUBLIC_PORTAL_URL ?? 'https://portal.test.invalid').origin;

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

interface Fixture {
  slug: string;
  appId: string;
  operatorToken: string;
  publishableKey: string;
  clientId: string;
}

describe('the hosted portal as the authorization page', () => {
  let app: FastifyInstance;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false, apiProxy: { callerSecret: CALLER_SECRET } });
    await app.ready();
  });
  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
  });

  async function bootstrap(opts: { portal?: boolean; auth?: Record<string, unknown> } = {}): Promise<Fixture> {
    const slug = `pa-${n++}-${Math.random().toString(36).slice(2, 7)}`;
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'Desk App', slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: {
        hostedPortalEnabled: opts.portal ?? true,
        authConfig: { ...(application.authConfig as object), oidcEnabled: true, ...opts.auth } as never,
      },
    });
    const clientId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/register`,
        payload: { redirect_uris: [REDIRECT, 'deskapp://callback'], client_name: 'Desk Client' },
      })
      .then((r) => (r.json() as { client_id: string }).client_id);
    return { slug, appId, operatorToken, publishableKey: application.publicKey, clientId };
  }

  function authorize(fx: Fixture, challenge: string, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: fx.clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid',
      state: 'st-123',
      ...extra,
    });
    return app.inject({ method: 'GET', url: `/api/v1/mcp/${fx.slug}/oauth/authorize?${q.toString()}` });
  }

  async function requestId(fx: Fixture, challenge: string): Promise<string> {
    const res = await authorize(fx, challenge);
    expect(res.statusCode).toBe(302);
    return new URL(res.headers.location as string).searchParams.get('request')!;
  }

  async function signIn(fx: Fixture, email: string, opts: { portal?: boolean; fingerprint?: string } = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${fx.publishableKey}`, ...(opts.portal && PORTAL) },
      payload: { email, password: PASSWORD, ...(opts.fingerprint && { device: { fingerprint: opts.fingerprint } }) },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data as { accessToken: string; endUser: { id: string } };
  }

  function portalCall(
    fx: Fixture,
    step: 'preview' | 'grant' | 'deny',
    payload: Record<string, unknown>,
    opts: { token?: string; caller?: boolean } = {},
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/authorize/${step}`,
      headers: {
        authorization: `Bearer ${fx.publishableKey}`,
        ...(opts.token && { 'x-rekey-user-token': opts.token }),
        ...(opts.caller !== false && PORTAL),
      },
      payload,
    });
  }

  function exchange(fx: Fixture, code: string, verifier: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
        client_id: fx.clientId,
      }).toString(),
    });
  }

  describe('the authorization endpoint', () => {
    it('sends the browser to the portal with only an opaque request id', async () => {
      const fx = await bootstrap();
      const res = await authorize(fx, pkce().challenge);
      expect(res.statusCode).toBe(302);
      const to = new URL(res.headers.location as string);
      expect(to.origin + to.pathname).toBe(`${PORTAL_ORIGIN}/${fx.slug}/authorize`);
      expect([...to.searchParams.keys()]).toEqual(['request']);
      expect(to.searchParams.get('request')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('renders the built-in page for an Application without the portal', async () => {
      const fx = await bootstrap({ portal: false });
      const res = await authorize(fx, pkce().challenge);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('name="password"');
    });

    it('prefers the Application’s own page when it has set one', async () => {
      const fx = await bootstrap({ auth: { hostedAuthorizeUrl: 'https://app.example.test/authorize' } });
      const res = await authorize(fx, pkce().challenge);
      expect(new URL(res.headers.location as string).origin).toBe('https://app.example.test');
    });

    it('still fails a bad request as a protocol error before the portal is involved', async () => {
      const fx = await bootstrap();
      const res = await authorize(fx, pkce().challenge, { code_challenge_method: 'plain' });
      const to = new URL(res.headers.location as string);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get('error')).toBe('invalid_request');
    });
  });

  describe('preview and grant with the portal credential', () => {
    it('describes the request, grants it once, and the code redeems only with the right verifier', async () => {
      const fx = await bootstrap();
      await makeEndUser(app, fx.operatorToken, fx.appId, 'ada@example.com');
      const { accessToken } = await signIn(fx, 'ada@example.com');
      const id = await requestId(fx, pkce().challenge);

      const preview = await portalCall(fx, 'preview', { request_id: id }, { token: accessToken });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        client_id: fx.clientId,
        client_name: 'Desk Client',
        redirect_uri: REDIRECT,
        scope: 'openid',
        account: { email: 'ada@example.com' },
        organizations: [],
      });

      const granted = await portalCall(fx, 'grant', { request_id: id }, { token: accessToken });
      expect(granted.statusCode).toBe(200);
      expect(granted.json().code).toBeUndefined();
      const to = new URL(granted.json().redirect_to as string);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get('state')).toBe('st-123');
      const code = to.searchParams.get('code')!;

      const again = await portalCall(fx, 'grant', { request_id: id }, { token: accessToken });
      expect(again.statusCode).toBe(400);
      expect(again.json().error.code).toBe('AUTHORIZATION_REQUEST_UNKNOWN');

      const wrong = await exchange(fx, code, pkce().verifier);
      expect(wrong.json().error).toBe('invalid_grant');

      const { verifier: v2, challenge: c2 } = pkce();
      const id2 = await requestId(fx, c2);
      const code2 = new URL(
        (await portalCall(fx, 'grant', { request_id: id2 }, { token: accessToken })).json().redirect_to as string,
      ).searchParams.get('code')!;
      const tokens = await exchange(fx, code2, v2);
      expect(tokens.statusCode).toBe(200);
      expect(tokens.json().id_token).toBeTruthy();
    });

    it('refuses a publishable key and user token without the caller secret', async () => {
      const fx = await bootstrap();
      await makeEndUser(app, fx.operatorToken, fx.appId, 'bob@example.com');
      const { accessToken } = await signIn(fx, 'bob@example.com');
      const id = await requestId(fx, pkce().challenge);
      for (const step of ['preview', 'grant'] as const) {
        const res = await portalCall(fx, step, { request_id: id }, { token: accessToken, caller: false });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('SESSION_HANDOFF_FORBIDDEN');
      }
    });

    it('refuses the portal credential naming a client directly instead of a stored request', async () => {
      const fx = await bootstrap();
      await makeEndUser(app, fx.operatorToken, fx.appId, 'cid@example.com');
      const { accessToken } = await signIn(fx, 'cid@example.com');
      const res = await portalCall(
        fx,
        'grant',
        {
          client_id: fx.clientId,
          redirect_uri: REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
          scope: 'openid',
        },
        { token: accessToken },
      );
      expect(res.statusCode).toBe(400);
      expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
    });

    it('refuses a user of another Application, and a request of another Application', async () => {
      const fx = await bootstrap();
      const other = await bootstrap();
      await makeEndUser(app, other.operatorToken, other.appId, 'eve@example.com');
      const { accessToken: foreign } = await signIn(other, 'eve@example.com');
      const id = await requestId(fx, pkce().challenge);
      const res = await portalCall(fx, 'grant', { request_id: id }, { token: foreign });
      expect(res.statusCode).toBe(401);

      const otherId = await requestId(other, pkce().challenge);
      await makeEndUser(app, fx.operatorToken, fx.appId, 'own@example.com');
      const { accessToken } = await signIn(fx, 'own@example.com');
      const crossed = await portalCall(fx, 'preview', { request_id: otherId }, { token: accessToken });
      expect(crossed.json().error.code).toBe('AUTHORIZATION_REQUEST_UNKNOWN');
    });

    it('refuses an expired request', async () => {
      const fx = await bootstrap();
      await makeEndUser(app, fx.operatorToken, fx.appId, 'late@example.com');
      const id = await requestId(fx, pkce().challenge);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 16 * 60 * 1000 });
      try {
        const { accessToken } = await signIn(fx, 'late@example.com');
        const res = await portalCall(fx, 'preview', { request_id: id }, { token: accessToken });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('AUTHORIZATION_REQUEST_UNKNOWN');
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses a user who has not set up two-factor when the Application requires it', async () => {
      const fx = await bootstrap({ auth: { mfa: 'required' } });
      await makeEndUser(app, fx.operatorToken, fx.appId, 'nomfa@example.com');
      const { accessToken } = await signIn(fx, 'nomfa@example.com');
      const id = await requestId(fx, pkce().challenge);
      for (const step of ['preview', 'grant'] as const) {
        const res = await portalCall(fx, step, { request_id: id }, { token: accessToken });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('MFA_ENROLLMENT_REQUIRED');
      }
      expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
    });
  });

  describe('deny', () => {
    it('sends access_denied and the state to the registered redirect URI, once', async () => {
      const fx = await bootstrap();
      const id = await requestId(fx, pkce().challenge);
      const res = await portalCall(fx, 'deny', { request_id: id });
      expect(res.statusCode).toBe(200);
      const to = new URL(res.json().redirect_to as string);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get('error')).toBe('access_denied');
      expect(to.searchParams.get('state')).toBe('st-123');
      expect(to.searchParams.get('code')).toBeNull();
      expect((await portalCall(fx, 'deny', { request_id: id })).json().error.code).toBe('AUTHORIZATION_REQUEST_UNKNOWN');
    });

    it('names a redirect URI the client no longer has as a cause', async () => {
      const fx = await bootstrap();
      const id = await requestId(fx, pkce().challenge);
      await prisma.oAuthClient.update({ where: { id: fx.clientId }, data: { redirectUris: ['deskapp://callback'] } });
      const { error } = (await portalCall(fx, 'deny', { request_id: id })).json() as {
        error: { code: string; message: string; fix: string };
      };
      expect(error.code).toBe('AUTHORIZATION_REQUEST_UNKNOWN');
      expect(error.message).toContain('redirect URI its client no longer has registered');
      expect(error.fix).toContain('register that URI for the client again');
    });

    it('answers only the portal', async () => {
      const fx = await bootstrap();
      const id = await requestId(fx, pkce().challenge);
      const bare = await portalCall(fx, 'deny', { request_id: id }, { caller: false });
      expect(bare.statusCode).toBe(403);
      const secretKey = await app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${fx.appId}/api-keys`,
          headers: { authorization: `Bearer ${fx.operatorToken}` },
          payload: { name: 'k', mode: 'live', scopes: ['*'] },
        })
        .then((r) => (r.json().data as { rawKey: string }).rawKey);
      const withSecret = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/authorize/deny`,
        headers: { authorization: `Bearer ${secretKey}`, ...PORTAL },
        payload: { request_id: id },
      });
      expect(withSecret.statusCode).toBe(403);
      // The request survives a refused deny.
      expect((await portalCall(fx, 'deny', { request_id: id })).statusCode).toBe(200);
    });

    it('sends nothing once the client no longer has that redirect URI', async () => {
      const fx = await bootstrap();
      const id = await requestId(fx, pkce().challenge);
      await prisma.oAuthClient.update({ where: { id: fx.clientId }, data: { redirectUris: ['deskapp://callback'] } });
      const res = await portalCall(fx, 'deny', { request_id: id });
      expect(res.statusCode).toBe(400);
      expect(res.json().redirect_to).toBeUndefined();
    });
  });

  describe('on an Application that requires a device binding', () => {
    it('still sends the browser to the portal, so the user sees why', async () => {
      const fx = await bootstrap({ auth: { deviceBinding: 'required' } });
      const to = new URL((await authorize(fx, pkce().challenge)).headers.location as string);
      expect(to.origin + to.pathname).toBe(`${PORTAL_ORIGIN}/${fx.slug}/authorize`);
    });

    it('refuses preview and grant from a portal session, minting nothing, and deny still answers the client', async () => {
      const fx = await bootstrap({ auth: { deviceBinding: 'required' } });
      const userId = await makeEndUser(app, fx.operatorToken, fx.appId, 'dev@example.com');
      const portalSession = await signIn(fx, 'dev@example.com', { portal: true });
      expect((jwt.decode(portalSession.accessToken) as { typ: string }).typ).toBe('eu_portal');
      const id = await requestId(fx, pkce().challenge);

      for (const step of ['preview', 'grant'] as const) {
        const res = await portalCall(fx, step, { request_id: id }, { token: portalSession.accessToken });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('AUTHORIZATION_NEEDS_DEVICE_SESSION');
        expect(res.json().error.details).toEqual({ client_name: 'Desk Client' });
      }
      expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { endUserId: userId, kind: 'mcp' } })).toBe(0);

      const denied = await portalCall(fx, 'deny', { request_id: id }, { token: portalSession.accessToken });
      expect(denied.statusCode).toBe(200);
      const to = new URL(denied.json().redirect_to as string);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get('error')).toBe('access_denied');
      expect(to.searchParams.get('state')).toBe('st-123');
    });

    it('allows the same user on the same Application from an ordinary session', async () => {
      const fx = await bootstrap({ auth: { deviceBinding: 'required' } });
      const userId = await makeEndUser(app, fx.operatorToken, fx.appId, 'dev2@example.com');
      const deviceSession = await signIn(fx, 'dev2@example.com', { fingerprint: 'fp-desk-laptop-0001' });
      const { verifier, challenge } = pkce();
      const id = await requestId(fx, challenge);
      expect((await portalCall(fx, 'preview', { request_id: id }, { token: deviceSession.accessToken })).statusCode).toBe(200);
      const granted = await portalCall(fx, 'grant', { request_id: id }, { token: deviceSession.accessToken });
      expect(granted.statusCode).toBe(200);
      const code = new URL(granted.json().redirect_to as string).searchParams.get('code')!;
      const tokens = await exchange(fx, code, verifier);
      expect(tokens.statusCode).toBe(200);
      // Tokens from the authorization server carry no device, whatever session approved them.
      expect((jwt.decode(tokens.json().access_token as string) as Record<string, unknown>).dev).toBeUndefined();
      expect(await prisma.refreshToken.count({ where: { endUserId: userId, kind: 'mcp', deviceId: null } })).toBe(1);
    });

    it('the built-in page signs nobody in there, since its sign-in would need a device', async () => {
      const fx = await bootstrap({ portal: false, auth: { deviceBinding: 'required' } });
      await makeEndUser(app, fx.operatorToken, fx.appId, 'builtin@example.com');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/authorize`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          response_type: 'code',
          client_id: fx.clientId,
          redirect_uri: REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
          scope: 'openid',
          consent: 'allow',
          email: 'builtin@example.com',
          password: PASSWORD,
        }).toString(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('requires a device binding');
      expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
    });
  });
});
