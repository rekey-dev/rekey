/**
 * Error envelope, over real HTTP.
 *
 * Assembled on a minimal Fastify instance that mirrors app.ts's wiring
 * (formbody + rate limiter + the media-type gate + `rekeyErrorHandler`)
 * instead of `buildApp()`. The pieces under test are the framework seams —
 * the rate-limit plugin's error path, Fastify's own content-type and
 * validation errors, and the hook stage the auth limiter runs at — and pinning
 * them here keeps the assertions about *those* rather than about whichever
 * route happened to be convenient. The per-route caps are also raised to
 * effectively-infinite under NODE_ENV=test in lib/rate-limit.ts, so a real
 * 429 cannot be provoked through buildApp() at all.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import formbody from '@fastify/formbody';
import { rekeyErrorHandler } from '../src/lib/error.js';
import { requestIdFor } from '../src/lib/request-id.js';
import {
  authCeilingKey,
  authRateLimitKey,
  rateLimitError,
  rateLimitedAfter,
  wantsAuthCeiling,
  AUTH_CEILING_MARKER,
} from '../src/lib/rate-limit.js';
import { rejectUnsupportedMediaType } from '../src/middleware/media-type.js';

interface Envelope {
  success: false;
  error: {
    code: string;
    message: string;
    fix?: string;
    retryAfterSeconds?: number;
    requestId?: string;
  };
}

interface HarnessOptions {
  /** Global limiter cap. Large enough to be irrelevant unless a test lowers it. */
  globalMax?: number;
  /** Tight per-identity cap on the /sign-in stand-in. */
  authMax?: number;
  /** Per-Application ceiling across auth routes. */
  ceilingMax?: number;
}

let app: FastifyInstance | null = null;

/** app.ts's error-relevant wiring, minus everything that needs a database. */
async function harness(options: HarnessOptions = {}): Promise<FastifyInstance> {
  const instance = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: (req) => requestIdFor(req.headers as Record<string, unknown>),
  });

  await instance.register(rateLimit, {
    max: options.globalMax ?? 1_000_000,
    timeWindow: 60_000,
    skipOnError: true,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: rateLimitError,
  });
  await instance.register(formbody);
  instance.setErrorHandler(rekeyErrorHandler);

  instance.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Request-Id', _req.id);
  });
  instance.addHook('onRequest', rejectUnsupportedMediaType);

  const ceiling = instance.createRateLimit({
    max: options.ceilingMax ?? 1_000_000,
    timeWindow: 60_000,
    keyGenerator: authCeilingKey,
  });
  instance.addHook('preValidation', async (req) => {
    if (!wantsAuthCeiling(req.routeOptions?.config?.rateLimit)) return;
    const result = await ceiling(req);
    if (result.isAllowed || !result.isExceeded) return;
    throw rateLimitedAfter(result.ttl, result.max);
  });

  // Stand-in for POST /api/v1/auth/sign-in: same limiter config shape, same
  // schema shape. `authRateLimit()` itself is neutered under NODE_ENV=test, so
  // the config is spelled out here with a real cap.
  instance.post(
    '/sign-in',
    {
      config: {
        rateLimit: {
          max: options.authMax ?? 1_000_000,
          timeWindow: 60_000,
          hook: 'preValidation',
          keyGenerator: authRateLimitKey,
          [AUTH_CEILING_MARKER]: true,
        },
      },
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string' }, password: { type: 'string' } },
        },
      },
    },
    async () => ({ success: true }),
  );

  instance.post('/plain', async () => ({ success: true }));

  // Dependency-outage stand-ins: the shapes Prisma and ioredis actually throw.
  instance.get('/boom/postgres', async () => {
    throw Object.assign(new Error('Can\'t reach database server at db:5432'), { code: 'P1001' });
  });
  instance.get('/boom/redis', async () => {
    throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
  });
  instance.get('/boom/bug', async () => {
    throw new Error('cannot read properties of undefined');
  });

  // Stand-in for the MCP OAuth token endpoint: RFC 6749 mandates form encoding.
  instance.post('/oauth/token', { config: { acceptsForm: true } }, async (req) => ({
    grant: (req.body as { grant_type?: string }).grant_type,
  }));

  await instance.ready();
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = null;
});

