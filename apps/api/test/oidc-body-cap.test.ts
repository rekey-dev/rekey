/**
 * The OIDC issuer URL is set by a tenant's operator, so the server answering
 * discovery, token and userinfo is not one Rekey trusts. Those bodies used to be
 * read with `res.json()`, which buffers whatever arrives within the 10 second
 * timeout into memory every tenant shares. The read is now capped: past the
 * limit it stops pulling and the exchange fails.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcProvider, __resetForTests } from '../src/modules/oauth/providers/oidc.js';
import { MAX_PROVIDER_RESPONSE_BYTES } from '../src/modules/oauth/providers/_oauth2-base.js';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'client-abc';
const CHUNK_BYTES = 64 * 1024;

const config = {
  clientId: CLIENT_ID,
  clientSecret: 'shh',
  redirectUri: 'https://panel.test/login/oauth/rekey/callback',
  issuerUrl: ISSUER,
};

const discoveryDoc = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
};

function idToken(): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = { sub: 'user-1', iss: ISSUER, aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 300 };
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.signature`;
}

/**
 * A body that never ends on its own: every pull enqueues another chunk of
 * whitespace, up to 64 MB. `pulled()` says how much the reader actually asked
 * for, which is the thing the cap has to bound.
 */
function endlessBody(): { res: Response; pulled: () => number } {
  let pulled = 0;
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= 64 * 1024 * 1024) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return {
    res: new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }),
    pulled: () => pulled,
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const exchange = (): Promise<unknown> => new OidcProvider().exchange({ config, code: 'auth-code' });

afterEach(() => {
  vi.unstubAllGlobals();
  __resetForTests();
});

describe('OIDC response body cap', () => {
  it('stops reading an oversized discovery document and fails the exchange', async () => {
    const body = endlessBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/.well-known/openid-configuration')) return body.res;
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await expect(exchange()).rejects.toThrow(/exceeded 1048576 bytes/);
    // Bounded by the cap plus the chunk that crossed it and one the stream may
    // have queued ahead, nowhere near the 64 MB on offer.
    expect(body.pulled()).toBeGreaterThan(MAX_PROVIDER_RESPONSE_BYTES);
    expect(body.pulled()).toBeLessThanOrEqual(MAX_PROVIDER_RESPONSE_BYTES + 2 * CHUNK_BYTES);
  });

  it('stops reading an oversized token response too', async () => {
    const body = endlessBody();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/.well-known/openid-configuration')) return json(discoveryDoc);
        if (url.endsWith('/token')) return body.res;
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await expect(exchange()).rejects.toThrow(/exceeded 1048576 bytes/);
    expect(body.pulled()).toBeLessThanOrEqual(MAX_PROVIDER_RESPONSE_BYTES + 2 * CHUNK_BYTES);
  });

  it('still accepts a body of exactly the limit', async () => {
    const doc = JSON.stringify(discoveryDoc);
    const padded = doc + ' '.repeat(MAX_PROVIDER_RESPONSE_BYTES - Buffer.byteLength(doc));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/.well-known/openid-configuration')) {
          return new Response(padded, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/token')) return json({ id_token: idToken() });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    await expect(exchange()).resolves.toMatchObject({ providerAccountId: 'user-1' });
  });
});
