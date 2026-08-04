/**
 * Request-deadline tests, against a real socket that accepts the connection and
 * then says nothing forever.
 *
 * A stubbed `fetch` cannot prove this. The bug being guarded against was that
 * the SDK passed no `signal` at all, so the effective timeout was undici's
 * `headersTimeout` — five minutes. A review measured a call still pending at
 * 70 seconds. Nothing in a fetch stub reproduces that; only a socket does.
 *
 * The second half of the file pins the OTHER half of the same bug: there was no
 * try/catch around `fetch`, so a connection refused escaped as a bare
 * `TypeError`. Every consumer following the documented
 * `catch (e) { if (e instanceof RekeyError) … }` pattern silently missed it.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { Rekey, RekeyError, verifyAccessToken, DEFAULT_TIMEOUT_MS } from '../src/index.js';

let server: net.Server;
let blackHoleUrl: string;
const sockets: net.Socket[] = [];

beforeAll(async () => {
  // Accept, then never write a byte. TCP-level silence, not a 5xx.
  server = net.createServer((s) => sockets.push(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  blackHoleUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  for (const s of sockets) s.destroy();
  server.close();
});

function client(overrides: Partial<ConstructorParameters<typeof Rekey>[0]> = {}): Rekey {
  return new Rekey({ apiUrl: blackHoleUrl, secretKey: 'rp_test_x', ...overrides });
}

async function caught(fn: () => Promise<unknown>): Promise<RekeyError> {
  try {
    await fn();
  } catch (e) {
    return e as RekeyError;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('request deadline against a black-hole server', () => {
  it('gives up at the configured deadline instead of hanging', async () => {
    const started = Date.now();
    const err = await caught(() => client({ timeoutMs: 250 }).applications.me());
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(RekeyError);
    expect(err.code).toBe('REQUEST_TIMEOUT');
    // The point of the test: bounded, and bounded near the number we asked for.
    expect(elapsed).toBeLessThan(3_000);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it('defaults to 10s — the same deadline the API uses for its own webhooks', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it('scopes a deadline to one call via with()', async () => {
    const rekey = client({ timeoutMs: 60_000 });
    const started = Date.now();
    const err = await caught(() => rekey.with({ timeoutMs: 200 }).applications.me());
    expect(err.code).toBe('REQUEST_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('scopes a deadline to one call via request()', async () => {
    const err = await caught(() =>
      client({ timeoutMs: 60_000 }).request('GET', '/api/v1/me/', { timeoutMs: 200 }),
    );
    expect(err.code).toBe('REQUEST_TIMEOUT');
  });

  it('reports a caller-initiated abort distinctly from a timeout', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const err = await caught(() => client({ timeoutMs: 30_000, signal: ac.signal }).applications.me());
    expect(err.code).toBe('REQUEST_ABORTED');
  });

  it('bounds the JWKS fetch inside verifyAccessToken', async () => {
    // Token verification usually sits in a hot request path; an unreachable
    // JWKS host must not stall it.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'u', exp: 9_999_999_999 })).toString(
      'base64url',
    );
    const started = Date.now();
    const err = await caught(() =>
      verifyAccessToken(`${header}.${payload}.sig`, {
        jwksUrl: `${blackHoleUrl}/.well-known/jwks.json`,
        timeoutMs: 250,
      }),
    );
    expect(err.code).toBe('REQUEST_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('transport failures become RekeyError', () => {
  it('maps a refused connection to NETWORK_ERROR, not a bare TypeError', async () => {
    // Port 1 is reliably refused and never listened on.
    const err = await caught(() =>
      new Rekey({ apiUrl: 'http://127.0.0.1:1', secretKey: 'rp_test_x' }).applications.me(),
    );
    expect(err).toBeInstanceOf(RekeyError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.fix).toBeTruthy();
  });

  it('keeps the original transport error on `cause` for debugging', async () => {
    const err = await caught(() =>
      new Rekey({ apiUrl: 'http://127.0.0.1:1', secretKey: 'rp_test_x' }).applications.me(),
    );
    expect(err.cause).toBeDefined();
  });

  it('is catchable by the documented instanceof pattern', async () => {
    // This is the whole contract: one catch clause covers server errors AND
    // the cases where no server answered.
    let handled = false;
    try {
      await new Rekey({ apiUrl: 'http://127.0.0.1:1', secretKey: 'rp_test_x' }).applications.me();
    } catch (e) {
      if (e instanceof RekeyError) handled = true;
    }
    expect(handled).toBe(true);
  });
});

describe('timeoutMs: 0 opts out', () => {
  it('sends no signal when the deadline is disabled and no caller signal exists', async () => {
    let sawSignal: unknown = 'unset';
    const rekey = new Rekey({
      apiUrl: 'https://example.invalid',
      secretKey: 'rp_test_x',
      timeoutMs: 0,
      fetch: (async (_u: string, init: RequestInit) => {
        sawSignal = init.signal;
        return new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    await rekey.applications.me();
    expect(sawSignal).toBeUndefined();
  });

  it('still attaches a signal when the deadline is disabled but a caller signal exists', async () => {
    let sawSignal: unknown = 'unset';
    const ac = new AbortController();
    const rekey = new Rekey({
      apiUrl: 'https://example.invalid',
      secretKey: 'rp_test_x',
      timeoutMs: 0,
      signal: ac.signal,
      fetch: (async (_u: string, init: RequestInit) => {
        sawSignal = init.signal;
        return new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });
    await rekey.applications.me();
    expect(sawSignal).toBe(ac.signal);
  });
});
