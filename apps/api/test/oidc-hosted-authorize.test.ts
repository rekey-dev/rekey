/**
 * Delegating the sign-in half of the OIDC authorize flow to the Application's
 * own page (`authConfig.hostedAuthorizeUrl`).
 *
 * The built-in authorize page accepts an email and a password, which is the
 * right default for a deployment with no front end and a dead end for an
 * Application whose users sign in with Google: they have no password, so the
 * form cannot be satisfied and the only way through is a password reset on an
 * account that has none.
 *
 * Setting `hostedAuthorizeUrl` redirects the browser to the Application's own
 * login page instead, which already has whatever sign-in methods it offers and
 * already knows whether this browser is signed in. That page finishes the flow
 * through `POST /oauth/authorize/grant`, which already existed.
 *
 * What is pinned here: the redirect happens, it carries the request intact, it
 * happens only AFTER the protocol checks, and it cannot be turned into a loop.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

interface Bootstrapped {
  applicationId: string;
  slug: string;
  tenantAccess: string;
  clientId: string;
  redirectUri: string;
}

describe('OIDC authorize: delegating sign-in to the Application', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(name: string, hostedAuthorizeUrl?: string): Promise<Bootstrapped> {
    const ts = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-hosted-${name}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${name}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const slug = `hosted-${name}`;
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: `App ${name}`, slug },
      })
      .then((r) => r.json().data as { id: string });

    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          methods: ['password'],
          passwordMinLength: 8,
          redirectUrls: [],
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
          // The authorization-server surface is gated per Application by
          // `oidcEnabled` / `mcpEnabled` (resolveAuthServerApp); without one of
          // them every route in this file 404s.
          oidcEnabled: true,
          ...(hostedAuthorizeUrl !== undefined && { hostedAuthorizeUrl }),
        } as never,
      },
    });

    const redirectUri = 'https://client.example.test/callback';
    // `OAuthClient.id` IS the client_id; there is no separate column.
    const client = await prisma.oAuthClient.create({
      data: {
        id: `cid-hosted-${name}`,
        applicationId: application.id,
        clientName: 'Test client',
        redirectUris: [redirectUri],
      },
      select: { id: true },
    });

    return {
      applicationId: application.id,
      slug,
      tenantAccess: ts.accessToken,
      clientId: client.id,
      redirectUri,
    };
  }

  function authorizeUrl(b: Bootstrapped, extra: Record<string, string> = {}): string {
    const q = new URLSearchParams({
      client_id: b.clientId,
      redirect_uri: b.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: 'state-xyz',
      code_challenge: 'ANhtOvQtRVAso5807cQECbPdkneuOokykaQqP6zUe5s',
      code_challenge_method: 'S256',
      ...extra,
    });
    return `/api/v1/mcp/${b.slug}/oauth/authorize?${q.toString()}`;
  }

  it('renders the built-in password page when no hosted URL is set', async () => {
    const b = await bootstrap('builtin');
    const res = await app.inject({ method: 'GET', url: authorizeUrl(b) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('name="password"');
  });

  it('redirects to the Application page when one is set, carrying the request intact', async () => {
    const b = await bootstrap('delegate', 'https://app.example.test/oauth/authorize');
    const res = await app.inject({ method: 'GET', url: authorizeUrl(b) });
    expect(res.statusCode).toBe(302);

    const to = new URL(res.headers.location as string);
    expect(to.origin + to.pathname).toBe('https://app.example.test/oauth/authorize');
    // Every parameter the client sent must survive, or the page cannot hand the
    // request back to /oauth/authorize/grant.
    expect(to.searchParams.get('client_id')).toBe(b.clientId);
    expect(to.searchParams.get('redirect_uri')).toBe(b.redirectUri);
    expect(to.searchParams.get('state')).toBe('state-xyz');
    expect(to.searchParams.get('scope')).toBe('openid email profile');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    // And no password form was rendered.
    expect(res.body).not.toContain('name="password"');
  });

  it('preserves any query the Application page already carries', async () => {
    const b = await bootstrap('query', 'https://app.example.test/oauth/authorize?tenant=acme');
    const res = await app.inject({ method: 'GET', url: authorizeUrl(b) });
    const to = new URL(res.headers.location as string);
    expect(to.searchParams.get('tenant')).toBe('acme');
    expect(to.searchParams.get('client_id')).toBe(b.clientId);
  });

  it('refuses to delegate to its own authorize path, which would loop forever', async () => {
    const b = await bootstrap(
      'loop',
      'https://api.example.test/api/v1/mcp/hosted-loop/oauth/authorize',
    );
    const res = await app.inject({ method: 'GET', url: authorizeUrl(b) });
    // Falls back to the built-in page rather than bouncing the browser.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="password"');
  });

  it('rejects a non-URL at the config write, which is where it is reachable', async () => {
    // The read path also guards (see `hostedAuthorizeTarget`), but it never
    // gets the chance: `AuthConfigSchema` parses on read, so a malformed stored
    // value would take the whole authorize route down rather than degrade. The
    // guarantee that actually holds is that such a value cannot be stored.
    const b = await bootstrap('reject');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { hostedAuthorizeUrl: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('can be set through the auth-config endpoint the panel uses, and cleared again', async () => {
    // The panel field posts to this route, whose body is `.strict()`. Declaring
    // the key on AuthConfigSchema is NOT enough: it must also be listed here,
    // and it was not, so saving the field answered "Unrecognized key(s) in
    // object: 'hostedAuthorizeUrl'" and the feature was unreachable in
    // production despite every other layer working.
    const b = await bootstrap('via-api');
    const patch = (value: string | null): ReturnType<FastifyInstance['inject']> =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { hostedAuthorizeUrl: value },
      });

    const set = await patch('https://app.example.test/oauth/authorize');
    expect(set.statusCode).toBe(200);
    expect(set.json().data.authConfig.hostedAuthorizeUrl).toBe(
      'https://app.example.test/oauth/authorize',
    );

    // And it takes effect on the authorize endpoint, not just in storage.
    const delegated = await app.inject({ method: 'GET', url: authorizeUrl(b) });
    expect(delegated.statusCode).toBe(302);

    // Clearing turns the delegation back off and restores the built-in page.
    const cleared = await patch('');
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.authConfig.hostedAuthorizeUrl).toBeUndefined();

    const builtin = await app.inject({ method: 'GET', url: authorizeUrl(b) });
    expect(builtin.statusCode).toBe(200);
    expect(builtin.body).toContain('name="password"');
  });

  it('still rejects a bad authorization request before delegating', async () => {
    const b = await bootstrap('protocol', 'https://app.example.test/oauth/authorize');

    // Unknown client: must be the API's own 400, never the customer's page.
    const unknownClient = await app.inject({
      method: 'GET',
      url: authorizeUrl(b, { client_id: 'nope' }),
    });
    expect(unknownClient.statusCode).toBe(400);

    // Unregistered redirect_uri: same reasoning.
    const badRedirect = await app.inject({
      method: 'GET',
      url: authorizeUrl(b, { redirect_uri: 'https://evil.example.test/steal' }),
    });
    expect(badRedirect.statusCode).toBe(400);
  });
});
