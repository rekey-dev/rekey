/**
 * Operator magic-link (passwordless email sign-in). A 15-min, single-use,
 * hash-only token minted by /tenant/auth/magic-link/request and consumed by
 * /verify (which mints a session). Enumeration-safe, the request never reveals
 * whether the email maps to an operator. Mirrors the password-reset + end-user
 * magic-link test shapes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('Operator magic-link sign-in', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  /** Create an operator (+ workspace) via password sign-up; return their email. */
  async function makeOperator(slug: string): Promise<string> {
    const email = `ml-${slug}@example.com`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    return email;
  }

  const request = (email: string) =>
    app.inject({ method: 'POST', url: '/api/v1/tenant/auth/magic-link/request', payload: { email } });
  const verify = (token: string) =>
    app.inject({ method: 'POST', url: '/api/v1/tenant/auth/magic-link/verify', payload: { token } });

  it('request returns a token for a known operator; verify mints a session', async () => {
    const email = await makeOperator('ok');
    const reqRes = await request(email);
    expect(reqRes.statusCode).toBe(200);
    const { delivered, token } = reqRes.json().data as { delivered: boolean; token: string | null };
    expect(delivered).toBe(true);
    expect(token).toBeTruthy();

    const verifyRes = await verify(token!);
    expect(verifyRes.statusCode).toBe(200);
    const data = verifyRes.json().data as {
      mfaRequired: boolean;
      accessToken?: string;
      refreshToken?: string;
      activeRole?: string;
    };
    expect(data.mfaRequired).toBe(false);
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.activeRole).toBe('OWNER');
  });

  it('is enumeration-safe: unknown email returns the same body, not just the same shape', async () => {
    // This assertion used to read `delivered: false`, under this same name,
    // pinning the oracle it claimed to rule out. A known address answered
    // `true` and an unknown one `false`, so one request per address enumerated
    // the deployment's operators. `delivered` is now constant; see
    // `CONSTANT_MAGIC_LINK_RESPONSE` in tenant-auth.service.ts.
    const res = await request('nobody-here@example.com');
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { delivered: boolean; token: string | null };
    expect(data.delivered).toBe(true);
    expect(data.token).toBeNull();
  });

  it('is single-use: a second verify with the same token is refused', async () => {
    const email = await makeOperator('single');
    const token = await request(email).then((r) => (r.json().data as { token: string }).token);

    expect((await verify(token)).statusCode).toBe(200);
    const second = await verify(token);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('MAGIC_LINK_TOKEN_USED');
  });

  it('rejects an expired token', async () => {
    const email = await makeOperator('expired');
    const token = await request(email).then((r) => (r.json().data as { token: string }).token);
    // Force expiry (only this token exists, the suite truncates per test).
    await prisma.tenantMagicLinkToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await verify(token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('MAGIC_LINK_TOKEN_EXPIRED');
  });
});
