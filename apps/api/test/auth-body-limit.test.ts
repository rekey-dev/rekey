/**
 * Per-route body caps on the credential tier (#555).
 *
 * Both rate checks on a credential route run at `preValidation`, and Fastify
 * parses the body between `onRequest` and `preValidation`, so neither one can
 * stop a 1 MiB sign-in body from being read and parsed first. `bodyLimit` is
 * the control that does: Fastify refuses on `Content-Length` before reading a
 * byte. These tests assert the caps on the wire, not the constants.
 *
 * The positive half matters as much as the negative one: a cap that refuses a
 * body the route's own schema accepts is a narrower API, not a tighter one.
 * So each class is also exercised with the largest payload its schema
 * permits: a full metadata blob at sign-up, a representative packed
 * attestation with a certificate chain at the passkey ceremony, twenty
 * maximum-length redirect_uris at client registration.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import {
  CLIENT_REGISTRATION_BODY_LIMIT,
  CREDENTIAL_BODY_LIMIT,
  SIGN_UP_BODY_LIMIT,
  TOKEN_BODY_LIMIT,
  WEBAUTHN_BODY_LIMIT,
} from '../src/lib/body-limits.js';
import { METADATA_MAX_BYTES } from '../src/lib/metadata-limit.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

/** A JSON body of exactly-ish `bytes` total, padded in one string field. */
function paddedBody(base: Record<string, unknown>, bytes: number): string {
  const skeleton = JSON.stringify({ ...base, pad: '' });
  const padding = Math.max(0, bytes - skeleton.length);
  return JSON.stringify({ ...base, pad: 'x'.repeat(padding) });
}

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; fix?: string; requestId?: string };
}

