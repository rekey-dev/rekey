/**
 * An ID Token is never usable as an access token: the profile claim allowlist
 * cannot name a token-authenticating claim, issueIdToken strips such claims,
 * and the MCP endpoint rejects an ID Token presented as a bearer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { PROFILE_METADATA_CLAIMS } from '../src/lib/oidc-profile.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { decodeJwt, oidcApplicationWorld } from './oidc-application-world.js';

operatorsConfirmTheirEmail();

describe('id_token-as-access-token stays blocked structurally', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const { bootstrap, seedUser, registerClient, grant } = oidcApplicationWorld(() => app);

  it('the profile claim allowlist can never name a token-authenticating claim', async () => {
    // `PROFILE_METADATA_CLAIMS` is sourced from `EndUser.metadata`. If any of
    // these names entered it, an operator could
    // put `typ: "mcp_access"` and another Application's `applicationId`
    // into an ID Token, which is signed by the same deployment and would
    // then pass `verifyMcpAccessToken`. That is cross-application account
    // takeover, gated today by this list and nothing else.
    const forbidden = ['typ', 'applicationId', 'gen', 'sub', 'iss', 'aud', 'exp', 'iat', 'scope'];
    for (const claim of forbidden) {
      expect(PROFILE_METADATA_CLAIMS as readonly string[], claim).not.toContain(claim);
    }
  });

  it('issueIdToken strips them even if a caller passes them explicitly', async () => {
    // The structural half of the same defence: widening `IssueIdTokenArgs.claims`
    // must not be able to reintroduce the hole either.
    const { issueIdToken } = await import('../src/lib/jwt.js');
    const { getActiveSigningKey } = await import('../src/lib/signing-keys.js');
    const key = await getActiveSigningKey();
    const { token } = issueIdToken({
      issuer: 'https://issuer.test.invalid/api/v1/mcp/x',
      endUserId: 'eu_real',
      clientId: 'client_1',
      key,
      authTime: new Date(),
      claims: {
        typ: 'mcp_access',
        applicationId: 'app_victim',
        gen: 99,
        scope: 'mcp:account',
        sub: 'eu_attacker',
        name: 'Ada',
      },
    });
    const claims = decodeJwt(token);
    expect(claims.typ).toBeUndefined();
    expect(claims.applicationId).toBeUndefined();
    expect(claims.gen).toBeUndefined();
    expect(claims.scope).toBeUndefined();
    // `sub` is the argument's, never the caller's claims bag.
    expect(claims.sub).toBe('eu_real');
    expect(claims.name).toBe('Ada');
  });

  it('an ID Token is still rejected as a bearer token on the MCP endpoint', async () => {
    const fx = await bootstrap({ mcpEnabled: true, oidcEnabled: true });
    const clientId = await registerClient(fx);
    await seedUser(fx, 'substitution@example.com');
    const tokens = await grant(fx, {
      clientId,
      email: 'substitution@example.com',
      scope: 'openid mcp:account',
    });
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}`,
      headers: {
        authorization: `Bearer ${tokens.id_token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(r.statusCode).toBe(401);
  });
});
