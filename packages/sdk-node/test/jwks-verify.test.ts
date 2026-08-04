/**
 * Offline access-token verification (`verifyAccessToken`) — unit tests
 * against a locally generated RSA keypair. Hermetic: JWKS "fetches" are a
 * stubbed `fetch`; tokens are signed with node:crypto directly (no
 * jsonwebtoken dependency — pins the raw JWS wire format).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHash,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { verifyAccessToken, _clearJwksCacheForTests, RekeyError } from '../src/index.js';

// ---------------------------------------------------------------------------
// Key + token fixtures
// ---------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

function makeKeypair(): { privateKey: KeyObject; jwk: Record<string, string>; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = publicKey.export({ format: 'jwk' }) as {
    kty: string;
    n: string;
    e: string;
  };
  // RFC 7638 thumbprint — matches the API's kid derivation.
  const kid = createHash('sha256')
    .update(JSON.stringify({ e: exported.e, kty: exported.kty, n: exported.n }))
    .digest('base64url');
  return {
    privateKey,
    kid,
    jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: exported.n, e: exported.e },
  };
}

const keyA = makeKeypair();
const keyB = makeKeypair(); // a second, UNpublished key — forged-token source
const jwks = { keys: [keyA.jwk] } as never;

function signRs256(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  kid: string,
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid, ...headerOverrides };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

const NOW = 1_750_000_000_000;
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    typ: 'eu_access',
    sub: 'user_1',
    applicationId: 'app_1',
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 900,
    ...overrides,
  };
}

const now = () => NOW;

beforeEach(() => {
  _clearJwksCacheForTests();
});

// ---------------------------------------------------------------------------

describe('verifyAccessToken — happy path', () => {
  it('verifies a valid RS256 token against an inline JWKS and returns the claims', async () => {
    const token = signRs256(claims({ oid: 'org_9' }), keyA.privateKey, keyA.kid);
    const verified = await verifyAccessToken(token, { jwks, now, applicationId: 'app_1' });
    expect(verified).toMatchObject({
      typ: 'eu_access',
      sub: 'user_1',
      applicationId: 'app_1',
      oid: 'org_9',
    });
  });

  it('verifies via jwksUrl and caches the fetch for subsequent calls', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [keyA.jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const token = signRs256(claims(), keyA.privateKey, keyA.kid);
    const opts = { jwksUrl: 'https://api.test/.well-known/jwks.json', fetch: fetchSpy, now, applicationId: 'app_1' };

    await verifyAccessToken(token, opts);
    await verifyAccessToken(token, opts);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // second verify hit the 5-min cache
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.test/.well-known/jwks.json');
  });

  it('refetches the JWKS once when the kid is unknown to the cached copy (rotation)', async () => {
    const stale = new Response(JSON.stringify({ keys: [keyB.jwk] }), { status: 200 });
    const fresh = new Response(JSON.stringify({ keys: [keyB.jwk, keyA.jwk] }), { status: 200 });
    const fetchSpy = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(fresh);
    const opts = { jwksUrl: 'https://api.test/.well-known/jwks.json', fetch: fetchSpy, now, applicationId: 'app_1' };

    // Prime the cache with the stale set…
    await verifyAccessToken(signRs256(claims(), keyB.privateKey, keyB.kid), opts);
    // …then a token under the newly minted key forces one refetch.
    const verified = await verifyAccessToken(signRs256(claims(), keyA.privateKey, keyA.kid), opts);

    expect(verified.sub).toBe('user_1');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('verifyAccessToken — rejections', () => {
  it('rejects an expired token with USER_TOKEN_EXPIRED', async () => {
    const token = signRs256(
      claims({ exp: Math.floor(NOW / 1000) - 10 }),
      keyA.privateKey,
      keyA.kid,
    );
    await expect(verifyAccessToken(token, { jwks, now, applicationId: 'app_1' })).rejects.toMatchObject({
      code: 'USER_TOKEN_EXPIRED',
    });
  });

  it('rejects the wrong typ (an MFA challenge token must never pass as a session)', async () => {
    const token = signRs256(claims({ typ: 'eu_mfa_challenge' }), keyA.privateKey, keyA.kid);
    await expect(verifyAccessToken(token, { jwks, now, applicationId: 'app_1' })).rejects.toMatchObject({
      code: 'USER_TOKEN_INVALID',
    });
  });

  it('rejects an HS256 token outright (TOKEN_ALG_NOT_RS256) — even one HMAC-signed with the public key', async () => {
    // Classic alg-confusion attempt: HMAC the token with the PUBLIC key bytes.
    const publicPem = createPublicKey({ key: keyA.jwk as never, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const header = { alg: 'HS256', typ: 'JWT', kid: keyA.kid };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims()))}`;
    const sig = createHmac('sha256', publicPem).update(signingInput).digest('base64url');
    await expect(verifyAccessToken(`${signingInput}.${sig}`, { jwks, now, applicationId: 'app_1' })).rejects.toMatchObject({
      code: 'TOKEN_ALG_NOT_RS256',
    });
  });

  it('rejects an unknown kid with TOKEN_KID_UNKNOWN', async () => {
    const token = signRs256(claims(), keyB.privateKey, keyB.kid); // keyB not in jwks
    await expect(verifyAccessToken(token, { jwks, now, applicationId: 'app_1' })).rejects.toMatchObject({
      code: 'TOKEN_KID_UNKNOWN',
    });
  });

  it('rejects a token signed by a DIFFERENT key claiming a known kid', async () => {
    const forged = signRs256(claims(), keyB.privateKey, keyA.kid); // kid spoofed to keyA
    await expect(verifyAccessToken(forged, { jwks, now, applicationId: 'app_1' })).rejects.toMatchObject({
      code: 'USER_TOKEN_INVALID',
    });
  });

  it('rejects a tampered payload (signature over different bytes)', async () => {
    const token = signRs256(claims(), keyA.privateKey, keyA.kid);
    const [h, , s] = token.split('.');
    const tampered = `${h}.${b64url(JSON.stringify(claims({ sub: 'user_evil' })))}.${s}`;
    await expect(verifyAccessToken(tampered, { jwks, now, applicationId: 'app_1' })).rejects.toMatchObject({
      code: 'USER_TOKEN_INVALID',
    });
  });

  it('rejects garbage with USER_TOKEN_INVALID and missing config with CONFIG_MISSING_JWKS', async () => {
    await expect(verifyAccessToken('not-a-jwt', { jwks, now, applicationId: 'app_1' })).rejects.toMatchObject({
      code: 'USER_TOKEN_INVALID',
    });
    const token = signRs256(claims(), keyA.privateKey, keyA.kid);
    await expect(verifyAccessToken(token, { now })).rejects.toBeInstanceOf(RekeyError);
    await expect(verifyAccessToken(token, { now })).rejects.toMatchObject({
      code: 'CONFIG_MISSING_JWKS',
    });
  });

  it('surfaces a non-200 JWKS endpoint as JWKS_FETCH_FAILED', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    const token = signRs256(claims(), keyA.privateKey, keyA.kid);
    await expect(
      verifyAccessToken(token, { jwksUrl: 'https://api.test/jwks', fetch: fetchSpy, now, applicationId: 'app_1' }),
    ).rejects.toMatchObject({ code: 'JWKS_FETCH_FAILED' });
  });
});

describe('verifyAccessToken — Application binding', () => {
  /**
   * The RS256 keypair is deployment-wide: `SigningKey` has no `applicationId`
   * column and `eu_access` tokens carry no `iss`/`aud`. So a token minted for a
   * DIFFERENT Application on the same deployment is cryptographically valid
   * here — signature, kid, expiry and `typ` all check out. Only the claim
   * comparison stops it.
   *
   * Note this does NOT apply to the HS256 default path, where the key is
   * derived per Application as `HMAC-SHA256(JWT_SECRET, appId:tokenGeneration)`
   * and a foreign token fails the signature outright. It applies precisely to
   * the path this function exists for.
   */
  it('refuses a validly-signed token minted for another Application', async () => {
    const token = signRs256(claims({ applicationId: 'app_OTHER' }), keyA.privateKey, keyA.kid);

    await expect(
      verifyAccessToken(token, { jwks, now, applicationId: 'app_1' }),
    ).rejects.toMatchObject({ code: 'USER_TOKEN_INVALID' });
  });

  it('accepts the same token for the Application it was minted for', async () => {
    const token = signRs256(claims({ applicationId: 'app_OTHER' }), keyA.privateKey, keyA.kid);

    const verified = await verifyAccessToken(token, {
      jwks,
      now,
      applicationId: 'app_OTHER',
    });

    expect(verified.applicationId).toBe('app_OTHER');
  });
});
