/**
 * An erased end user is refused on the whole OAuth surface: MCP tool calls,
 * the refresh grant, a code minted before the erasure, and the erasure itself
 * deletes their MCP refresh tokens and pending codes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { PASSWORD, REDIRECT, pkce, form, type Fixture, oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('an erased end-user is refused at every OAuth/OIDC door', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, seedUser, registerClient, grant } = oidcApplicationWorld(() => app);

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
