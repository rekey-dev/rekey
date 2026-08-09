/**
 * Rate-limit error contract + per-route config for auth endpoints.
 *
 * Two problems this file fixes.
 *
 * **1. The 429 body was unswitchable.** `@fastify/rate-limit`'s default
 * `errorResponseBuilder` returns a bare `Error` with a `statusCode` and no
 * `code`, so our envelope fell through to `code: "BAD_REQUEST"` with
 * `fix: "Check the request shape against the route schema in /docs."` — a
 * throttled client was told to go debug its payload, and had nothing stable to
 * switch on to implement backoff. `rateLimitError()` below is wired in as the
 * plugin's `errorResponseBuilder` (app.ts), so every limiter — global and
 * per-route — emits `RATE_LIMITED` with `retryAfterSeconds`, the field
 * docs/errors.md already promised.
 *
 * **2. The auth limiter locked out a whole Application.** The global limiter
 * keys on `req.apiKey?.id ?? req.ip`, and sign-in requires the Application
 * secret key — so every end user of one app shared ONE 10-per-60s bucket.
 * Ten failed logins a minute is ordinary traffic for a modest app, and an
 * attacker who deliberately burns the bucket locks out every legitimate user
 * for the window (verified: changing the email still 429s, a different API key
 * gets a fresh bucket). `authRateLimit()` now keys the tight cap on
 * (Application, identity being authenticated, IP) and the per-Application
 * ceiling moves to a separate, much larger bucket registered in app.ts — so
 * one app still can't exhaust global capacity, but one identity can't take
 * down the app.
 */

import type { FastifyRequest } from 'fastify';
import { RekeyError } from './error.js';

/** Context `@fastify/rate-limit` hands `errorResponseBuilder`. */
export interface RateLimitContext {
  statusCode: number;
  ban: boolean;
  after: string;
  max: number;
  /** Remaining window, milliseconds. */
  ttl: number;
}

/**
 * The 429 (or 403, if a `ban` threshold is ever configured) body. Returned —
 * not thrown — because the plugin throws whatever this produces, which routes
 * it through `rekeyErrorHandler` and therefore through the standard envelope.
 */
export function rateLimitError(_req: FastifyRequest, context: RateLimitContext): RekeyError {
  const retryAfterSeconds = Math.max(1, Math.ceil(context.ttl / 1000));
  return new RekeyError({
    statusCode: context.statusCode,
    code: 'RATE_LIMITED',
    message: `Rate limit exceeded (${context.max} requests per window). Retry in ${retryAfterSeconds}s.`,
    fix: 'Back off for the number of seconds in the Retry-After header (also `error.retryAfterSeconds`), then retry. `x-ratelimit-remaining` on every response lets you pace ahead of the limit.',
    retryAfterSeconds,
  });
}

/** Build the same 429 from a raw remaining-TTL, for limiters we drive by hand. */
export function rateLimitedAfter(ttlMs: number, max: number): RekeyError {
  return rateLimitError(undefined as unknown as FastifyRequest, {
    statusCode: 429,
    ban: false,
    after: '',
    max,
    ttl: ttlMs,
  });
}

/**
 * Marker key stamped onto an auth route's `config.rateLimit`. app.ts reads it to
 * decide which routes also get the per-Application ceiling. Unknown keys in a
 * route's rate-limit config are ignored by the plugin, so this rides along for
 * free rather than needing a second `config` field on 25 route definitions.
 */
export const AUTH_CEILING_MARKER = 'rekeyAuthCeiling';

/** Longest identity fragment we put in a bucket key (RFC 5321 caps email at 254). */
const MAX_IDENTITY_LENGTH = 254;

/**
 * The identity a request is trying to authenticate as, normalised for use in a
 * bucket key. Reads `email` off the parsed body — which is why the auth limiter
 * runs at `preValidation` rather than `onRequest` (see `authRateLimit`).
 *
 * Must never throw: it runs on unvalidated input, so the body can be absent, a
 * string, an array, or an object with `email` of any type. Anything unusable
 * degrades to `-`, which shares one bucket per (Application, IP) — no worse than
 * the previous behaviour for those routes.
 */
export function authIdentityOf(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return '-';
  const raw = (body as Record<string, unknown>).email;
  if (typeof raw !== 'string') return '-';
  const normalized = raw.trim().toLowerCase().replace(/[\s:]/g, '');
  if (normalized.length === 0) return '-';
  return normalized.slice(0, MAX_IDENTITY_LENGTH);
}

/**
 * Bucket key for the tight auth cap: (Application or IP) + identity + IP.
 *
 * The IP stays in the key so an attacker who knows a victim's email can't lock
 * that victim out from elsewhere — they'd only fill their own (identity, IP)
 * bucket. Account-level brute-force protection is a separate concern and lives
 * in lib/brute-force.ts, which locks on (Application, email) by design.
 */
export function authRateLimitKey(req: FastifyRequest): string {
  const principal = req.apiKey?.id ?? 'anon';
  return `auth:${principal}:${authIdentityOf(req.body)}:${req.ip}`;
}

