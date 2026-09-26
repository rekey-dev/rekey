/**
 * Rate-limit error contract + per-route config for auth endpoints.
 *
 * Two problems this file fixes.
 *
 * **1. The 429 body was unswitchable.** `@fastify/rate-limit`'s default
 * `errorResponseBuilder` returns a bare `Error` with a `statusCode` and no
 * `code`, so our envelope fell through to `code: "BAD_REQUEST"` with
 * `fix: "Check the request shape against the route schema in /docs."`, a
 * throttled client was told to go debug its payload, and had nothing stable to
 * switch on to implement backoff. `rateLimitError()` below is wired in as the
 * plugin's `errorResponseBuilder` (app.ts), so every limiter, global and
 * per-route, emits `RATE_LIMITED` with `retryAfterSeconds`, the field
 * docs/errors.md already promised.
 *
 * **2. The auth limiter locked out a whole Application.** The global limiter
 * keys on `req.apiKey?.id ?? req.ip`, and sign-in requires the Application
 * secret key, so every end user of one app shared ONE 10-per-60s bucket.
 * Ten failed logins a minute is ordinary traffic for a modest app, and an
 * attacker who deliberately burns the bucket locks out every legitimate user
 * for the window (verified: changing the email still 429s, a different API key
 * gets a fresh bucket). `authRateLimit()` now keys the tight cap on
 * (Application, identity being authenticated, IP) and the per-Application
 * ceiling moves to a separate, much larger bucket registered in app.ts, so
 * one app still can't exhaust global capacity, but one identity can't take
 * down the app.
 */

import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RekeyError } from './error.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by an authentication hook that refused the request with something
     * other than 401 (a frozen Application, an erased or unknown end-user), so
     * the rejected-credential limiter counts it like a 401. Such a refusal
     * never reaches the per-caller limiter either, since the hook threw first.
     */
    credentialRefused?: boolean;
  }
}

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
 * The 429 (or 403, if a `ban` threshold is ever configured) body. Returned,
 * not thrown, because the plugin throws whatever this produces, which routes
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
 * bucket key. Reads `email` off the parsed body, which is why the auth limiter
 * runs at `preValidation` rather than `onRequest` (see `authRateLimit`).
 *
 * Must never throw: it runs on unvalidated input, so the body can be absent, a
 * string, an array, or an object with `email` of any type. Anything unusable
 * degrades to `-`, which shares one bucket per (Application, IP), no worse than
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
 * Bucket key for the tight auth cap: principal + subject, plus the client IP
 * when it can be vouched for. The principal is the secret key, else the
 * Application a publishable key named, else `anon`; it is never the IP.
 *
 * The IP stays in the key so an attacker who knows a victim's email can't lock
 * that victim out from elsewhere, they'd only fill their own (identity, IP)
 * bucket. Account-level brute-force protection is a separate concern and lives
 * in lib/brute-force.ts, which locks on (Application, email) by design.
 */
export function authRateLimitKey(req: FastifyRequest): string {
  // The secret key, else the Application a publishable key named, so two
  // Applications' browser traffic never shares an auth bucket.
  const principal = req.apiKey?.id ?? req.application?.id ?? 'anon';
  // Behind a proxy we cannot identify, `req.ip` is shared by everyone behind
  // it, so it is left out: the bucket is per (principal, subject), and a route
  // with no subject at all skips it (`skipSharedAuthBucket`), leaving the
  // per-Application ceiling and the account lockout.
  if (!req.clientIpVouched) return `auth:${principal}:${authSubjectOf(req)}`;
  return `auth:${principal}:${authSubjectOf(req)}:${req.ip}`;
}

/**
 * allowList for the tight auth bucket. A route with no email and no session
 * (magic-link and reset verification, MFA verification, OAuth token and
 * registration) has no subject to key on, so through an unidentified proxy
 * its bucket would be ONE bucket for every caller behind it: ten bogus
 * verification attempts from anyone would refuse everyone for the window.
 * Those tokens are single-use and unguessable; the per-Application ceiling
 * still bounds the route.
 */
export function skipSharedAuthBucket(req: FastifyRequest): boolean {
  return !req.clientIpVouched && authSubjectOf(req) === '-';
}

/**
 * Whose secret the request is testing. The email in the body for sign-in and
 * friends; for a route that checks a secret INSIDE a session (change password,
 * a step-up before enrolling a passkey) there is no email, and the account is
 * the signed-in operator or end user. Without this those routes shared one
 * `-` bucket per IP, fine for the cap itself but it let one account's typos
 * spend another's attempts from the same office.
 */
function authSubjectOf(req: FastifyRequest): string {
  const fromBody = authIdentityOf(req.body);
  if (fromBody !== '-') return fromBody;
  if (req.tenantUser) return `op-${req.tenantUser.id}`;
  if (req.endUser) return `eu-${req.endUser.id}`;
  return '-';
}

