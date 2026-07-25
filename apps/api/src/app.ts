/**
 * Build the Fastify app instance.
 *
 * Pulled out of `index.ts` so tests can `import { buildApp } from '../src/app'`
 * and use Fastify's `app.inject()` to fire requests in-process — no port
 * binding, no flaky network behaviour.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import formbody from '@fastify/formbody';
import rawBody from 'fastify-raw-body';
import { getRedis, closeRedis } from './lib/redis.js';
import { isQueueEnabled } from './lib/queue.js';
import { primeCorsOrigins, isRegisteredAppOrigin } from './lib/cors-origins.js';

import { env, corsAllowedOrigins } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { jwksRoutes } from './routes/jwks.js';
import { relipayErrorHandler } from './lib/error.js';
import { requestIdFor } from './lib/request-id.js';
import {
  authCeilingOptions,
  globalRateLimitMax,
  rateLimitError,
  rateLimitedAfter,
  wantsAuthCeiling,
} from './lib/rate-limit.js';
import { rejectUnsupportedMediaType } from './middleware/media-type.js';
import { recordApiRequest, flushApiRequestLogs, pruneApiRequestLogs } from './lib/request-log.js';
import { pruneExpiredAuthTokens, pruneExpiredIdempotencyKeys } from './lib/token-prune.js';
import { idempotencyPreHandler, idempotencyOnSend } from './middleware/idempotency.js';
import { pruneExpiredChallenges } from './lib/webauthn-challenge.js';
import { processDueWebhookDeliveries } from './modules/webhooks/webhook.service.js';
import { processDueDunningCases } from './modules/billing/dunning.service.js';
import { registerSwagger } from './lib/swagger.js';
import { tenantsRoutes } from './modules/tenants/index.js';
import { applicationsRoutes } from './modules/applications/index.js';
import { apiKeysRoutes } from './modules/api-keys/index.js';
import { authRoutes, authenticatedAuthRoutes, userTokenMeRoutes } from './modules/auth/index.js';
import { plansRoutes } from './modules/plans/index.js';
import { couponsAdminRoutes, couponsPublicRoutes } from './modules/coupons/index.js';
import { billingRoutes } from './modules/billing/index.js';
import {
  stripeWebhookRoutes,
  paypalWebhookRoutes,
  razorpayWebhookRoutes,
  billingProviderWebhookRoutes,
} from './modules/billing/webhooks/index.js';
import { meRoutes } from './routes/me.js';
import { usersMeRoutes } from './routes/users-me.js';
import {
  tenantAuthRoutes,
  tenantAuthAuthenticatedRoutes,
  operatorTokenRoutes,
} from './modules/tenant-auth/index.js';
import {
  tenantWorkspacesRoutes,
  tenantInvitationPublicRoutes,
  tenantInvitationAuthRoutes,
} from './modules/tenant-workspaces/index.js';
import { tenantApplicationsRoutes } from './modules/tenant-applications/index.js';
import { oauthRoutes, oauthLinkRoutes } from './modules/oauth/index.js';
import { mfaRoutes } from './modules/mfa/index.js';
import { tenantMfaRoutes } from './modules/tenant-mfa/index.js';
import {
  tenantPasskeysAuthenticatedRoutes,
  tenantPasskeysPublicRoutes,
} from './modules/tenant-passkeys/index.js';
import { tenantOAuthPublicRoutes } from './modules/tenant-oauth/index.js';
import { licensesPublicRoutes } from './modules/licenses/index.js';
import { portalConfigRoutes } from './modules/portal/index.js';
import { usagePublicRoutes } from './modules/usage/index.js';
import { creditsPublicRoutes } from './modules/credits/index.js';
import { tenantEmailRoutes } from './modules/email/index.js';
import { tenantWebhookRoutes, startWebhookWorker, stopWebhookWorker } from './modules/webhooks/index.js';
import {
  organizationsAuthenticatedRoutes,
  organizationsAcceptInvitationRoutes,
} from './modules/organizations/index.js';
import { securityEventsRoutes } from './modules/security-events/index.js';
import { mcpRoutes, mcpWellKnownRoutes } from './modules/mcp/index.js';
import { adminMetricsRoutes } from './modules/admin-metrics/index.js';
import { operatorInvitesRoutes } from './modules/operator-invites/index.js';
import {
  tenantMcpRoutes,
  operatorMcpOAuthRoutes,
  operatorMcpWellKnownRoutes,
} from './modules/tenant-mcp/index.js';

export interface BuildAppOptions {
  /** Override the default logger config (e.g. silence in tests). */
  logger?: boolean | Record<string, unknown>;
}

