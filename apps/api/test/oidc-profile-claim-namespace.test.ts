/**
 * The OIDC profile claims (preferred_username, name, picture) are read from a
 * metadata namespace only an operator can write. An end user who could set
 * them could impersonate another account at every relying party.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { PROFILE_METADATA_CLAIMS, OIDC_METADATA_NAMESPACE } from '../src/lib/oidc-profile.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { decodeJwt, oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('profile claims come from an operator-only namespace', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, signUp, seedUser, registerClient, grant } = oidcApplicationWorld(() => app);

  it('a self-service PATCH cannot set preferred_username, name or picture', async () => {
    const fx = await bootstrap({ oidcEnabled: true });
    const created = await signUp(fx, 'impersonator@example.com');
    const { accessToken } = created.json().data as { accessToken: string };
    const clientId = await registerClient(fx);

    // The exact payload from the report. Writing the claim NAMES at the top
    // level is still allowed, they are the app's own fields, so the write
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
