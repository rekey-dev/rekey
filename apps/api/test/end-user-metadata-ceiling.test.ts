/**
 * The end-user metadata size ceiling holds on every route that writes it:
 * sign-up, the operator create and patch routes, and the HTTP body limit in
 * front of them. An over-long claim is dropped from id_token and userinfo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { OIDC_METADATA_NAMESPACE } from '../src/lib/oidc-profile.js';
import { METADATA_MAX_BYTES } from '../src/lib/metadata-limit.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { decodeJwt, oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('the metadata ceiling applies to every writer', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, signUp, seedUser, registerClient, grant } = oidcApplicationWorld(() => app);

  it('sign-up refuses an oversized blob instead of storing it forever', async () => {
    const fx = await bootstrap();
    // Just past the 16 KiB ceiling, and still inside SIGN_UP_BODY_LIMIT, so
    // the handler is the one that refuses and can say exactly why.
    const res = await signUp(fx, 'fat-signup@example.com', {
      metadata: { blob: 'x'.repeat(METADATA_MAX_BYTES + 1024) },
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

  it('a grossly oversized blob is refused at the HTTP layer, before the handler', async () => {
    const fx = await bootstrap();
    // Past SIGN_UP_BODY_LIMIT (#555): the route caps its body well under the
    // global 1 MiB, so a 200 KB blob never reaches the metadata check. A
    // different code for a different remedy: 413 says the request is too
    // big to read, 400 says this field will never fit. Neither stores a row.
    const res = await signUp(fx, 'huge-signup@example.com', {
      metadata: { blob: 'x'.repeat(200 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(
      await prisma.endUser.count({
        where: { applicationId: fx.appId, email: 'huge-signup@example.com' },
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