describe('credential routes cap their body size (#555)', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let slug: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    slug = `bl-${Math.random().toString(36).slice(2, 10)}`;
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T-${slug}`, ownerEmail: `${slug}@example.com` },
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
    applicationId = application.id;
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data.rawKey as string);
  });

  // ---------- the refusal ----------

  it('answers the API error envelope, not a bare Fastify 413', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      payload: paddedBody({ email: 'a@example.com', password: 'p' }, CREDENTIAL_BODY_LIMIT + 1),
    });

    expect(res.statusCode).toBe(413);
    const body = res.json() as ErrorEnvelope;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(body.error.fix).toBeTruthy();
    expect(body.error.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('never names the cap, in the message or the fix', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      payload: paddedBody({ email: 'a@example.com', password: 'p' }, CREDENTIAL_BODY_LIMIT + 1),
    });

    const { message, fix } = (res.json() as ErrorEnvelope).error;
    // A caller told the exact cap is a caller who can size a payload to sit
    // just inside it, on every route, without probing for the boundary.
    for (const text of [message, fix ?? '']) {
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/MiB|KiB|kB|bytes/i);
    }
    expect(fix).toMatch(/schema/i);
  });

  // Absolute sizes, on purpose. Every other case here is written against the
  // constants, which is right for asserting the contract but blind to the one
  // mutation that matters: raise a class back towards the global 1 MiB and a
  // `LIMIT + 1` body grows with it, so those tests keep passing. These do not.
  const CREDENTIAL = { email: 'a@example.com', password: 'p' };
  it.each<[string, number, Record<string, unknown>]>([
    ['/api/v1/auth/sign-in', 64 * 1024, CREDENTIAL],
    ['/api/v1/auth/sign-in', 512 * 1024, CREDENTIAL],
    ['/api/v1/tenant/auth/sign-in', 64 * 1024, CREDENTIAL],
    ['/api/v1/auth/sign-up', 256 * 1024, CREDENTIAL],
    ['/api/v1/auth/passkey/authenticate/complete', 256 * 1024, { response: {}, expectedChallenge: 'x' }],
    ['/api/v1/tenant/auth/oidc/assert', 64 * 1024, { idToken: 'j' }],
    ['MCP:/oauth/token', 128 * 1024, { grant_type: 'refresh_token', refresh_token: 'r' }],
    ['MCP:/oauth/register', 512 * 1024, { redirect_uris: ['https://x.test/cb'] }],
  ])('refuses a %s body of %d bytes outright', async (route, size, base) => {
    const url = route.startsWith('MCP:') ? `/api/v1/mcp/${slug}${route.slice(4)}` : route;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      payload: paddedBody(base, size),
    });
    expect(res.statusCode).toBe(413);
  });

  it('refuses before the handler: no row is written, no lockout is spent', async () => {
    const oversized = paddedBody(
      { email: 'victim@example.com', password: 'correct-horse-battery' },
      CREDENTIAL_BODY_LIMIT + 1,
    );

    // Far past authRateLimit(10) and past the brute-force lockout threshold.
    // If any of these reached a hook or a handler, the legitimate calls below
    // would be 429 or locked out.
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
        payload: oversized,
      });
      expect(res.statusCode).toBe(413);
    }

    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'victim@example.com', password: 'correct-horse-battery' },
    });
    expect(signUp.statusCode).toBe(201);

    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'victim@example.com', password: 'correct-horse-battery' },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it('writes nothing for an oversized sign-up', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      payload: paddedBody(
        { email: 'ghost@example.com', password: 'correct-horse-battery' },
        SIGN_UP_BODY_LIMIT + 1,
      ),
    });
    expect(res.statusCode).toBe(413);
    expect(await prisma.endUser.count({ where: { applicationId } })).toBe(0);
  });

  // ---------- the credential class (8 KiB) ----------

  it('lets an ordinary sign-in through', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'ok@example.com', password: 'correct-horse-battery' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: 'ok@example.com', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('accepts the largest body /auth/mfa-verify’s schema permits', async () => {
    // mfaChallengeToken 2048 + code 64 + device.fingerprint 256 + label 120,
    // every field at its schema maximum. The 401 is the point: the body was
    // parsed and validated, and only the credential inside it was wrong.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa-verify',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: {
        mfaChallengeToken: 'a'.repeat(2048),
        code: 'b'.repeat(64),
        device: { fingerprint: 'c'.repeat(256), label: 'd'.repeat(120) },
      },
    });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(401);
  });

  it('caps every credential sibling, not just sign-in', async () => {
    const oversized = CREDENTIAL_BODY_LIMIT + 1;
    const routes: Array<[string, Record<string, unknown>]> = [
      ['/api/v1/auth/forgot-password', { email: 'a@example.com' }],
      ['/api/v1/auth/magic-link/request', { email: 'a@example.com' }],
      ['/api/v1/auth/magic-link/verify', { token: 't' }],
      ['/api/v1/auth/reset-password', { token: 't', newPassword: 'correct-horse-battery' }],
      ['/api/v1/auth/verify-email', { token: 't' }],
      ['/api/v1/auth/resend-verification', { email: 'a@example.com' }],
      ['/api/v1/tenant/auth/sign-in', { email: 'a@example.com', password: 'p' }],
      ['/api/v1/tenant/auth/forgot-password', { email: 'a@example.com' }],
      ['/api/v1/tenant/auth/magic-link/request', { email: 'a@example.com' }],
      ['/api/v1/tenant/auth/reset-password', { token: 't', newPassword: 'correct-horse-b' }],
    ];

    for (const [url, base] of routes) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
        payload: paddedBody(base, oversized),
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 413 });
      expect((res.json() as ErrorEnvelope).error.code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  // ---------- the sign-up class (4 x METADATA_MAX_BYTES) ----------

  it('accepts a sign-up carrying metadata right up to METADATA_MAX_BYTES', async () => {
    // The route that must not 413 on a legal body: `metadata` is free-form and
    // capped at 16 KiB by assertMetadataWithinLimit, which answers 400
    // METADATA_TOO_LARGE past that. A caller at the ceiling must reach that
    // handler, not a 413 from the HTTP layer.
    const filler = 'm'.repeat(METADATA_MAX_BYTES - 200);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: {
        email: 'bulky@example.com',
        password: 'correct-horse-battery',
        metadata: { note: filler },
      },
    });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(201);
  });

  it('accepts that same ceiling sent \\uXXXX-escaped on the wire', async () => {
    // The ceiling and the cap count different bytes. assertMetadataWithinLimit
    // measures JSON.stringify of the merged object, which writes a character
    // literally; bodyLimit measures the wire, where a client that escapes
    // non-ASCII (Python's json.dumps does by default) spends 6 bytes on the
    // 2 UTF-8 bytes the ceiling charged. At 2 x METADATA_MAX_BYTES this body
    // was refused 413 by the HTTP layer although the ceiling accepts it.
    const ACCENTED = 'é'; // 2 bytes as UTF-8, 6 as é
    const chars = Math.floor((METADATA_MAX_BYTES - 200) / 2);
    const metadata = { note: ACCENTED.repeat(chars) };
    // Byte-count both sides, so the test states the gap rather than assuming it.
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf8')).toBeLessThanOrEqual(
      METADATA_MAX_BYTES,
    );
    const escaped = JSON.stringify({
      email: 'escaped@example.com',
      password: 'correct-horse-battery',
      metadata,
    }).replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(Buffer.byteLength(escaped, 'utf8')).toBeGreaterThan(2 * METADATA_MAX_BYTES);
    expect(Buffer.byteLength(escaped, 'utf8')).toBeLessThanOrEqual(SIGN_UP_BODY_LIMIT);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      payload: escaped,
    });
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(201);
  });

  // ---------- the WebAuthn class (32 KiB) ----------

  /**
   * A representative packed attestation with an AIK certificate chain, the
   * large end of what a real authenticator sends. Around 7 KB once base64url
   * encoded, which is what sets WEBAUTHN_BODY_LIMIT.
   */
  function representativeAttestation(): Record<string, unknown> {
    const b64 = (n: number): string => Buffer.alloc(n, 0x41).toString('base64url');
    return {
      id: b64(32),
      rawId: b64(32),
      type: 'public-key',
      clientExtensionResults: { credProps: { rk: true }, largeBlob: { supported: true } },
      response: {
        // authData (37 + attested credential data) + a two-certificate x5c
        // chain, which is where nearly all the bytes are.
        attestationObject: b64(5 * 1024),
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: 'webauthn.create',
            challenge: b64(32),
            origin: 'https://example.com',
            crossOrigin: false,
          }),
        ).toString('base64url'),
        transports: ['internal', 'hybrid'],
        publicKeyAlgorithm: -7,
        authenticatorData: b64(196),
        publicKey: b64(91),
      },
    };
  }

  it('lets a representative passkey attestation reach the handler', async () => {
    const payload = {
      response: representativeAttestation(),
      expectedChallenge: 'x'.repeat(1024),
    };
    const wire = Buffer.byteLength(JSON.stringify(payload));
    // The derivation, asserted: the realistic payload is well over the
    // credential class and well under the WebAuthn one.
    expect(wire).toBeGreaterThan(CREDENTIAL_BODY_LIMIT);
    expect(wire).toBeLessThan(WEBAUTHN_BODY_LIMIT / 2);

    // The unauthenticated half of the ceremony, so nothing refuses this at
    // `onRequest` and the cap is what is under test.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/authenticate/complete',
      headers: { authorization: `Bearer ${liveKey}` },
      payload,
    });
    expect(res.statusCode).not.toBe(413);
    // The body was parsed, validated and handled: the refusal is about the
    // challenge in it, not about its size or the key that carried it.
    expect((res.json() as ErrorEnvelope).error.code).toBe('WEBAUTHN_CHALLENGE_INVALID');
  });

  it('caps the passkey ceremony above its class', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/authenticate/complete',
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      payload: paddedBody(
        { response: {}, expectedChallenge: 'x' },
        WEBAUTHN_BODY_LIMIT + 1,
      ),
    });
    expect(res.statusCode).toBe(413);
  });

  it('caps the passkey ceremony well under the global 1 MiB limit', async () => {
    // The gap this issue is about: the old behaviour parsed everything up to
    // 1 MiB on these routes.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/passkey/authenticate/complete',
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      payload: paddedBody({ response: {}, expectedChallenge: 'x' }, 512 * 1024),
    });
    expect(res.statusCode).toBe(413);
  });

  // ---------- the token class (16 KiB) ----------

  it('accepts an 8192-character id token and refuses a body past the class', async () => {
    const legal = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/oidc/assert',
      payload: { idToken: 'j'.repeat(8192) },
    });
    // 8192 is the schema maximum for `idToken`; an 8 KiB cap would 413 it.
    expect(legal.statusCode).not.toBe(413);

    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/oidc/assert',
      headers: { 'content-type': 'application/json' },
      payload: paddedBody({ idToken: 'j' }, TOKEN_BODY_LIMIT + 1),
    });
    expect(oversized.statusCode).toBe(413);
  });

  it('caps the OAuth token endpoint, including its form body', async () => {
    const small = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'grant_type=authorization_code&code=abc&code_verifier=def&redirect_uri=https%3A%2F%2Fx.test%2Fcb',
    });
    expect(small.statusCode).not.toBe(413);

    const big = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/token`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=refresh_token&refresh_token=${'r'.repeat(TOKEN_BODY_LIMIT)}`,
    });
    expect(big.statusCode).toBe(413);
  });

  // ---------- the client-registration class (128 KiB) ----------

  it('accepts the largest legal RFC 7591 registration and refuses past it', async () => {
    // maxItems 20 x maxLength 2048, form-encoded, is what sets this class.
    const uris = Array.from({ length: 20 }, (_, i) => `https://c${i}.example.com/${'p'.repeat(2020)}`);
    const form = uris.map((u) => `redirect_uris=${encodeURIComponent(u)}`).join('&');
    // 20 x 2048 is 40 KiB of URIs before any escaping; percent-encoding adds
    // to that, by how much depends on how many reserved characters the URIs
    // carry, which is why the class sits several times above this figure.
    expect(Buffer.byteLength(form)).toBeGreaterThan(40 * 1024);
    expect(Buffer.byteLength(form)).toBeLessThan(CLIENT_REGISTRATION_BODY_LIMIT);

    const legal = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/register`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form,
    });
    expect(legal.statusCode).not.toBe(413);

    // A body that escapes heavily: the same 20 URIs would still be legal after
    // schema validation, and they must not be refused by the cap.
    const heavy = Array.from(
      { length: 20 },
      (_, i) => `https://c${i}.example.com/cb?${'a=b&c=d&'.repeat(250)}`,
    );
    const heavyForm = heavy.map((u) => `redirect_uris=${encodeURIComponent(u)}`).join('&');
    expect(Buffer.byteLength(heavyForm)).toBeLessThan(CLIENT_REGISTRATION_BODY_LIMIT);
    const heavyRes = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/register`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: heavyForm,
    });
    expect(heavyRes.statusCode).not.toBe(413);

    const oversized = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${slug}/oauth/register`,
      headers: { 'content-type': 'application/json' },
      payload: paddedBody({ redirect_uris: ['https://x.test/cb'] }, CLIENT_REGISTRATION_BODY_LIMIT + 1),
    });
    expect(oversized.statusCode).toBe(413);
  });

  // ---------- no collateral damage ----------

  it('leaves the global 1 MiB limit in place off the credential tier', async () => {
    // A route outside the tier still takes a large body; this change narrowed
    // the credential routes, not the API.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: { authorization: `Bearer ${ADMIN_KEY}`, 'content-type': 'application/json' },
      payload: paddedBody({ name: 'big', ownerEmail: 'big@example.com' }, 64 * 1024),
    });
    expect(res.statusCode).not.toBe(413);
  });
});