function signIn(instance: FastifyInstance, email: string) {
  return instance.inject({
    method: 'POST',
    url: '/sign-in',
    payload: { email, password: 'correct-horse-battery' },
  });
}

// ---------- Item 1: the 429 body ----------

describe('429 responses', () => {
  it('emit RATE_LIMITED with an accurate fix and retryAfterSeconds', async () => {
    const instance = await harness({ authMax: 1 });
    await signIn(instance, 'a@example.com');
    const blocked = await signIn(instance, 'a@example.com');

    expect(blocked.statusCode).toBe(429);
    const body = blocked.json() as Envelope;
    // Measured before this change:
    //   {"code":"BAD_REQUEST","message":"Rate limit exceeded, retry in 54 seconds",
    //    "fix":"Check the request shape against the route schema in /docs."}
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.fix).toMatch(/Retry-After/);
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.requestId).toBeTruthy();
  });

  it('keep the Retry-After and x-ratelimit-* headers consistent with the body', async () => {
    const instance = await harness({ authMax: 1 });
    await signIn(instance, 'a@example.com');
    const blocked = await signIn(instance, 'a@example.com');

    const body = blocked.json() as Envelope;
    expect(Number(blocked.headers['retry-after'])).toBe(body.error.retryAfterSeconds);
    expect(blocked.headers['x-ratelimit-limit']).toBeDefined();
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('come from the global limiter too', async () => {
    const instance = await harness({ globalMax: 1 });
    await instance.inject({ method: 'POST', url: '/plain' });
    const blocked = await instance.inject({ method: 'POST', url: '/plain' });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as Envelope).error.code).toBe('RATE_LIMITED');
  });
});

// ---------- Item 3: per-identity auth buckets ----------

describe('auth rate limiter', () => {
  it('does not lock out a second end user when the first exhausts the cap', async () => {
    // The bug: sign-in requires the Application secret key, so `keyGenerator:
    // req.apiKey?.id ?? req.ip` put every end user of one app in ONE 10/60s
    // bucket — an attacker burning it locked out everyone for the window.
    const instance = await harness({ authMax: 2 });
    expect((await signIn(instance, 'victim@example.com')).statusCode).toBe(200);
    expect((await signIn(instance, 'victim@example.com')).statusCode).toBe(200);
    expect((await signIn(instance, 'victim@example.com')).statusCode).toBe(429);

    // A different identity is untouched.
    expect((await signIn(instance, 'bystander@example.com')).statusCode).toBe(200);
  });

  it('still throttles the identity being guessed', async () => {
    const instance = await harness({ authMax: 2 });
    await signIn(instance, 'victim@example.com');
    await signIn(instance, 'victim@example.com');
    // Case differences must not mint a fresh bucket.
    expect((await signIn(instance, 'VICTIM@Example.com')).statusCode).toBe(429);
  });

  it('keeps a per-Application ceiling so rotating identities is not unlimited', async () => {
    const instance = await harness({ authMax: 1_000_000, ceilingMax: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await signIn(instance, `user-${i}@example.com`)).statusCode).toBe(200);
    }
    const blocked = await signIn(instance, 'user-4@example.com');
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as Envelope).error.code).toBe('RATE_LIMITED');
  });

  it('does not 500 when the body is absent or malformed', async () => {
    // keyGenerator reads req.body at preValidation, before schema validation.
    const instance = await harness({ authMax: 5 });
    const noBody = await instance.inject({ method: 'POST', url: '/sign-in' });
    expect(noBody.statusCode).toBe(400);
    expect((noBody.json() as Envelope).error.code).toBe('BAD_REQUEST');

    const arrayBody = await instance.inject({
      method: 'POST',
      url: '/sign-in',
      payload: [1, 2, 3],
    });
    expect(arrayBody.statusCode).toBe(400);
    expect((arrayBody.json() as Envelope).error.code).toBe('BAD_REQUEST');
  });

  it('leaves the ceiling alone on routes that did not ask for it', async () => {
    const instance = await harness({ ceilingMax: 1 });
    await instance.inject({ method: 'POST', url: '/plain' });
    expect((await instance.inject({ method: 'POST', url: '/plain' })).statusCode).toBe(200);
  });
});