/** Bucket key for the per-Application ceiling across all auth endpoints. */
export function authCeilingKey(req: FastifyRequest): string {
  // `req.application` first, then the key, then the IP.
  //
  // This read `req.apiKey?.id ?? req.ip` while the hook was registered on the
  // ROOT instance and `requireApiKey` runs on child instances — parent hooks
  // always run first, so `req.apiKey` was undefined on every request and the
  // ceiling was per-IP, 100% of the time. `authRateLimitKey` also contains
  // `req.ip`, so no aggregate per-Application cap existed anywhere: one
  // password sprayed across many accounts from a rotating IP pool was bounded
  // only per-IP.
  //
  // The existing test passed because it injects from 127.0.0.1 with no key —
  // asserting per-IP behaviour while naming it per-Application.
  const principal = req.application?.id ?? req.apiKey?.id;
  return `authceil:${principal ?? req.ip}`;
}

/**
 * Options for the per-Application auth ceiling (wired in app.ts via
 * `createRateLimit`). Neutered under NODE_ENV=test for the same reason
 * `authRateLimit` is: the suite fires far more than a minute's worth of auth
 * requests from 127.0.0.1 in one run and would throttle itself.
 */
export function authCeilingOptions(
  max: number,
  timeWindowMs: number,
): {
  max: number;
  timeWindow: number;
  keyGenerator: (req: FastifyRequest) => string;
  skipOnError: boolean;
} {
  const isTest = process.env.NODE_ENV === 'test';
  return {
    max: isTest ? 1_000_000 : max,
    timeWindow: timeWindowMs,
    keyGenerator: authCeilingKey,
    // Fail CLOSED on the auth tier, overriding the global `skipOnError: true`.
    //
    // The global limiter protects throughput, so letting a store outage through
    // is better than turning a Redis restart into a full outage. These buckets
    // protect credentials, and several auth endpoints have no second line of
    // defence: `forgot-password` and `magic-link/request` are not brute-force
    // scoped (they are not sign-in attempts), so with the limiter skipped they
    // would accept unbounded requests, each one sending an email.
    //
    // The plugin rethrows the store error when this is false; ioredis errors are
    // classified in lib/dependency-outage.ts and surface as 503
    // DEPENDENCY_UNAVAILABLE, which is what we want a client to see.
    skipOnError: false,
  };
}

/**
 * Ceiling for the GLOBAL limiter, with the same test-mode escape hatch the
 * per-route caps above already use.
 *
 * Both `authRateLimit` and `authCeilingOptions` raise their caps in test because
 * the suite issues thousands of requests from one IP. The global limiter did not,
 * so it stayed at `RATE_LIMIT_MAX` (default 100) — and since `app.inject` always
 * reports the same IP, one bucket counted an entire test FILE. Any file over 100
 * requests began failing partway through with 429s inside its fixtures, which
 * surfaced as an unrelated assertion failure further down. Per-test isolation
 * could not fix it either: `test/setup.ts` truncates Postgres, but the limiter
 * counter lives in the store, not the database.
 */
export function globalRateLimitMax(max: number): number {
  return process.env.NODE_ENV === 'test' ? 1_000_000 : max;
}

export interface AuthRateLimitConfig {
  max: number;
  timeWindow: string;
  hook: 'preValidation';
  keyGenerator: (req: FastifyRequest) => string;
  /** Fail closed on a store error — see `authCeilingOptions` for why. */
  skipOnError: boolean;
  /** Flag app.ts reads to also apply the per-Application ceiling. */
  [AUTH_CEILING_MARKER]: true;
}

/**
 * Per-route rate-limit config for auth endpoints.
 *
 * The global limiter (app.ts) is a loose backstop for the whole API. Credential-
 * and code-guessing endpoints (sign-in, MFA verify, OAuth token) get a much
 * tighter cap here — note a route-level `config.rateLimit` *replaces* the global
 * hook for that route rather than layering on it, which is why the ceiling has
 * to be registered separately.
 *
 * `hook: 'preValidation'` moves the limiter from Fastify's `onRequest` stage to
 * after body parsing, so `keyGenerator` can see which identity is being
 * authenticated. It still runs before schema validation, so a malformed body is
 * counted rather than being a free request.
 *
 * **Disabled under NODE_ENV=test.** The in-process test suite fires many
 * requests from a single IP (127.0.0.1) within one run, so a real per-route cap
 * would trip the suite against itself. We raise the cap to effectively-infinite
 * in test; production keeps the tight limit. (The keying change above is what
 * the suite exercises, via the exported helpers.)
 */
export function authRateLimit(maxPerMinute: number): AuthRateLimitConfig {
  const isTest = process.env.NODE_ENV === 'test';
  return {
    skipOnError: false,
    max: isTest ? 1_000_000 : maxPerMinute,
    timeWindow: '1 minute',
    hook: 'preValidation',
    keyGenerator: authRateLimitKey,
    [AUTH_CEILING_MARKER]: true,
  };
}

/**
 * Does this matched route want the per-Application auth ceiling?
 *
 * The ceiling reuses the global budget (`RATE_LIMIT_MAX` per
 * `RATE_LIMIT_WINDOW_MS`) — precisely what auth routes lost by overriding the
 * global limiter with their own config. So the aggregate posture is unchanged
 * (one Application still can't exceed the deployment's per-key budget on auth
 * endpoints) while the tight per-identity cap is what actually throttles a
 * credential-guesser.
 */
export function wantsAuthCeiling(rateLimitConfig: unknown): boolean {
  if (typeof rateLimitConfig !== 'object' || rateLimitConfig === null) return false;
  return (rateLimitConfig as Record<string, unknown>)[AUTH_CEILING_MARKER] === true;
}