/** Bucket key for the per-Application ceiling across all auth endpoints. */
export function authCeilingKey(req: FastifyRequest): string {
  // `req.application` first, then the key, then the IP.
  //
  // This read `req.apiKey?.id ?? req.ip` while the hook was registered on the
  // ROOT instance and `requireApiKey` runs on child instances, parent hooks
  // always run first, so `req.apiKey` was undefined on every request and the
  // ceiling was per-IP, 100% of the time. `authRateLimitKey` also contains
  // `req.ip`, so no aggregate per-Application cap existed anywhere: one
  // password sprayed across many accounts from a rotating IP pool was bounded
  // only per-IP.
  //
  // The existing test passed because it injects from 127.0.0.1 with no key,
  // asserting per-IP behaviour while naming it per-Application.
  return `authceil:${authCeilingPrincipal(req) ?? req.ip}`;
}

/**
 * The Application (else the secret key) the auth ceiling counts a request
 * against, or undefined for a route with neither (operator sign-in), where the
 * ceiling falls back to the client IP. One function so the bucket key and the
 * budget it gets cannot disagree.
 */
export function authCeilingPrincipal(req: FastifyRequest): string | undefined {
  return req.application?.id ?? req.apiKey?.id;
}

/**
 * The end user's address an auth-tier request can be attributed to, or null
 * when it has none we can use.
 *
 *   - A secret key: the address its backend declared in `X-Rekey-Client-Ip`
 *     (`req.declaredClientIp`), else null. `req.ip` is the backend's own
 *     address, shared by all of its users, so it is never used.
 *   - Anything else: `req.ip` when lib/client-ip.ts vouched for it, else null
 *     (a proxy we cannot identify, shared by everyone behind it).
 *
 * A declared address is believed only from a secret-key caller, and only for
 * these limits. Whoever holds the secret key already controls every request
 * its Application sees, so letting it name the visitor gives it nothing new:
 * it could always spread its own traffic across several secret keys. What it
 * buys is that a password spray sent THROUGH the customer's backend is held
 * per visitor, like browser traffic, instead of only by the per-Application
 * ceiling.
 */
export function attributedAuthClientIp(req: FastifyRequest): string | null {
  if (req.apiKey) return req.declaredClientIp ?? null;
  return req.clientIpVouched ? req.ip : null;
}

/**
 * Bucket for the per-(Application, client IP) share of the auth ceiling.
 *
 * The per-Application ceiling is an aggregate guard sized for a busy
 * Application (`RATE_LIMIT_AUTH_CEILING_MAX`), so on its own it would let one
 * address spend all of it. This bucket keeps what one address may do across
 * every auth route of one Application at `RATE_LIMIT_MAX`, exactly what the
 * old shared ceiling allowed it. It applies only to traffic with an end user's
 * address: see `attributedAuthClientIp`.
 */
export function authClientIpCeilingKey(req: FastifyRequest): string {
  return `authceilip:${authCeilingPrincipal(req) ?? '-'}:${attributedAuthClientIp(req) ?? req.ip}`;
}

/**
 * Whether a request also counts against the per-(Application, client IP)
 * bucket: whenever it names an Application and carries an end user's address.
 * Not without a principal: the ceiling itself is already per IP there. A
 * secret key that declared no address, and an address we cannot vouch for,
 * get `wantsUnattributedFailureCap` instead.
 */
export function wantsAuthClientIpCeiling(req: FastifyRequest): boolean {
  return authCeilingPrincipal(req) !== undefined && attributedAuthClientIp(req) !== null;
}

/**
 * Whether an auth-tier request is UNATTRIBUTED: it names an Application but
 * carries no end user's address. That is a secret-key backend that does not
 * send `X-Rekey-Client-Ip`, or publishable-key traffic behind a proxy we cannot
 * identify. Such traffic has no per-address bucket, so without a cap of its
 * own a password spray through it was bounded only by the per-Application
 * ceiling (`RATE_LIMIT_AUTH_CEILING_MAX`, 3000 a minute).
 */
export function wantsUnattributedFailureCap(req: FastifyRequest): boolean {
  return authCeilingPrincipal(req) !== undefined && attributedAuthClientIp(req) === null;
}

/** Store key for one Application's unattributed failed attempts. */
export function unattributedFailureKey(req: FastifyRequest): string {
  return `unattributed:${authCeilingPrincipal(req) ?? '-'}`;
}

/**
 * The routes the unattributed cap watches: the two that answer a wrong guess
 * with a counted code (`FAILED_AUTH_ATTEMPT_CODES`). Nothing else is counted
 * and nothing else is ever refused by it, so sign-up, reset, magic link,
 * verification and passkey routes keep working however far past the cap an
 * Application is.
 */