// ---------- Item 2: dependency outages ----------

describe('dependency outages', () => {
  it('return 503 DEPENDENCY_UNAVAILABLE instead of a generic 500', async () => {
    const instance = await harness();
    const res = await instance.inject({ method: 'GET', url: '/boom/postgres' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Envelope;
    expect(body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(body.error.fix).toMatch(/\/health\/ready/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('distinguish Redis-down from Postgres-down', async () => {
    // These two responses used to be byte-identical INTERNAL_ERROR bodies, so a
    // self-hosting operator had no way to know which service to go look at.
    const instance = await harness();
    const pg = (
      (await instance.inject({ method: 'GET', url: '/boom/postgres' })).json() as Envelope
    ).error;
    const redis = (
      (await instance.inject({ method: 'GET', url: '/boom/redis' })).json() as Envelope
    ).error;
    expect(pg.message).toMatch(/PostgreSQL/);
    expect(redis.message).toMatch(/Redis/);
    expect(pg.message).not.toBe(redis.message);
  });

  it('leak no host, port, or connection string from the underlying error', async () => {
    const instance = await harness();
    const res = await instance.inject({ method: 'GET', url: '/boom/postgres' });
    // The thrown error said "Can't reach database server at db:5432".
    expect(res.body).not.toMatch(/db:5432|5432/);
  });

  it('leave a genuine application bug as INTERNAL_ERROR', async () => {
    const instance = await harness();
    const res = await instance.inject({ method: 'GET', url: '/boom/bug' });
    expect(res.statusCode).toBe(500);
    expect((res.json() as Envelope).error.code).toBe('INTERNAL_ERROR');
  });
});

// ---------- Item 4: request ids ----------

describe('request ids', () => {
  it('are on the X-Request-Id header of a successful response', async () => {
    const instance = await harness();
    const res = await signIn(instance, 'a@example.com');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-request-id']).not.toMatch(/^req-/);
  });

  it('match the envelope requestId, and differ between requests', async () => {
    const instance = await harness();
    const first = await instance.inject({ method: 'POST', url: '/sign-in', payload: {} });
    const second = await instance.inject({ method: 'POST', url: '/sign-in', payload: {} });
    expect((first.json() as Envelope).error.requestId).toBe(first.headers['x-request-id']);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  it('honour an inbound id, sanitised', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/sign-in',
      headers: { 'x-request-id': 'trace-abc123\nINJECTED' },
      payload: {},
    });
    expect(res.headers['x-request-id']).toBe('trace-abc123INJECTED');
    expect((res.json() as Envelope).error.requestId).toBe('trace-abc123INJECTED');
  });
});

// ---------- Item 5: 415 ----------

describe('unsupported media types', () => {
  it('return 415 UNSUPPORTED_MEDIA_TYPE for a form body on a JSON route', async () => {
    // Previously: formbody parsed it, then schema validation reported
    // "body must have required property 'email'" — for a request that sent it.
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/sign-in',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'a@example.com', password: 'pw' }).toString(),
    });
    expect(res.statusCode).toBe(415);
    const body = res.json() as Envelope;
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(body.error.fix).toBe('Send Content-Type: application/json');
    expect(body.error.message).not.toMatch(/required property/);
  });

  it('ignore charset parameters and header casing', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/sign-in',
      headers: { 'content-type': 'Application/X-WWW-Form-UrlEncoded; charset=UTF-8' },
      payload: 'email=a%40example.com',
    });
    expect(res.statusCode).toBe(415);
  });

  it('let a route opt in — the MCP OAuth endpoints need form bodies', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'refresh_token' }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ grant: 'refresh_token' });
  });

  it('do not fire on an empty POST that carries no body', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/plain',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('do not pre-empt a 404 with a 415', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/nope',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    });
    expect(res.statusCode).toBe(404);
  });

  it('cover text/plain — which Fastify parses, so it used to 400 as "not an object"', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/sign-in',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ email: 'a@example.com', password: 'pw' }),
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as Envelope).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('normalise Fastify’s own 415 (no parser at all) to the same code', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as Envelope).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('accept a +json vendor media type', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/plain',
      headers: { 'content-type': 'application/vnd.rekey+json' },
      payload: '{"a":1}',
    });
    // Fastify has no parser registered for the vendor type, so it answers its
    // own 415 — but our gate must not be the thing that rejected it.
    expect((res.json() as Envelope).error.message).not.toMatch(/does not accept/);
  });
});

