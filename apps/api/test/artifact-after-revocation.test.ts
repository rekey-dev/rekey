/**
 * Things that are not sessions yet but turn into one.
 *
 * A claim, a password change and sign-out everywhere end every session, and a
 * session written afterwards on an older credential is refused
 * (claim-session-race.test.ts). An authorization code is one step removed: it
 * is written by a request that signed in a moment ago, and exchanged later
 * for a full grant. Written after the revocation, on a sign-in from before
 * it, it would hand the first registrant access, refresh and ID tokens.
 */

import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { issueMagicLinkToken } from '../src/lib/magic-link.js';
import { mcpOAuthService } from '../src/modules/mcp/oauth.service.js';
import { operatorMcpOAuthService } from '../src/modules/tenant-mcp/oauth.service.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

const RACERS = 8;
const ROUNDS = 5;
const PASSWORD = 'squatter-pw-one-two-three';
const REDIRECT = 'https://rp.example.test/callback';
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function form(payload: Record<string, string>): { headers: Record<string, string>; payload: string } {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  };
}

describe('An authorization code written after every session was ended', () => {
  operatorsConfirmTheirEmail();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface World {
    slug: string;
    applicationId: string;
    clientId: string;
    publishableKey: string;
    operatorToken: string;
    operatorId: string;
    tenantId: string;
  }

  async function world(): Promise<World> {
    const slug = `code-${Math.random().toString(36).slice(2, 8)}`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `op-${slug}@example.com`, password: 'Xk9-operator-pw-one-two', workspaceName: slug },
    });
    const data = signUp.json().data as { accessToken: string; user: { id: string }; activeTenantId: string };
    const operator = { authorization: `Bearer ${data.accessToken}` };
    const applicationId = await app
      .inject({ method: 'POST', url: '/api/v1/tenant/applications/', headers: operator, payload: { name: slug, slug } })
      .then((r) => (r.json().data as { id: string }).id);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: operator,
      payload: { oidcEnabled: true, methods: ['password', 'magic_link'], appUrl: 'https://app.example.com' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const clientId = await app
      .inject({ method: 'POST', url: `/api/v1/mcp/${slug}/oauth/register`, payload: { redirect_uris: [REDIRECT], client_name: 'RP' } })
      .then((r) => (r.json() as { client_id: string }).client_id);
    const publishableKey = await prisma.application
      .findUniqueOrThrow({ where: { id: applicationId }, select: { publicKey: true } })
      .then((a) => a.publicKey);
    return {
      slug,
      applicationId,
      clientId,
      publishableKey,
      operatorToken: data.accessToken,
      operatorId: data.user.id,
      tenantId: data.activeTenantId,
    };
  }

  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };

  /** The squatter posts the authorize form with the password they registered the address with. */
  async function authorize(w: World, email: string): Promise<{ response: LightMyRequestResponse; verifier: string }> {
    const { verifier, challenge } = pkce();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${w.slug}/oauth/authorize`,
      ...form({
        response_type: 'code',
        client_id: w.clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'openid email',
        state: 'xyz',
        email,
        password: PASSWORD,
        consent: 'allow',
      }),
    });
    return { response, verifier };
  }

  const codeFrom = (res: LightMyRequestResponse): string | null =>
    res.statusCode === 302 ? new URL(res.headers.location as string).searchParams.get('code') : null;

  const exchange = (w: World, code: string, verifier: string): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${w.slug}/oauth/token`,
      ...form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: w.clientId }),
    });

  async function squatter(w: World, email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${w.publishableKey}` },
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { endUser: { id: string } }).endUser.id;
  }

  async function ownerProvesTheMailbox(w: World, endUserId: string, email: string): Promise<void> {
    const link = await issueMagicLinkToken({ applicationId: w.applicationId, endUserId, email });
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      headers: { authorization: `Bearer ${w.publishableKey}` },
      payload: { token: link.raw },
    });
    expect(verified.statusCode, verified.body).toBe(200);
  }

  it('end user: the claim lands between the squatter\'s sign-in and the code, and the code is never written', async () => {
    const w = await world();
    const email = 'victim@example.com';
    const endUserId = await squatter(w, email);
    const create = mcpOAuthService.createAuthCode.bind(mcpOAuthService);
    let claimed = false;
    vi.spyOn(mcpOAuthService, 'createAuthCode').mockImplementation(async (args) => {
      // The form's sign-in has succeeded. The owner's sign-in link commits now.
      await ownerProvesTheMailbox(w, endUserId, email);
      claimed = true;
      return create(args);
    });
    const { response, verifier } = await authorize(w, email);
    expect(claimed, 'the sign-in on the form succeeded and reached the code step').toBe(true);
    const code = codeFrom(response);
    if (code !== null) {
      const tokens = await exchange(w, code, verifier);
      expect(tokens.statusCode, `the squatter exchanged a code for tokens: ${tokens.body}`).toBe(400);
    }
    expect(code, 'no code is handed to the first registrant').toBeNull();
    expect(await prisma.oAuthAuthCode.count({ where: { endUserId } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { endUserId, kind: 'mcp' } })).toBe(0);
    expect(response.statusCode, 'the form is shown again').toBe(200);
    expect(response.body).toContain('Sign in again');
  });

  it('end user: a code that reached the table from before the claim is refused at exchange', async () => {
    const w = await world();
    const email = 'victim@example.com';
    const endUserId = await squatter(w, email);
    const { response, verifier } = await authorize(w, email);
    const code = codeFrom(response);
    expect(code).toBeTruthy();
    // The claim deletes unspent codes. Put this one back as if its insert had
    // slipped past: the exchange has to refuse it by itself.
    const row = await prisma.oAuthAuthCode.findFirstOrThrow({ where: { endUserId } });
    await ownerProvesTheMailbox(w, endUserId, email);
    expect(await prisma.oAuthAuthCode.count({ where: { endUserId } })).toBe(0);
    await prisma.oAuthAuthCode.create({ data: row });
    const tokens = await exchange(w, code!, verifier);
    expect(tokens.statusCode, tokens.body).toBe(400);
    expect((tokens.json() as { error: string }).error).toBe('invalid_grant');
    expect(await prisma.refreshToken.count({ where: { endUserId, kind: 'mcp' } })).toBe(0);
  });

  it(`end user: ${RACERS} authorize posts racing a claim over HTTP leave the squatter no grant`, async () => {
    const w = await world();
    for (let round = 0; round < ROUNDS; round += 1) {
      const email = `victim-${round}@example.com`;
      const endUserId = await squatter(w, email);
      const racers = Array.from({ length: RACERS }, () => authorize(w, email));
      await pause(20 + round * 40);
      await ownerProvesTheMailbox(w, endUserId, email);
      const settled = await Promise.all(racers);
      for (const { response, verifier } of settled) {
        const code = codeFrom(response);
        if (code === null) continue;
        const tokens = await exchange(w, code, verifier);
        expect(tokens.statusCode, `round ${round}: a racer's code became tokens`).toBe(400);
      }
      expect(await prisma.refreshToken.count({ where: { endUserId, kind: 'mcp', revokedAt: null } }), `round ${round}`).toBe(0);
    }
  }, 120_000);

  it('a sign-in on the form with nothing in between still gets its code and its tokens', async () => {
    const w = await world();
    const email = 'honest@example.com';
    await squatter(w, email);
    const { response, verifier } = await authorize(w, email);
    const code = codeFrom(response);
    expect(code, response.body.slice(0, 300)).toBeTruthy();
    const tokens = await exchange(w, code!, verifier);
    expect(tokens.statusCode, tokens.body).toBe(200);
    expect(tokens.json()).toHaveProperty('id_token');
  });

  describe('operator', () => {
    const OP_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

    async function client(): Promise<string> {
      const registered = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/register',
        payload: { redirect_uris: [OP_REDIRECT] },
      });
      return (registered.json() as { client_id: string }).client_id;
    }

    const grant = (w: World, clientId: string, challenge: string): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/grant',
        headers: { authorization: `Bearer ${w.operatorToken}` },
        payload: {
          client_id: clientId,
          redirect_uri: OP_REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:operator:read',
          tenant_id: w.tenantId,
          approve: true,
        },
      });

    const redeem = (clientId: string, code: string, verifier: string): Promise<LightMyRequestResponse> =>
      app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/token',
        payload: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: OP_REDIRECT, client_id: clientId },
      });

    const signOutEverywhere = async (w: World): Promise<void> => {
      const { tenantAuthService } = await import('../src/modules/tenant-auth/tenant-auth.service.js');
      await tenantAuthService.signOutEverywhere(w.operatorId);
    };

    it('sign-out everywhere lands between the session check and the code, and the grant is refused with 401', async () => {
      const w = await world();
      const clientId = await client();
      const { verifier, challenge } = pkce();
      const create = operatorMcpOAuthService.createAuthCode.bind(operatorMcpOAuthService);
      let ended = false;
      vi.spyOn(operatorMcpOAuthService, 'createAuthCode').mockImplementation(async (args) => {
        await signOutEverywhere(w);
        ended = true;
        return create(args);
      });
      const res = await grant(w, clientId, challenge);
      expect(ended).toBe(true);
      const redirect = (res.json() as { data?: { redirect?: string } }).data?.redirect;
      const code = redirect ? new URL(redirect).searchParams.get('code') : null;
      if (code) {
        const tokens = await redeem(clientId, code, verifier);
        expect(tokens.statusCode, `a stolen session turned into an MCP grant: ${tokens.body}`).toBe(400);
      }
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().error.code).toBe('TENANT_SESSION_INVALID');
      expect(await prisma.tenantOAuthAuthCode.count({ where: { tenantUserId: w.operatorId } })).toBe(0);
      expect(await prisma.tenantMcpRefreshToken.count({ where: { tenantUserId: w.operatorId } })).toBe(0);
    });

    it('a code that reached the table from before the revocation is refused at exchange', async () => {
      const w = await world();
      const clientId = await client();
      const { verifier, challenge } = pkce();
      const res = await grant(w, clientId, challenge);
      expect(res.statusCode, res.body).toBe(200);
      const code = new URL((res.json() as { data: { redirect: string } }).data.redirect).searchParams.get('code')!;
      await pause(5);
      await signOutEverywhere(w);
      const tokens = await redeem(clientId, code, verifier);
      expect(tokens.statusCode, tokens.body).toBe(400);
      expect(await prisma.tenantMcpRefreshToken.count({ where: { tenantUserId: w.operatorId } })).toBe(0);
    });

    it(`${RACERS} grants racing sign-out everywhere over HTTP leave no MCP grant behind`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const w = await world();
        const clientId = await client();
        const attempts = Array.from({ length: RACERS }, () => pkce());
        const racers = attempts.map(async (p, i) => {
          await pause(i);
          return grant(w, clientId, p.challenge);
        });
        await pause(2 + round);
        await signOutEverywhere(w);
        const settled = await Promise.all(racers);
        for (const [i, res] of settled.entries()) {
          const redirect = (res.json() as { data?: { redirect?: string } }).data?.redirect;
          const code = redirect ? new URL(redirect).searchParams.get('code') : null;
          if (!code) continue;
          const tokens = await redeem(clientId, code, attempts[i]!.verifier);
          expect(tokens.statusCode, `round ${round}: a racer's code became tokens`).toBe(400);
        }
        expect(await prisma.tenantMcpRefreshToken.count({ where: { tenantUserId: w.operatorId, revokedAt: null } })).toBe(0);
      }
    }, 120_000);

    it('an MCP refresh token spent before sign-out everywhere cannot be replayed to end the grant made afterwards', async () => {
      const w = await world();
      const clientId = await client();
      const connect = async (): Promise<{ access_token: string; refresh_token: string }> => {
        const { verifier, challenge } = pkce();
        const res = await grant(w, clientId, challenge);
        expect(res.statusCode, res.body).toBe(200);
        const code = new URL((res.json() as { data: { redirect: string } }).data.redirect).searchParams.get('code')!;
        const tokens = await redeem(clientId, code, verifier);
        expect(tokens.statusCode, tokens.body).toBe(200);
        return tokens.json() as { access_token: string; refresh_token: string };
      };
      const refreshWith = (refreshToken: string): Promise<LightMyRequestResponse> =>
        app.inject({
          method: 'POST',
          url: '/api/v1/tenant/mcp/oauth/token',
          payload: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
        });

      const before = await connect();
      expect((await refreshWith(before.refresh_token)).statusCode).toBe(200);
      const spent = before.refresh_token;
      await pause(5);
      await signOutEverywhere(w);
      await pause(5);
      // The owner signs in again and connects the same client.
      const signIn = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-in',
        payload: { email: (await prisma.tenantUser.findUniqueOrThrow({ where: { id: w.operatorId } })).email, password: 'Xk9-operator-pw-one-two' },
      });
      w.operatorToken = (signIn.json().data as { accessToken: string }).accessToken;
      const after = await connect();

      const replay = await refreshWith(spent);
      expect(replay.statusCode).toBe(400);
      expect((replay.json() as { error_description: string }).error_description).not.toContain('revoked as a precaution');
      const stillGood = await refreshWith(after.refresh_token);
      expect(stillGood.statusCode, `the grant made after the revocation was ended by a replay: ${stillGood.body}`).toBe(200);

      // Reuse of a token from the current grant still ends that grant.
      const theft = await refreshWith(after.refresh_token);
      expect(theft.statusCode).toBe(400);
      expect((theft.json() as { error_description: string }).error_description).toContain('revoked as a precaution');
      expect(await prisma.tenantMcpRefreshToken.count({ where: { tenantUserId: w.operatorId, revokedAt: null } })).toBe(0);
    });

    it('a grant with nothing in between still gets its code and its tokens', async () => {
      const w = await world();
      const clientId = await client();
      const { verifier, challenge } = pkce();
      const res = await grant(w, clientId, challenge);
      const code = new URL((res.json() as { data: { redirect: string } }).data.redirect).searchParams.get('code')!;
      const tokens = await redeem(clientId, code, verifier);
      expect(tokens.statusCode, tokens.body).toBe(200);
    });
  });
});