/** Entries proxy-addr understands besides literal IPs/CIDRs. */
const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** Rough IPv4/IPv6/CIDR shape check — proxy-addr throws on malformed input. */
function looksLikeAddress(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) return true;
  const [addr, mask, ...rest] = entry.split('/');
  if (rest.length > 0 || !addr) return false;
  if (mask !== undefined && !/^\d{1,3}$/.test(mask)) return false;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  if (ipv4.test(addr)) {
    return addr.split('.').every((o) => Number(o) <= 255);
  }
  return ipv6.test(addr) && addr.includes(':');
}

/**
 * Resolve Fastify's `trustProxy` from TRUSTED_PROXIES.
 *
 * Unset (the default) → `false`: `request.ip` is the real socket peer and a
 * client-supplied X-Forwarded-For is ignored.
 *
 * Accepts a positive hop count ("1") or a comma-separated IP/CIDR allowlist
 * ("10.0.0.0/8,172.16.0.1"), plus proxy-addr's `loopback`/`linklocal`/
 * `uniquelocal` keywords. Deliberately NO trust-everything option: that is
 * exactly the setting this replaced, where any peer could forge
 * X-Forwarded-For and thereby request.ip — which rate limits, lockout, and IP
 * allowlists all key off. Anything unparseable throws at boot rather than
 * leaving proxy-addr to fail per-request on malformed input.
 */
