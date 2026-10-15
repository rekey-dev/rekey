/**
 * An operator, an Application with an App URL and its keys, plus the calls the
 * end-user sign-up and OIDC provider suites share: sign up, sign in, patch the
 * auth config, seed a verified user, register an OAuth client and run the
 * authorize form through to tokens.
 *
 * Domain tables truncate before each test, so each case bootstraps its own.
 */

import { expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { prisma } from '../src/lib/prisma.js';

export const PASSWORD = 'pw-one-two-three';
export const REDIRECT = 'http://localhost:9876/cb';

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function form(payload: Record<string, string>): {
  headers: Record<string, string>;
  payload: string;
} {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  };
}

export function decodeJwt(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

export interface Fixture {
  slug: string;
  appId: string;
  liveKey: string;
  publishableKey: string;
  operatorToken: string;
}

export interface OidcApplicationWorld {
  bootstrap(authConfig?: Record<string, unknown>): Promise<Fixture>;
  signUp(fx: Fixture, email: string, extra?: Record<string, unknown>, key?: string): Promise<LightMyRequestResponse>;
  signIn(fx: Fixture, email: string): Promise<LightMyRequestResponse>;
  setAuthConfig(fx: Fixture, patch: Record<string, unknown>): Promise<LightMyRequestResponse>;
  seedUser(fx: Fixture, email: string, metadata?: Record<string, unknown>): Promise<string>;
  registerClient(fx: Fixture): Promise<string>;
  grant(fx: Fixture, args: { clientId: string; email: string; scope?: string }): Promise<Record<string, string>>;
}

/** `getApp` is read on every call, so the world can be built before `beforeAll` has booted the app. */
export function oidcApplicationWorld(getApp: () => FastifyInstance): OidcApplicationWorld {
  const app = { inject: (opts: InjectOptions) => getApp().inject(opts) };
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
    // Every fixture gets an App URL: requiring a verified email is refused
    // without one, because no verification link could be built.
    {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/auth-config`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { appUrl: 'https://app.example.com', ...authConfig },
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

  return { bootstrap, signUp, signIn, setAuthConfig, seedUser, registerClient, grant };
}