// ---------- Item 6: no FST_ERR_* leakage ----------

describe('Fastify-internal codes', () => {
  it('never appear as the public code for schema validation', async () => {
    const instance = await harness();
    const res = await instance.inject({ method: 'POST', url: '/sign-in', payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Envelope;
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.code).not.toMatch(/^FST_ERR/);
  });

  it('never appear as the public code for a malformed JSON body', async () => {
    const instance = await harness();
    const res = await instance.inject({
      method: 'POST',
      url: '/sign-in',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Envelope;
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.code).not.toMatch(/^FST_ERR/);
    expect(body.error.fix).toMatch(/JSON/);
  });
});

/**
 * The envelope is only guaranteed where `RekeyError` is used, and until now
 * nothing enforced that.
 *
 * Three routes built the envelope by hand and so never reached
 * `rekeyErrorHandler`: `POST …/applications/:id/licenses` (404), `POST
 * …/applications/:id/end-users` (409), and `GET /api/v1/tenant/mcp` (405).
 * Each therefore returned neither the `requestId` field nor the
 * `X-Request-Id` header — and an external audit found the first of them as the
 * single envelope break across 244 operations checked. That is not "three
 * routes forgot a field", it is an invariant with no enforcement: the other
 * 241 are consistent only because their authors happened to throw.
 *
 * This is a STATIC check, deliberately. Walking every registered route at
 * runtime would mean authenticating 244 operations and provoking an error on
 * each — expensive, and it would still only cover the errors we managed to
 * provoke. Grepping the source covers every branch whether or not a test can
 * reach it, in milliseconds, and fails on the next one somebody writes.
 *
 * The rule: any object literal in `src/` carrying `success: false` must also
 * carry `requestId`. Responses that are deliberately NOT this envelope don't
 * match at all — the OAuth2/RFC-6749 `{error, error_description}` bodies in
 * `mcp.routes.ts` and `tenant-mcp/oauth.routes.ts`, the `/health` probe body,
 * and the `{received, processed}` webhook receipt.
 */
describe('error envelope invariant (static)', () => {
  it('every hand-built `success: false` response in src/ also carries requestId', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith('.ts')) out.push(full);
      }
      return out;
    }

    /**
     * `lib/openapi.ts` DESCRIBES the envelope rather than building one.
     *
     * Its `ErrorResponseSchema` is a JSON Schema whose `success` property is
     * `enum: [false]`, and the `requestId` it requires lives in a separate
     * const (`RekeyErrorObject`) further up the file — outside the 14-line
     * window this scan reads. So the scan sees a `success: false` with no
     * `requestId` near it and reports a schema definition as a hand-built
     * response.
     *
     * Excluded by path rather than by widening the window: a wider window
     * would start swallowing the *next* statement in real route files, which
     * is exactly how this check would stop catching the thing it exists for.
     * This file constructs no runtime response at all, so there is nothing
     * here for it to miss.
     */
    const SCHEMA_ONLY = new Set(['lib/openapi.ts']);

    const offenders: string[] = [];
    for (const file of await walk(srcDir)) {
      if (SCHEMA_ONLY.has(path.relative(srcDir, file))) continue;
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!/success:\s*false/.test(line)) return;
        // The envelope is at most a handful of lines long; `requestId` has to
        // appear inside it. 14 lines comfortably spans the longest real one
        // (the dependency-outage branch) without reaching the next statement.
        const window = lines.slice(i, i + 14).join('\n');
        if (!/requestId/.test(window)) {
          offenders.push(`${path.relative(srcDir, file)}:${i + 1}`);
        }
      });
    }

    expect(
      offenders,
      'These build the error envelope by hand without `requestId`, so they bypass ' +
        'rekeyErrorHandler. Throw a RekeyError instead — it supplies requestId and the ' +
        'X-Request-Id header for free.',
    ).toEqual([]);
  });
});