export function trustProxyConfig(
  raw: string | undefined = process.env.TRUSTED_PROXIES,
): false | number | string[] {
  const value = raw?.trim();
  if (!value || value === 'false') return false;

  const hops = Number(value);
  if (!Number.isNaN(hops)) {
    if (Number.isInteger(hops) && hops > 0) return hops;
    throw new Error(
      `[CONFIG] TRUSTED_PROXIES="${value}" is not a valid hop count — use a positive integer, an IP/CIDR list, or leave it unset.`,
    );
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = entries.filter((entry) => !looksLikeAddress(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `[CONFIG] TRUSTED_PROXIES contains entries that are not an IP, CIDR, or proxy-addr keyword: ${invalid.join(', ') || '(empty)'}. ` +
        'Trusting X-Forwarded-For from the wrong source lets clients forge request.ip.',
    );
  }
  return entries;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger ??
      ({
        level: env.NODE_ENV === 'production' ? 'info' : 'debug',
        redact: {
          paths: [
            'headers.authorization',
            'req.headers.authorization',
            'body.rawKey',
            'body.password',
            '*.rawKey',
          ],
          censor: '[REDACTED]',
        },
      } as Record<string, unknown>),
    bodyLimit: 1024 * 1024,
    // Trusting X-Forwarded-For means trusting whoever set it. Keyed off
    // NODE_ENV this was `true` in production for ANY peer, so a client could
    // mint unlimited rate-limit buckets (and forge request.ip for lockout and
    // IP allowlists) with one header — measured: 60/60 requests bypassed the
    // limiter with a rotating XFF. Now opt-in and explicit: set TRUSTED_PROXIES
    // to your proxy's IP/CIDR list, or a hop count, once you actually run
    // behind one. Default off = request.ip is the real socket peer.
    trustProxy: trustProxyConfig(),
    // Treat `/x` and `/x/` as the same route. List/create endpoints register
    // at the collection root (`/` under a prefix → `/api/v1/admin/applications/`),
    // but SDK/CLI/MCP callers naturally hit the no-slash form. Without this,
    // Fastify's strict matching 404s those calls. No route is registered at
    // both forms, so merging them is safe. (Fastify 5: find-my-way options
    // live under `routerOptions`.)
    routerOptions: { ignoreTrailingSlash: true },
    // Request ids. Fastify's default is a per-process counter that restarts at
    // `req-1` on every boot, so the id in an error envelope collided across
    // restarts and replicas and "share the request id with support" pointed at
    // nothing. `requestIdHeader: false` disables Fastify's own header handling —
    // it would adopt an inbound value verbatim — and genReqId takes over, so an
    // inbound X-Request-Id is honoured for trace continuity but sanitised and
    // length-capped first (see lib/request-id.ts).
    requestIdHeader: false,
    genReqId: (req) => requestIdFor(req.headers as Record<string, unknown>),
  });

  // CORS — strict allowlist. Reflective `origin: true` is forbidden because
  // browsers will happily send our `relipay_*` credential cookies from any
  // page that the dynamic ACAO header endorses. The allowlist is sourced
  // from CORS_ALLOWED_ORIGINS; dev permits localhost so the panel + sample
  // apps work without manual config.
  const isDev = env.NODE_ENV !== 'production';
  const allowList = new Set(corsAllowedOrigins);
  const localhostRe = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  // Warm the per-Application origin cache so the first request sees it.
  await primeCorsOrigins();
  await app.register(cors, {
    credentials: true,
    origin(origin, cb) {
      // Same-origin / non-browser callers (curl, server-to-server) send no
      // Origin header — let those through; cookie auth doesn't apply there.
      if (!origin) return cb(null, true);
      // Global env allowlist (operator/panel origins).
      if (allowList.has(origin)) return cb(null, true);
      // Per-Application origins — any origin a tenant registered for their app.
      if (isRegisteredAppOrigin(origin)) return cb(null, true);
      if (isDev && localhostRe.test(origin)) return cb(null, true);
      // Returning `false` causes @fastify/cors to omit ACAO entirely, which
      // the browser then rejects. We don't throw — surfacing a 500 here
      // leaks the CORS shape; silent omission is the correct posture.
      return cb(null, false);
    },
  });
  await app.register(helmet, { contentSecurityPolicy: env.NODE_ENV === 'production' });

  // Rate limiter. The default in-memory store is per-process, so with multiple
  // API replicas the effective limit multiplies. We back it with the shared
  // Redis client (null in test → in-memory) so the limit is shared across
  // replicas. Store errors fail open — see `skipOnError` below.
  // Per-route tighter caps on auth endpoints layer on top via authRateLimit().
  const sharedRedis = getRedis();
  if (sharedRedis) {
    app.addHook('onClose', async () => {
      await closeRedis();
    });
  }
  await app.register(rateLimit, {
    max: globalRateLimitMax(env.RATE_LIMIT_MAX),
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Fail OPEN when the store errors. This is nominally the plugin default,
    // but with `enableOfflineQueue: false` on our ioredis client a Redis
    // outage surfaced as a synchronous throw ("Stream isn't writeable") that
    // 500'd EVERY route — including /health and pure-Postgres reads. Set it
    // explicitly so the behaviour is stated, not inherited. Losing rate
    // limiting for the duration of a Redis outage is strictly better than
    // losing the whole API.
    skipOnError: true,
    // Key authed server-to-server traffic by API key so a customer's backend
    // (all calls from one IP) gets a per-key budget instead of one shared IP
    // budget. requireApiKey runs before this hook on authed routes, so
    // req.apiKey is set; unauthenticated routes fall back to req.ip — identical
    // to the previous per-IP behaviour.
    keyGenerator: (req) => req.apiKey?.id ?? req.ip,
    // The plugin's default builder returns a bare Error with a statusCode and
    // no `code`, which our envelope rendered as `BAD_REQUEST` + "check the
    // request shape" — unswitchable, and actively misleading for a throttled
    // caller. Set once here: route-level configs inherit it, so every limiter
    // emits RATE_LIMITED with retryAfterSeconds.
    errorResponseBuilder: rateLimitError,
    ...(sharedRedis ? { redis: sharedRedis } : {}),
  });
  await app.register(sensible);
  // Parse application/x-www-form-urlencoded — the OAuth token + authorize
  // endpoints (MCP) receive form-encoded bodies per RFC 6749.
  await app.register(formbody);

  // Raw body capture — opt-in per route via `config: { rawBody: true }`. We
  // need this for Stripe webhook signature verification (the verifier hashes
  // the bytes Stripe sent; any reserialization breaks the HMAC).
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  // Error handler before any routes so hook-thrown RelipayError instances
  // hit our envelope, not Fastify's default error shape.
  app.setErrorHandler(relipayErrorHandler);

  // Stamp the request id on EVERY response, not just error ones — docs/errors.md
  // promises it unconditionally, and a client that wants to log the id of a
  // successful call (to correlate later) needs it there too.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });

  // 415 for form-encoded bodies on JSON-only routes. onRequest so it lands
  // before body parsing — see middleware/media-type.ts for why the global
  // formbody parser made this necessary.
  app.addHook('onRequest', rejectUnsupportedMediaType);

  // Coarse ceiling for auth endpoints, deliberately at `onRequest`.
  //
  // A route-level `config.rateLimit` REPLACES the global limiter's hook for that
  // route (the plugin's onRoute handler picks one or the other, it does not
  // layer them). authRateLimit() now spends its tight cap on a per-identity
  // bucket and, because that key needs the parsed body, runs at
  // `preValidation` — which left auth routes with NO rate check before body
  // parsing at all. An attacker could then push unbounded 1 MiB bodies at a
  // sign-in route and pay only the parse cost, which is a worse DoS surface
  // than the per-Application lockout this batch set out to fix.
  //
  // So this ceiling runs at `onRequest`, before any body is read, restoring a
  // bounded parse budget. Its key is `apiKey?.id ?? ip` — the same rule the
  // global limiter uses, and for the same reason: on routes where the API-key
  // hook hasn't resolved yet it degrades to per-IP, which is exactly the
  // protection unauthenticated routes already get.
  //
  // Driven through `createRateLimit` rather than a second `rateLimit()` hook on
  // purpose: the hook form sets a per-request "already ran" flag that the
  // route's own limiter shares, so it would silently disable the tight cap.
  const authCeiling = app.createRateLimit(
    authCeilingOptions(env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_MS),
  );
  app.addHook('onRequest', async (req) => {
    if (!wantsAuthCeiling(req.routeOptions?.config?.rateLimit)) return;
    const result = await authCeiling(req);
    // `isAllowed` is the union discriminant, not redundant with `isExceeded`:
    // narrowing on it is what makes ttl/max visible on the failure branch.
    if (result.isAllowed || !result.isExceeded) return;
    throw rateLimitedAfter(result.ttl, result.max);
  });

  // Generic Idempotency-Key support — opt-in per route via
  // `config: { idempotency: true }` (see middleware/idempotency.ts for the
  // full semantics). Instance-level hooks so they apply to every encapsulated
  // route plugin: the preHandler runs after the per-route onRequest auth
  // middlewares (it scopes keys to the authenticated principal) and the
  // onSend persists/discards the stored response. Both no-op instantly on
  // routes/requests that didn't opt in or don't send the header.
  app.addHook('preHandler', idempotencyPreHandler);
  app.addHook('onSend', idempotencyOnSend);

  // Per-request access log — a global onResponse hook enqueues one bounded row
  // per response. It runs AFTER the response is sent (zero client-latency cost)
  // and only pushes onto an in-memory buffer (no DB, no connection, never
  // throws) — the buffer is flushed to `api_request_logs` in batches by the
  // timer below, so request volume never touches the connection pool directly.
  // Identity is read off the request only after per-route auth middleware has
  // populated it; unauthenticated routes log anonymously. `routeOptions.url` is
  // the route *pattern* (no ids/query), so the log neither accumulates
  // high-cardinality paths nor leaks path params.
  app.addHook('onResponse', (req, reply, done) => {
    recordApiRequest({
      method: req.method,
      routePath: req.routeOptions?.url ?? req.url.split('?')[0] ?? req.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      applicationId: req.application?.id ?? null,
      // Operator (tenant-session) requests carry req.tenantId; API-key
      // requests don't, but their Application knows its tenant — enrich from
      // there so the workspace-scoped index is useful for both.
      tenantId: req.tenantId ?? req.application?.tenantId ?? null,
      operatorUserId: req.tenantUser?.id ?? null,
      ip: req.ip || null,
    });
    done();
  });

  // Always flush whatever is buffered on shutdown so the last requests aren't
  // lost on a graceful stop.
  app.addHook('onClose', async () => {
    await flushApiRequestLogs();
  });

  // Periodic batch flush + pruner. The flush writes the buffer in one
  // createMany every few seconds; the pruner caps each app/operator to the
  // last N rows (NOT per-insert — that write-amplification is what we're
  // avoiding). Both are skipped under test, where the suite calls
  // flushApiRequestLogs()/pruneApiRequestLogs() directly for determinism;
  // `.unref()` so neither timer keeps the process alive, both cleared on close.
  if (env.NODE_ENV !== 'test') {
    const FLUSH_INTERVAL_MS = 2_000;
    const flushTimer = setInterval(() => {
      void flushApiRequestLogs();
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref();

    const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
    const pruneTimer = setInterval(() => {
      void pruneApiRequestLogs().then((deleted) => {
        if (deleted > 0) app.log.debug({ deleted }, 'pruned api_request_logs');
      });
      // Expired single-use tokens: magic links + OAuth auth codes (app +
      // operator-MCP) and WebAuthn challenges. All inert past expiry — this
      // just stops the rows accumulating forever.
      void pruneExpiredAuthTokens()
        .then((deleted) => {
          if (deleted > 0) app.log.debug({ deleted }, 'pruned expired auth tokens');
        })
        .catch((err) => app.log.warn({ err }, 'auth-token prune failed'));
      void pruneExpiredChallenges()
        .then((deleted) => {
          if (deleted > 0) app.log.debug({ deleted }, 'pruned expired webauthn challenges');
        })
        .catch((err) => app.log.warn({ err }, 'webauthn-challenge prune failed'));
      // Generic Idempotency-Key rows (24 h TTL) — inert past expiry; the
      // sweep also clears in-flight reservations orphaned by a crash.
      void pruneExpiredIdempotencyKeys()
        .then((deleted) => {
          if (deleted > 0) app.log.debug({ deleted }, 'pruned expired idempotency keys');
        })
        .catch((err) => app.log.warn({ err }, 'idempotency-key prune failed'));
    }, PRUNE_INTERVAL_MS);
    pruneTimer.unref();

    // Outbound-webhook retry poller. Primary scheduling is BullMQ when Redis is
    // configured (delayed jobs survive a crash), or in-process setTimeout
    // otherwise (webhook.service.ts). Either way this poller re-attempts PENDING
    // deliveries whose nextAttemptAt has passed — the backstop for a row
    // orphaned by a Redis flush or a lost timer. Per-row atomic claims make the
    // poller, the queue worker, and the timer safe to overlap.
    const WEBHOOK_RETRY_POLL_INTERVAL_MS = 60 * 1000;
    const webhookRetryTimer = setInterval(() => {
      void processDueWebhookDeliveries().catch((err) =>
        app.log.warn({ err }, 'webhook retry poll failed'),
      );
    }, WEBHOOK_RETRY_POLL_INTERVAL_MS);
    webhookRetryTimer.unref();

    // Dunning scheduler — advances OPEN DunningCases whose nextActionAt has
    // passed (day-3/7 reminder emails, day-14 exhaustion). Per-case atomic
    // claims inside processDueDunningCases make multiple replicas safe; 10
    // minutes of skew is irrelevant against a day-granular schedule.
    const DUNNING_POLL_INTERVAL_MS = 10 * 60 * 1000;
    const dunningTimer = setInterval(() => {
      void processDueDunningCases(100, app.log).catch((err) =>
        app.log.warn({ err }, 'dunning poll failed'),
      );
    }, DUNNING_POLL_INTERVAL_MS);
    dunningTimer.unref();

    // BullMQ webhook-delivery worker — REQUIRED outside test. Installs the
    // Redis-backed scheduler so delayed retries survive a crash and distribute
    // across replicas (microservice-compatible). startWebhookWorker THROWS if
    // Redis is unreachable, failing buildApp() so the server refuses to boot
    // without a working queue. The DB poller above stays as the crash backstop.
    if (isQueueEnabled()) {
      await startWebhookWorker(app.log);
    }

    app.addHook('onClose', async () => {
      clearInterval(flushTimer);
      clearInterval(pruneTimer);
      clearInterval(webhookRetryTimer);
      clearInterval(dunningTimer);
      await stopWebhookWorker();
    });
  }

  await registerSwagger(app);

  await app.register(healthRoutes);
  // Deployment JWKS (RS256 public keys for end-user access tokens). Root-level
  // well-known path, public, no auth — serves public key material only.
  await app.register(jwksRoutes);

  // Public surface — Application API key auth.
  await app.register(meRoutes, { prefix: '/api/v1/me' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(authenticatedAuthRoutes, { prefix: '/api/v1/auth' });
  // User-token-only `GET /api/v1/auth/me` — no secret key (browser SDKs).
  // Separate plugin so it does NOT inherit authRoutes' requireApiKey hook.
  await app.register(userTokenMeRoutes, { prefix: '/api/v1/auth' });
  await app.register(oauthRoutes, { prefix: '/api/v1/auth/oauth' });
  await app.register(oauthLinkRoutes, { prefix: '/api/v1/auth/oauth' });
  await app.register(usersMeRoutes, { prefix: '/api/v1/users/me' });
  // End-user organizations — gated by `authConfig.organizationsEnabled`
  // at the service layer. Routes are mounted regardless; the service
  // refuses on apps that didn't opt in.
  await app.register(organizationsAuthenticatedRoutes, {
    prefix: '/api/v1/users/me/organizations',
  });
  await app.register(organizationsAcceptInvitationRoutes, {
    prefix: '/api/v1/auth/organizations',
  });
  await app.register(billingRoutes, { prefix: '/api/v1/billing' });
  await app.register(couponsPublicRoutes, { prefix: '/api/v1/billing/coupons' });
  await app.register(mfaRoutes, { prefix: '/api/v1/auth/mfa' });
  await app.register(licensesPublicRoutes, { prefix: '/api/v1/licenses' });
  await app.register(usagePublicRoutes, { prefix: '/api/v1/usage' });
  await app.register(creditsPublicRoutes, { prefix: '/api/v1/credits' });
  // Hosted customer portal — public config lookup by slug (Portal V2).
  await app.register(portalConfigRoutes, { prefix: '/api/v1/portal' });
  // Per-Application MCP server + OAuth 2.1 AS (gated per-app by authConfig.mcpEnabled).
  await app.register(mcpRoutes, { prefix: '/api/v1/mcp' });
  // Root-level "path-insertion" OAuth metadata discovery (RFC 8414 / 9728). A
  // strict connector constructs the metadata URL by inserting the well-known
  // segment right after the origin and re-appending the issuer's path
  // (`/.well-known/oauth-authorization-server/api/v1/mcp/<slug>`), which the
  // suffix-form routes above 404. Registered with NO prefix so the well-known
  // segment sits directly under the origin; same bodies + mcpEnabled gating.
  await app.register(mcpWellKnownRoutes);

  // Webhook ingestion — provider signature is the auth (no API key here).
  await app.register(stripeWebhookRoutes, { prefix: '/api/v1/billing/webhook' });
  await app.register(paypalWebhookRoutes, { prefix: '/api/v1/billing/webhook' });
  await app.register(razorpayWebhookRoutes, { prefix: '/api/v1/billing/webhook' });
  // Generic provider-module pipeline (docs/specs/billing-provider-modules.md).
  // The legacy per-provider URLs above stay registered forever — operators
  // have them configured at the provider — and (Stripe since P1) forward
  // into this same pipeline.
  await app.register(billingProviderWebhookRoutes, { prefix: '/api/v1/webhooks/billing' });

  // Tenant operator surface — email/password auth, workspace memberships,
  // tenant-scoped admin. The panel uses these day-to-day.
  await app.register(tenantAuthRoutes, { prefix: '/api/v1/tenant/auth' });
  await app.register(tenantAuthAuthenticatedRoutes, { prefix: '/api/v1/tenant/auth' });
  await app.register(tenantInvitationPublicRoutes, { prefix: '/api/v1/tenant/invitations' });
  await app.register(tenantInvitationAuthRoutes, { prefix: '/api/v1/tenant/invitations' });
  await app.register(tenantWorkspacesRoutes, { prefix: '/api/v1/tenant/workspace' });
  await app.register(tenantApplicationsRoutes, { prefix: '/api/v1/tenant/applications' });
  // Operator-PAT-gated surface — authenticated by `rp_op_…` personal-access-tokens
  // (Authorization: Bearer) instead of a session JWT. Default-deny on writes.
  await app.register(operatorTokenRoutes, { prefix: '/api/v1/tenant/operator' });
  // Operator-side MCP server — JSON-RPC at /api/v1/tenant/mcp. Gated by the
  // same operator PAT as `/api/v1/tenant/operator/*`. OAuth 2.1 AS layered on
  // top in a future iteration (Phase 2).
  // Operator MCP OAuth AS (Phase 2) — discovery + register + authorize +
  // token + introspect. Registered BEFORE tenantMcpRoutes so the OAuth
  // endpoints under the same prefix don't fall into the JSON-RPC catch-all.
  // Gated by OPERATOR_MCP_ENABLED (default on): when disabled, neither plugin
  // mounts, so the whole /api/v1/tenant/mcp surface 404s.
  if (env.OPERATOR_MCP_ENABLED) {
    await app.register(operatorMcpOAuthRoutes, { prefix: '/api/v1/tenant/mcp' });
    await app.register(tenantMcpRoutes, { prefix: '/api/v1/tenant/mcp' });
    // Root-level path-insertion OAuth metadata discovery (RFC 8414 / 9728) for
    // the operator MCP — mirrors `mcpWellKnownRoutes` for the per-app server.
    // A strict connector (Claude) constructs the metadata URL by inserting the
    // well-known segment right after the origin and re-appending the issuer
    // path (`/.well-known/oauth-authorization-server/api/v1/tenant/mcp`), which
    // the suffix-form routes above 404. Registered with NO prefix so the
    // well-known segment sits directly under the origin.
    await app.register(operatorMcpWellKnownRoutes);
  }
  await app.register(tenantEmailRoutes, { prefix: '/api/v1/tenant/applications' });
  await app.register(tenantWebhookRoutes, { prefix: '/api/v1/tenant/applications' });
  await app.register(tenantMfaRoutes, { prefix: '/api/v1/tenant/auth/mfa' });
  await app.register(securityEventsRoutes, { prefix: '/api/v1/tenant/security-events' });
  await app.register(tenantPasskeysAuthenticatedRoutes, { prefix: '/api/v1/tenant/auth' });
  await app.register(tenantPasskeysPublicRoutes, { prefix: '/api/v1/tenant/auth' });
  await app.register(tenantOAuthPublicRoutes, { prefix: '/api/v1/tenant/auth' });

  // Bootstrap admin surface — gated by SUPER_ADMIN_KEY. Useful for the very
  // first deploy + ops escape hatch. Day-to-day uses /api/v1/tenant/* above.
  await app.register(tenantsRoutes, { prefix: '/api/v1/admin/tenants' });
  await app.register(applicationsRoutes, { prefix: '/api/v1/admin/applications' });
  await app.register(apiKeysRoutes, { prefix: '/api/v1/admin/applications' });
  await app.register(plansRoutes, { prefix: '/api/v1/admin/applications' });
  await app.register(couponsAdminRoutes, { prefix: '/api/v1/admin/applications' });
  // Operator-invite key management (mint/list/revoke). Gates new-operator
  // registration when OPERATOR_SIGNUP_MODE='invite'. Gated by SUPER_ADMIN_KEY.
  await app.register(operatorInvitesRoutes, { prefix: '/api/v1/admin/operator-invites' });
  // Read-only deployment-wide rollups for the super-admin dashboard
  // (apps/admin → admin.relipay.dev). GET-only; gated by SUPER_ADMIN_KEY.
  await app.register(adminMetricsRoutes, { prefix: '/api/v1/admin/metrics' });

  app.setNotFoundHandler((req, reply) => {
    // `requestId` here too: docs/errors.md documents it on every error envelope,
    // and a 404 that turns out to be a routing/proxy problem is exactly the case
    // where an operator wants to find the matching log line.
    reply.header('X-Request-Id', req.id);
    return reply.status(404).send({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'Route not found.',
        fix: 'Browse /docs for the full route list.',
        requestId: req.id,
      },
    });
  });

  return app;
}
