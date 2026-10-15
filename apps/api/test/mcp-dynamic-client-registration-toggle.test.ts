/**
 * An Application's dynamic client registration can be closed: registration
 * 403s, neither discovery document advertises it, and clients that already
 * registered keep working.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { REDIRECT, oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('dynamic client registration is a toggle', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, setAuthConfig, seedUser, registerClient, grant } = oidcApplicationWorld(() => app);

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