export const UNATTRIBUTED_CAP_ROUTES = {
  signIn: '/api/v1/auth/sign-in',
  mfaVerify: '/api/v1/auth/mfa-verify',
} as const;

/**
 * Whose secret an unattributed attempt is testing, for the cap's per-subject
 * memory, or null when the request is not on a watched route or names nobody.
 * Sign-in: the normalised email. MFA verification: the end user the pending
 * challenge token belongs to (`mfaSubject` verifies it; an invalid token is
 * refused with a code the cap does not count, so it needs no subject).
 */
export function unattributedAttemptSubject(
  req: FastifyRequest,
  mfaSubject: (challengeToken: string) => string | null,
): string | null {
  const route = req.routeOptions?.url;
  if (route === UNATTRIBUTED_CAP_ROUTES.signIn) {
    const email = authIdentityOf(req.body);
    return email === '-' ? null : `email:${email}`;
  }
  if (route === UNATTRIBUTED_CAP_ROUTES.mfaVerify) {
    const body = req.body as Record<string, unknown> | null | undefined;
    const token = typeof body === 'object' && body !== null ? body.mfaChallengeToken : undefined;
    if (typeof token !== 'string') return null;
    const endUserId = mfaSubject(token);
    return endUserId === null ? null : `eu:${endUserId}`;
  }
  return null;
}

/** Store key for one subject's unattributed failures inside one Application. */
export function unattributedSubjectKey(req: FastifyRequest, subject: string): string {
  return `unattributed:${authCeilingPrincipal(req) ?? '-'}:${subject}`;
}

/**
 * Error codes that mean a guessed secret was wrong, which is what a password
 * spray or a code guesser produces. Only these count against the unattributed
 * cap, so ordinary volume (sign-ins that succeed, resets, verifications) never
 * does.
 */
export const FAILED_AUTH_ATTEMPT_CODES: ReadonlySet<string> = new Set([
  'INVALID_CREDENTIALS',
  'MFA_CODE_INVALID',
]);

/** Budgets for the auth tier's aggregate buckets, per window. */
export interface AuthCeilingBudgets {
  /** All auth routes of one Application together (`RATE_LIMIT_AUTH_CEILING_MAX`). */
  perApplication: number;
  /**
   * One client IP: across one Application's auth routes, and across operator
   * auth routes, which have no Application (`RATE_LIMIT_MAX`).
   */
  perClientIp: number;
}

/**
 * Options for the per-Application auth ceiling (wired in app.ts via
 * `createRateLimit`).
 *
 * The ceiling used to reuse `RATE_LIMIT_MAX` (100 a minute), sized for one
 * anonymous address, as the budget of a whole Application. A 50,000-DAU
 * Application needs 200 to 300 auth requests a minute at its peak, and
 * because a publishable key is public, anyone could spend those 100 and
 * refuse every sign-in to the Application for the rest of the window. It now
 * has its own budget (`RATE_LIMIT_AUTH_CEILING_MAX`), and what one address may
 * spend of it stays at `RATE_LIMIT_MAX` through `authClientIpCeilingOptions`,
 * so exhausting it takes about thirty addresses instead of one.
 *
 * Neutered under NODE_ENV=test for the same reason
 * `authRateLimit` is: the suite fires far more than a minute's worth of auth
 * requests from 127.0.0.1 in one run and would throttle itself.
 */
