/**
 * JWKS / RS256 end-user access tokens (ENTERPRISE-ROADMAP #1).
 *
 * Pins the v1 contract:
 *   - `GET /.well-known/jwks.json` is public, RFC 7517-shaped, cacheable.
 *   - Apps that opt in via `authConfig.tokenAlg = "RS256"` mint access tokens
 *     with an RS256 header + kid that verify against the published JWKS.
 *   - HS256 apps (the default) are completely unaffected.
 *   - Alg-confusion attempts are refused in BOTH directions: an HS256 token
 *     wearing an RSA kid never reaches the JWKS path, and an RS256 token with
 *     an unknown/spoofed kid never verifies.
 *   - The per-app kill-switch (tokenGeneration bump) still revokes RS256
 *     tokens (via the `gen` claim) even though the RSA key is deployment-wide.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac, createPublicKey, generateKeyPairSync, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { applicationsService } from '../src/modules/applications/applications.service.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface BootstrappedApp {
  applicationId: string;
  liveKey: string;
}

function b64urlJson<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

describe('JWKS / RS256 end-user access tokens', () => {
  let app: FastifyInstance;
  let hsApp: BootstrappedApp; // default HS256 app
  let rsApp: BootstrappedApp; // opted into RS256

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrapApplication(slug: string): Promise<BootstrappedApp> {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T-${slug}`, ownerEmail: `t-${slug}@example.com` },
      })
      .then((r) => r.json().data as { id: string });

    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: slug, slug },
      })
      .then((r) => r.json().data as { id: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    return { applicationId: application.id, liveKey: key.rawKey };
  }

  beforeEach(async () => {
    hsApp = await bootstrapApplication('jwks-hs');
    rsApp = await bootstrapApplication('jwks-rs');
    // Per-app opt-in — exercises the same updateAuthConfig path the
    // PATCH /tenant/applications/:id/auth-config route calls.
    await applicationsService.updateAuthConfig({
      applicationId: rsApp.applicationId,
      patch: { tokenAlg: 'RS256' },
    });
  });

  async function signUp(boot: BootstrappedApp, email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${boot.liveKey}` },
      payload: { email, password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { accessToken: string }).accessToken;
  }

  async function usersMe(boot: BootstrappedApp, token: string) {
    return app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${boot.liveKey}`, 'x-relipay-user-token': token },
    });
  }

  async function fetchJwks(): Promise<{
    res: Awaited<ReturnType<FastifyInstance['inject']>>;
    keys: Array<{ kty: string; kid: string; alg: string; use: string; n: string; e: string }>;
  }> {
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    return { res, keys: (res.json() as { keys: never[] }).keys };
  }

  // ---------- the endpoint ----------

  it('GET /.well-known/jwks.json is public, RFC 7517 shaped, and cacheable for 5 minutes', async () => {
    const { res, keys } = await fetchJwks();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const key of keys) {
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      expect(key.kid).toMatch(/^[\w-]+$/); // base64url RFC 7638 thumbprint
      expect(key.n.length).toBeGreaterThan(300); // 2048-bit modulus
      expect(key.e).toBe('AQAB');
      expect(key).not.toHaveProperty('d'); // never the private half
    }
    // Raw JWKS body — NOT the { success, data } envelope (jose/jwks-rsa compat).
    expect(res.json()).not.toHaveProperty('success');

    // Stable across calls — same active key, same kid.
    const again = await fetchJwks();
    expect(again.keys.map((k) => k.kid)).toEqual(keys.map((k) => k.kid));
  });

  // ---------- issuance ----------

  it('HS256 apps are unaffected: default alg, no kid, sessions still resolve', async () => {
    const token = await signUp(hsApp, 'hs@example.com');
    const header = b64urlJson<JwtHeader>(token.split('.')[0]!);
    expect(header.alg).toBe('HS256');
    expect(header.kid).toBeUndefined();

    const me = await usersMe(hsApp, token);
    expect(me.statusCode).toBe(200);
    expect((me.json().data as { email: string }).email).toBe('hs@example.com');
  });

  it('an RS256-enabled app mints kid-stamped tokens that verify against the JWKS', async () => {
    const token = await signUp(rsApp, 'rs@example.com');
    const [h, p, s] = token.split('.');
    const header = b64urlJson<JwtHeader>(h!);
    expect(header.alg).toBe('RS256');
    expect(typeof header.kid).toBe('string');

    // The kid must be published…
    const { keys } = await fetchJwks();
    const jwk = keys.find((k) => k.kid === header.kid);
    expect(jwk).toBeDefined();

    // …and the signature must verify OFFLINE against that public key alone.
    const publicKey = createPublicKey({
      key: { kty: 'RSA', n: jwk!.n, e: jwk!.e },
      format: 'jwk',
    });
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${h}.${p}`, 'utf8'),
      publicKey,
      Buffer.from(s!, 'base64url'),
    );
    expect(ok).toBe(true);

    const claims = b64urlJson<Record<string, unknown>>(p!);
    expect(claims.typ).toBe('eu_access');
    expect(claims.applicationId).toBe(rsApp.applicationId);
    expect(typeof claims.sub).toBe('string');
    expect(typeof claims.exp).toBe('number');

    // The API itself accepts it too (both /users/me and the key-less /auth/me).
    const me = await usersMe(rsApp, token);
    expect(me.statusCode).toBe(200);
    const authMe = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { 'x-relipay-user-token': token },
    });
    expect(authMe.statusCode).toBe(200);
  });

  it('refresh mints an RS256 access token for an RS256 app', async () => {
    const signUpRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${rsApp.liveKey}` },
      payload: { email: 'rs-refresh@example.com', password: 'correct-horse-battery' },
    });
    const { refreshToken } = signUpRes.json().data as { refreshToken: string };

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${rsApp.liveKey}` },
      payload: { refreshToken },
    });
    expect(refreshRes.statusCode).toBe(200);
    const fresh = (refreshRes.json().data as { accessToken: string }).accessToken;
    expect(b64urlJson<JwtHeader>(fresh.split('.')[0]!).alg).toBe('RS256');
    expect((await usersMe(rsApp, fresh)).statusCode).toBe(200);
  });

  it('flipping tokenAlg back to HS256 does not break outstanding RS256 tokens', async () => {
    const rsToken = await signUp(rsApp, 'rs-flip@example.com');
    await applicationsService.updateAuthConfig({
      applicationId: rsApp.applicationId,
      patch: { tokenAlg: 'HS256' },
    });
    // Old RS256 token still verifies (the API accepts both algs)…
    expect((await usersMe(rsApp, rsToken)).statusCode).toBe(200);
    // …while NEW tokens are HS256 again.
    const hsToken = await signUp(rsApp, 'rs-flip-2@example.com');
    expect(b64urlJson<JwtHeader>(hsToken.split('.')[0]!).alg).toBe('HS256');
  });

  // ---------- alg confusion / forgery ----------

  it('rejects an HS256 token HMAC-signed with the published RSA public key (classic confusion)', async () => {
    // Attacker downloads the JWKS, reconstructs the public PEM, and HMACs a
    // token with it — hoping the verifier feeds the public key to HS256.
    const { keys } = await fetchJwks();
    const jwk = keys[0]!;
    const publicPem = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: jwk.kid }),
      'utf8',
    ).toString('base64url');
    const victim = await prisma.endUser.create({
      data: { applicationId: rsApp.applicationId, email: 'victim@example.com', passwordHash: 'x' },
    });
    const payload = Buffer.from(
      JSON.stringify({
        typ: 'eu_access',
        sub: victim.id,
        applicationId: rsApp.applicationId,
        gen: 1,
        iat: now,
        exp: now + 900,
      }),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', publicPem).update(`${header}.${payload}`).digest('base64url');

    const res = await usersMe(rsApp, `${header}.${payload}.${sig}`);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
  });

  it('rejects an RS256 token signed by an attacker keypair claiming a known kid', async () => {
    const { keys } = await fetchJwks();
    const knownKid = keys[0]!.kid;
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: knownKid }),
      'utf8',
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        typ: 'eu_access',
        sub: 'user_whoever',
        applicationId: rsApp.applicationId,
        gen: 1,
        iat: now,
        exp: now + 900,
      }),
      'utf8',
    ).toString('base64url');
    const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`, 'utf8'), privateKey)
      .toString('base64url');

    const res = await usersMe(rsApp, `${header}.${payload}.${sig}`);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an RS256 token with an unknown kid, and one with no kid at all', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        typ: 'eu_access',
        sub: 'user_x',
        applicationId: rsApp.applicationId,
        gen: 1,
        iat: now,
        exp: now + 900,
      }),
      'utf8',
    ).toString('base64url');

    for (const headerObj of [
      { alg: 'RS256', typ: 'JWT', kid: 'kid-that-does-not-exist' },
      { alg: 'RS256', typ: 'JWT' }, // kid missing entirely
    ]) {
      const header = Buffer.from(JSON.stringify(headerObj), 'utf8').toString('base64url');
      const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`, 'utf8'), privateKey)
        .toString('base64url');
      const res = await usersMe(rsApp, `${header}.${payload}.${sig}`);
      expect(res.statusCode).toBe(401);
    }
  });

  it('refuses an RS256 token of app A presented through app B (cross-app guard intact)', async () => {
    const token = await signUp(rsApp, 'rs-cross@example.com');
    const res = await usersMe(hsApp, token);
    expect(res.statusCode).toBe(401);
  });

  // ---------- kill-switch parity ----------

  it('bumping tokenGeneration revokes outstanding RS256 tokens (gen claim)', async () => {
    const token = await signUp(rsApp, 'rs-kill@example.com');
    expect((await usersMe(rsApp, token)).statusCode).toBe(200);

    await prisma.application.update({
      where: { id: rsApp.applicationId },
      data: { tokenGeneration: { increment: 1 } },
    });

    const res = await usersMe(rsApp, token);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
  });
});
