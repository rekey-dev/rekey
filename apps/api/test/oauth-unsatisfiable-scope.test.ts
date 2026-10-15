/**
 * A scope request that names nothing the Application can grant is refused as
 * `invalid_scope`. Only a request naming no scope at all falls back to
 * `mcp:account`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { REDIRECT, pkce, oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('an unsatisfiable non-empty scope request is invalid_scope', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, registerClient } = oidcApplicationWorld(() => app);

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

});