export function authCeilingOptions(
  budgets: AuthCeilingBudgets,
  timeWindowMs: number,
): {
  max: (req: FastifyRequest) => number;
  timeWindow: number;
  keyGenerator: (req: FastifyRequest) => string;
  skipOnError: boolean;
} {
  const perApplication = globalRateLimitMax(budgets.perApplication);
  const perClientIp = globalRateLimitMax(budgets.perClientIp);
  return {
    // A bucket keyed on the Application gets the Application's budget; one
    // that fell back to the client IP (operator routes) keeps the per-IP one.
    max: (req) => (authCeilingPrincipal(req) === undefined ? perClientIp : perApplication),
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
 * Options for the per-(Application, client IP) auth bucket. Fails closed like
 * the rest of the auth tier, see `authCeilingOptions`.
 */
export function authClientIpCeilingOptions(
  maxPerWindow: number,
  timeWindowMs: number,
): {
  max: number;
  timeWindow: number;
  keyGenerator: (req: FastifyRequest) => string;
  skipOnError: boolean;
} {
  return {
    max: globalRateLimitMax(maxPerWindow),
    timeWindow: timeWindowMs,
    keyGenerator: authClientIpCeilingKey,
    skipOnError: false,
  };
}

/**
 * Ceiling for the GLOBAL limiter, with the same test-mode escape hatch the
 * per-route caps above already use.
 *
 * Both `authRateLimit` and `authCeilingOptions` raise their caps in test because
 * the suite issues thousands of requests from one IP. The global limiter did not,
 * so it stayed at `RATE_LIMIT_MAX` (default 100), and since `app.inject` always
 * reports the same IP, one bucket counted an entire test FILE. Any file over 100
 * requests began failing partway through with 429s inside its fixtures, which
 * surfaced as an unrelated assertion failure further down. Per-test isolation
 * could not fix it either: `test/setup.ts` truncates Postgres, but the limiter
 * counter lives in the store, not the database.
 */
export function globalRateLimitMax(max: number): number {
  return rateLimitsEnforced() ? max : 1_000_000;
}

/**
 * Whether the real caps apply. Always true outside NODE_ENV=test. Inside it,
 * the caps are neutered (see `globalRateLimitMax`) unless a test opts back in
 * with `REKEY_TEST_ENFORCE_RATE_LIMITS=1` before building its app, which is how
 * test/rate-limit-keying.test.ts drives the real wiring on the wire. The
 * variable is read nowhere else and has no effect outside the test runner.
 */
export function rateLimitsEnforced(): boolean {
  return process.env.NODE_ENV !== 'test' || process.env.REKEY_TEST_ENFORCE_RATE_LIMITS === '1';
}

/**
 * Who the global limiter counts a request against.
 *
 * It keyed on `req.apiKey?.id ?? req.ip`. The operator panel authenticates
 * with a JWT, not an API key, and every one of its calls leaves from the panel
 * container, so every operator on a deployment shared ONE 100-per-minute
 * bucket: the panel container's IP. A page view costs about a dozen API calls
 * plus route prefetches, and a single operator hit 429 within a few pages.
 *
 * The key is now the most specific identity the request has proved:
 *
 *   1. a secret API key (server-to-server; one customer backend = one budget)
 *   2. an operator (panel JWT, operator PAT, or operator MCP bearer; all of
 *      them set `req.tenantUser`)
 *   3. an end user with a verified session (`req.endUser`)
 *   4. otherwise the client IP, which is the real client only when
 *      lib/client-ip.ts can vouch for it (INTERNAL_CALLER_SECRET,
 *      API_PROXY_SECRET or TRUSTED_PROXIES)
 *
 * This only works because every one of those identities is resolved by an
 * `onRequest` hook (instance-level, or listed in the route's own `onRequest`)
 * and the plugin APPENDS its hook to the route's `onRequest` array, so it runs
 * last in that stage. test/rate-limit-keying.test.ts proves the ordering on
 * the wire for each kind. A route that authenticates later than `onRequest`
 * (in a `preHandler` or inside the handler) is keyed on the client IP, which is
 * the same budget an unauthenticated caller gets, never a shared one.
 *
 * A request whose credential is REJECTED never reaches the limiter at all: the
 * auth hook throws first. That was already true of API keys and is unchanged.
 */
export function globalRateLimitKey(req: FastifyRequest): string {
  if (req.apiKey) return `key:${req.apiKey.id}`;
  if (req.tenantUser) return `op:${req.tenantUser.id}`;
  if (req.endUser) return `eu:${req.endUser.id}`;
  // Behind a proxy we cannot identify, the IP is shared by everyone behind it.
  // A publishable-key call still names its Application, so it gets a
  // per-Application bucket (at the per-key budget) instead of nothing.
  if (!req.clientIpVouched && req.application) return `app:${req.application.id}`;
  return `ip:${req.ip}`;
}

/**
 * The global limiter's allowList: an anonymous request whose address cannot be
 * vouched for is not counted by IP at all (lib/client-ip.ts). Blocking it would
 * block every caller behind the same proxy, which is the outage this exists to
 * prevent. Route-level configs inherit this; it only ever matches `ip:` keys.
 */
export function globalRateLimitAllowList(req: FastifyRequest, key: string): boolean {
  return key.startsWith('ip:') && !req.clientIpVouched;
}

/** allowList for a route bucket keyed ONLY on the client IP (plus a scope). */
export function skipUnvouchedIp(req: FastifyRequest): boolean {
  return !req.clientIpVouched;
}

/** Does the request present a secret API key (not yet verified)? */
export function presentedSecretKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(rp_(?:live|test)_\S+)$/.exec(auth);
  return m ? m[1]! : null;
}

/**
 * Secret keys that have verified recently, so the rejected-credential block
 * can let a known-good key through WITHOUT looking anything up, and refuse
 * everything else from a blocked address before the lookup.
 *
 * The alternative orderings both fail: exempting anything shaped like a key
 * lets a blocked address send unlimited forged keys, each a database lookup;
 * checking the block after verification means the lookup happens anyway.
 * Remembering the keys that have verified gives the block a way to recognise
 * one without touching the database. A key first used while its address is
 * blocked waits out the window (one minute by default).
 *
 * Stores a SHA-256 of the raw key (the same digest the key table indexes),
 * never the key. Redis when there is one, so every replica recognises a key
 * another verified; per-instance memory otherwise. A re-write is skipped when
 * this instance wrote the same digest recently, so a busy key costs no store
 * write per request. Fails open on a store error, like the block itself.
 */
export interface VerifiedKeyMemo {
  known(rawKey: string): Promise<boolean>;
  /** `expiresAt` caps the memo at the key's own expiry. */
  remember(rawKey: string, expiresAt?: Date | null): Promise<void>;
  /** Drop one key by its stored hash (`api_keys.key_hash`). */
  forget(keyHash: string): Promise<void>;
  /** Stop receiving revocations (the app that owns it is closing). */
  dispose(): void;
}

/** Every memo in this process, so a revocation reaches all of them. */
const liveMemos = new Set<VerifiedKeyMemo>();

/**
 * Forget a secret key everywhere: called when a key is revoked, so it can no
 * longer pass a blocked address without a lookup. `keyHash` is the stored
 * SHA-256, the same digest the memo keys on, so no raw key is needed.
 */
export async function forgetVerifiedKey(keyHash: string): Promise<void> {
  await Promise.all([...liveMemos].map((memo) => memo.forget(keyHash)));
}

export function createVerifiedKeyMemo(args: {
  redis: Redis | null;
  ttlMs: number;
  onStoreError?: (err: unknown) => void;
}): VerifiedKeyMemo {
  const { redis, ttlMs } = args;
  const onError = args.onStoreError ?? (() => undefined);
  // With Redis, this map only throttles WRITES: `known` always asks Redis, so
  // a revocation on one replica is seen by every replica at once. Without
  // Redis (one process) it is the store.
  const local = new Map<string, number>(); // digest -> expiresAt
  const refreshMs = Math.min(ttlMs / 4, 10 * 60_000);
  const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
  const key = (d: string) => `rl:goodkey:${d}`;

  const memo: VerifiedKeyMemo = {
    async known(rawKey) {
      const d = digest(rawKey);
      if (!redis) {
        const until = local.get(d);
        return until !== undefined && until > Date.now();
      }
      try {
        return (await redis.exists(key(d))) === 1;
      } catch (err) {
        onError(err);
        return false;
      }
    },
    async remember(rawKey, expiresAt) {
      const d = digest(rawKey);
      const now = Date.now();
      const ttl = expiresAt ? Math.min(ttlMs, expiresAt.getTime() - now) : ttlMs;
      if (ttl <= 0) return;
      const until = local.get(d);
      if (until !== undefined && until - now > ttl - refreshMs) return;
      if (local.size > 50_000) local.clear();
      local.set(d, now + ttl);
      if (!redis) return;
      try {
        await redis.set(key(d), '1', 'PX', ttl);
      } catch (err) {
        onError(err);
      }
    },
    async forget(keyHash) {
      local.delete(keyHash);
      if (!redis) return;
      try {
        await redis.del(key(keyHash));
      } catch (err) {
        onError(err);
      }
    },
    dispose() {
      liveMemos.delete(memo);
    },
  };
  liveMemos.add(memo);
  return memo;
}

/** Coarse kind of credential a request presented, for counting refusals. */
export function credentialKindOf(req: FastifyRequest): string {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (req.headers['x-rekey-user-token']) return 'end-user-token';
  if (/^rp_(live|test)_/.test(token)) return 'secret-key';
  if (token.startsWith('rp_pub_')) return 'publishable-key';
  if (token.startsWith('rp_op_')) return 'operator-pat';
  if (token.split('.').length === 3) return 'jwt';
  return token ? 'other-bearer' : 'none';
}

/** Per-window budgets for the global limiter, one per kind of caller. */
export interface GlobalRateLimitBudgets {
  /** Unauthenticated traffic, per client IP (`RATE_LIMIT_MAX`). */
  anonymous: number;
  /** Per operator or per signed-in end user (`RATE_LIMIT_AUTHENTICATED_MAX`). */
  authenticated: number;
  /** Per secret API key (`RATE_LIMIT_API_KEY_MAX`). */
  apiKey: number;
  /**
   * Per client IP, across every operator and end user seen from it
   * (`RATE_LIMIT_AUTHENTICATED_IP_MAX`). API-key traffic is exempt.
   */
  authenticatedPerIp: number;
  /** Rejected credentials per client IP before it is refused outright (`RATE_LIMIT_AUTH_FAILURE_MAX`). */
  authFailuresPerIp: number;
  /**
   * All auth routes of one Application together (`RATE_LIMIT_AUTH_CEILING_MAX`).
   * Not a global-limiter budget, but resolved here with the others so the
   * never-below-`RATE_LIMIT_MAX` rule is written once.
   */
  authCeiling: number;
  /**
   * Failed sign-in and MFA attempts per Application per window from traffic
   * with no end user's address (`RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX`):
   * a secret-key backend that does not forward `X-Rekey-Client-Ip`, or
   * publishable-key traffic behind a proxy we cannot identify. Once spent, an
   * unattributed sign-in or MFA attempt for an account that has already failed
   * this window is refused for the rest of the window; every other account,
   * every other route and all attributed traffic are unaffected.
   */
  authUnattributedFailures: number;
}

/** Default per-Application budget of unattributed failed auth attempts, per window. */
export const DEFAULT_AUTH_UNATTRIBUTED_FAILURE_MAX = 300;

/** Default authenticated (operator / end-user) budget per window. */
export const DEFAULT_AUTHENTICATED_MAX = 600;
/** Default per-secret-key budget per window. Sizing: docs/rate-limits.md. */
export const DEFAULT_API_KEY_MAX = 30_000;
/** Default per-Application budget across all auth routes, per window. */
export const DEFAULT_AUTH_CEILING_MAX = 3000;
/** Default per-IP ceiling across authenticated identities, per window. */
export const DEFAULT_AUTHENTICATED_IP_MAX = 3000;

/**
 * Resolve the budgets from env. The authenticated and API-key budgets
 * never default BELOW `RATE_LIMIT_MAX`: a deployment that raised that single
 * knob to feed a busy backend (the only knob that existed) must not see its
 * key budget drop to the new default on upgrade.
 */
export function resolveGlobalBudgets(input: {
  RATE_LIMIT_MAX: number;
  RATE_LIMIT_AUTHENTICATED_MAX?: number | undefined;
  RATE_LIMIT_API_KEY_MAX?: number | undefined;
  RATE_LIMIT_AUTHENTICATED_IP_MAX?: number | undefined;
  RATE_LIMIT_AUTH_FAILURE_MAX?: number | undefined;
  RATE_LIMIT_AUTH_CEILING_MAX?: number | undefined;
  RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX?: number | undefined;
}): GlobalRateLimitBudgets {
  const authenticated =
    input.RATE_LIMIT_AUTHENTICATED_MAX ?? Math.max(DEFAULT_AUTHENTICATED_MAX, input.RATE_LIMIT_MAX);
  return {
    anonymous: input.RATE_LIMIT_MAX,
    authenticated,
    apiKey: input.RATE_LIMIT_API_KEY_MAX ?? Math.max(DEFAULT_API_KEY_MAX, input.RATE_LIMIT_MAX),
    // Never below one identity's own budget, or a single operator could be
    // throttled by the ceiling before their own bucket.
    authenticatedPerIp:
      input.RATE_LIMIT_AUTHENTICATED_IP_MAX ?? Math.max(DEFAULT_AUTHENTICATED_IP_MAX, authenticated),
    // A rejected credential is anonymous traffic, so it gets the anonymous budget.
    authFailuresPerIp: input.RATE_LIMIT_AUTH_FAILURE_MAX ?? input.RATE_LIMIT_MAX,
    authCeiling:
      input.RATE_LIMIT_AUTH_CEILING_MAX ?? Math.max(DEFAULT_AUTH_CEILING_MAX, input.RATE_LIMIT_MAX),
    authUnattributedFailures:
      input.RATE_LIMIT_AUTH_UNATTRIBUTED_FAILURE_MAX ?? DEFAULT_AUTH_UNATTRIBUTED_FAILURE_MAX,
  };
}

/**
 * The `max` function for the global limiter: picks the budget from the key
 * `globalRateLimitKey` produced, so the two cannot disagree about who the
 * caller is.
 */
export function globalRateLimitMaxFor(
  budgets: GlobalRateLimitBudgets,
): (req: FastifyRequest, key: string) => number {
  // Resolved once, at registration, like every other cap in this file.
  const apiKey = globalRateLimitMax(budgets.apiKey);
  const authenticated = globalRateLimitMax(budgets.authenticated);
  const anonymous = globalRateLimitMax(budgets.anonymous);
  return (_req, key) => {
    if (key.startsWith('key:') || key.startsWith('app:')) return apiKey;
    if (key.startsWith('op:') || key.startsWith('eu:')) return authenticated;
    return anonymous;
  };
}

/**
 * Bucket for `POST /tenant/auth/refresh`, per client IP.
 *
 * The route carries no credential the limiter can see (the refresh token is in
 * the body and is only checked by the handler), so under the global limiter it
 * was counted against the anonymous per-IP budget, and in Docker that IP was
 * the panel's, shared by every operator. Refresh tokens are 256-bit random and
 * single-use, so this cap bounds cost, not guessing. It gets its own bucket so
 * ordinary browsing (which spends the anonymous budget on nothing else here)
 * and a burst of tabs renewing at once never starve each other.
 */
export function tenantRefreshRateLimit(
  maxPerWindow: number,
  timeWindowMs: number,
): {
  max: number;
  timeWindow: number;
  keyGenerator: (req: FastifyRequest) => string;
  allowList: (req: FastifyRequest) => boolean;
} {
  return {
    max: globalRateLimitMax(maxPerWindow),
    timeWindow: timeWindowMs,
    keyGenerator: (req) => `refresh:${req.ip}`,
    allowList: skipUnvouchedIp,
  };
}

/**
 * Bucket for the public portal config route: (slug, client IP).
 *
 * The hosted portal calls this server-side on every page load. What makes the
 * limit per VISITOR is not the slug but the client IP: the portal forwards the
 * visitor's address (apps/portal/src/lib/client-ip.ts) and the API believes it
 * only when lib/client-ip.ts can vouch for it (the portal's caller secret, or
 * its fixed address in TRUSTED_PROXIES). Without that, every visitor counts as
 * the portal, and the per-IP ceiling in portal.routes.ts caps
 * the whole portal. The slug in the key only stops one visitor's traffic to one
 * Application from spending their allowance for another; the per-IP ceiling
 * keeps the route from becoming an enumeration oracle (each guessed slug would
 * otherwise be a fresh bucket).
 */
export function portalConfigRateLimitKey(req: FastifyRequest): string {
  const params = req.params as Record<string, unknown> | undefined;
  const raw = typeof params?.slug === 'string' ? params.slug : '-';
  return `portal:${raw.slice(0, 120)}:${req.ip}`;
}

export interface AuthRateLimitConfig {
  max: number;
  timeWindow: string;
  hook: 'preValidation';
  keyGenerator: (req: FastifyRequest) => string;
  /** Fail closed on a store error, see `authCeilingOptions` for why. */
  skipOnError: boolean;
  /** Flag app.ts reads to also apply the per-Application ceiling. */
  [AUTH_CEILING_MARKER]: true;
  /** Skip the bucket for some requests (see `skipUnvouchedIp`). */
  allowList?: (req: FastifyRequest, key: string) => boolean;
}

/**
 * Per-route rate-limit config for auth endpoints.
 *
 * The global limiter (app.ts) is a loose backstop for the whole API. Credential-
 * and code-guessing endpoints (sign-in, MFA verify, OAuth token) get a much
 * tighter cap here, note a route-level `config.rateLimit` *replaces* the global
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
  return {
    skipOnError: false,
    max: globalRateLimitMax(maxPerMinute),
    timeWindow: '1 minute',
    hook: 'preValidation',
    keyGenerator: authRateLimitKey,
    allowList: skipSharedAuthBucket,
    [AUTH_CEILING_MARKER]: true,
  };
}

/**
 * Per-route config for end-user sign-up: 10 per (Application, client IP).
 *
 * Sign-up had no cap of its own, so under identity keying one address could
 * create an account a request and then spend a full authenticated budget from
 * each. The per-identity key the other auth routes use would not bound it
 * (every sign-up names a new email), so this one keys on the Application and
 * the address. It keeps the per-Application auth ceiling and fails closed,
 * like the rest of the tier: every sign-up can send an email.
 */
export function signUpRateLimit(maxPerMinute: number): AuthRateLimitConfig {
  // Per (Application, IP) only means something when the IP is the client's;
  // behind an unidentified proxy the per-Application auth ceiling still holds.
  return { ...authRateLimit(maxPerMinute), keyGenerator: signUpRateLimitKey, allowList: skipUnvouchedIp };
}

export function signUpRateLimitKey(req: FastifyRequest): string {
  const app = req.application?.id ?? 'anon';
  return `signup:${app}:${req.ip}`;
}

/**
 * Bucket for POST /licenses/verify and /deactivate.
 *
 * These routes take the PUBLISHABLE key, so `req.apiKey` is unset and the
 * global limiter fell back to `req.ip` alone, which put every Application's
 * licence traffic from one address in one bucket. The unit that bounds a
 * guesser is (application, IP): a client trying keys against one Application
 * gets its cap per address, and one Application's launch traffic cannot be
 * throttled by another's. Keying on the licence key or the fingerprint would
 * bound nothing, because every guess is a new key and so a new bucket; and
 * neither belongs in a rate-limit store in any form.
 */
export function licenseRateLimitKey(req: FastifyRequest): string {
  const app = req.application?.id ?? 'anon';
  return `license:${app}:${req.ip}`;
}

/**
 * Per-route config for the licence endpoints; neutered under test like
 * `authRateLimit`. Unlike the credential routes it FAILS OPEN when the
 * limiter's store is unreachable: verify is what every desktop client calls
 * at launch, and a Redis blip should not lock every user out of software they
 * have paid for. The auth ceiling still rides along.
 */
export function licenseRateLimit(maxPerMinute: number): Omit<AuthRateLimitConfig, typeof AUTH_CEILING_MARKER> {
  // The per-Application auth ceiling is deliberately NOT applied: it fails
  // closed by design (credential guessing must not get a free pass on a store
  // outage), which would make this route fail closed too, and a licence key
  // is not a credential a store outage should protect at the cost of every
  // launch. The (application, IP) bucket is the whole policy here.
  const { [AUTH_CEILING_MARKER]: _ceiling, ...base } = authRateLimit(maxPerMinute);
  return { ...base, keyGenerator: licenseRateLimitKey, skipOnError: true, allowList: skipUnvouchedIp };
}

/**
 * Does this matched route want the per-Application auth ceiling?
 *
 * Auth routes override the global limiter with their own config, so without
 * the ceiling they would have only the tight per-identity cap. The ceiling
 * (`RATE_LIMIT_AUTH_CEILING_MAX` per Application, `RATE_LIMIT_MAX` per client
 * IP) bounds the aggregate. The per-identity cap and the account lockout
 * throttle a guesser working on one account; one password sprayed across many
 * accounts is held by the per-(Application, client IP) share, or, for traffic
 * with no client address, by the unattributed failure cap
 * (`wantsUnattributedFailureCap`).
 */
export function wantsAuthCeiling(rateLimitConfig: unknown): boolean {
  if (typeof rateLimitConfig !== 'object' || rateLimitConfig === null) return false;
  return (rateLimitConfig as Record<string, unknown>)[AUTH_CEILING_MARKER] === true;
}

/** Bucket key for the per-IP ceiling across authenticated identities. */
export function authenticatedIpCeilingKey(req: FastifyRequest): string {
  return `authip:${req.ip}`;
}

/**
 * Counts REJECTED credentials per client IP and refuses the address once it
 * has too many.
 *
 * The global limiter runs after the auth hooks (that is what lets it key on the
 * caller), so a request whose credential is refused never reaches it: garbage
 * bearers, fake `rp_live_` keys, forged or expired JWTs each cost a database
 * lookup and were counted nowhere. `record` runs on every 401 response;
 * `blocked` runs in a ROOT `onRequest` hook, before any child plugin's auth
 * hook, so a refused address costs no lookup at all. It keys on `req.ip`, but
 * only when lib/client-ip.ts vouched for it: behind the panel or portal that is
 * the forwarded visitor, never the shared peer. An unvouched request is neither
 * blocked nor counted by address; app.ts counts its failures by credential kind
 * instead, for detection only, because blocking a kind would refuse every
 * legitimate caller of that kind behind the same proxy.
 *
 * Its own tiny store rather than a `createRateLimit` bucket, because checking
 * must not count: only failures do. Redis when there is one (shared across
 * replicas), per-instance memory otherwise. Fails OPEN on a store error, like
 * the global limiter: this protects throughput, and credentials have their own
 * fail-closed tier.
 */
export interface AuthFailureLimiter {
  /** Remaining block in ms when the address is over the limit, else 0. */
  blocked(ip: string): Promise<number>;
  /** Count one failure; returns the count in the current window (0 on a store error). */
  record(ip: string): Promise<number>;
}

export function createAuthFailureLimiter(args: {
  max: number;
  windowMs: number;
  redis: Redis | null;
  onStoreError?: (err: unknown) => void;
}): AuthFailureLimiter {
  const max = globalRateLimitMax(args.max);
  const { windowMs, redis } = args;
  const memory = new Map<string, { count: number; resetAt: number }>();
  const key = (ip: string) => `rl:authfail:${ip}`;
  const onError = args.onStoreError ?? (() => undefined);

  return {
    async blocked(ip) {
      try {
        if (redis) {
          const count = Number((await redis.get(key(ip))) ?? 0);
          if (count < max) return 0;
          return Math.max(1, await redis.pttl(key(ip)));
        }
        const entry = memory.get(key(ip));
        if (!entry || entry.resetAt <= Date.now()) return 0;
        return entry.count >= max ? entry.resetAt - Date.now() : 0;
      } catch (err) {
        onError(err);
        return 0;
      }
    },
    async record(ip) {
      try {
        if (redis) {
          // SET NX starts the window once; INCR counts inside it. Both in one
          // MULTI so a crash between them cannot leave a key with no expiry.
          const res = await redis.multi().set(key(ip), '0', 'PX', windowMs, 'NX').incr(key(ip)).exec();
          const incr = res?.[1]?.[1];
          return typeof incr === 'number' ? incr : 0;
        }
        const now = Date.now();
        const entry = memory.get(key(ip));
        if (!entry || entry.resetAt <= now) {
          memory.set(key(ip), { count: 1, resetAt: now + windowMs });
          return 1;
        }
        entry.count += 1;
        return entry.count;
      } catch (err) {
        onError(err);
        return 0;
      }
    },
  };
}
