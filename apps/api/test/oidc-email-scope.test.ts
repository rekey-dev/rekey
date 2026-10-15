/**
 * The OIDC `email` scope is neither advertised nor granted unless the
 * Application requires verified email, and an unproven address is omitted
 * rather than shipped as `email_verified: false`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { decodeJwt, oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('the `email` scope requires requireEmailVerification', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, seedUser, registerClient, grant } = oidcApplicationWorld(() => app);

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

  it('never ships `email_verified: false`, an unproven address is omitted, not flagged', async () => {
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
