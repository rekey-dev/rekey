/**
 * Build the Fastify app instance.
 *
 * Pulled out of `index.ts` so tests can `import { buildApp } from '../src/app'`
 * and use Fastify's `app.inject()` to fire requests in-process, no port
 * binding, no flaky network behaviour.
 */

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import formbody from "@fastify/formbody";
import rawBody from "fastify-raw-body";
import { collectRouteAccess } from "./lib/route-access.js";
import { getRedis, closeRedis } from "./lib/redis.js";
import { closeOperatorAuthCache } from "./lib/operator-auth-cache.js";
import { closeOrganizationRoleCache } from "./lib/organization-role-cache.js";
import { isQueueEnabled } from "./lib/queue.js";
import { primeCorsOrigins, isRegisteredAppOrigin } from "./lib/cors-origins.js";

import { env, corsAllowedOrigins } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { jwksRoutes } from "./routes/jwks.js";
import { rekeyErrorHandler } from "./lib/error.js";
import { requestIdFor } from "./lib/request-id.js";
import {
  authCeilingOptions,
  globalRateLimitKey,
  globalRateLimitAllowList,
  globalRateLimitMaxFor,
  presentedSecretKey,
  createVerifiedKeyMemo,
  credentialKindOf,
  rateLimitError,
  rateLimitedAfter,
  resolveGlobalBudgets,
  wantsAuthCeiling,
  createAuthFailureLimiter,
  authenticatedIpCeilingKey,
  globalRateLimitMax,
  type GlobalRateLimitBudgets,
} from "./lib/rate-limit.js";
import { rejectUnsupportedMediaType } from "./middleware/media-type.js";
import {
  CLIENT_IP_VOUCHED,
  createClientIpResolver,
  proxySecretWarning,
  type ClientIpPolicy,
} from "./lib/client-ip.js";
import { recordApiRequest, flushApiRequestLogs } from "./lib/request-log.js";
import {
  idempotencyPreHandler,
  idempotencyOnSend,
} from "./middleware/idempotency.js";
import {
  processDueWebhookDeliveries,
  stopScheduledDeliveries,
} from "./modules/webhooks/webhook.service.js";
import { processDueDunningCases } from "./modules/billing/dunning.service.js";
import { runPruneSweep } from "./lib/prune-sweep.js";
import {
  createS3LogArchiver,
  resolveLogArchiveConfig,
} from "./lib/log-archive.js";
import { registerSwagger } from "./lib/swagger.js";
import { tenantsRoutes } from "./modules/tenants/index.js";
import { applicationsRoutes } from "./modules/applications/index.js";
import { apiKeysRoutes } from "./modules/api-keys/index.js";
import {
  authRoutes,
  authenticatedAuthRoutes,
  userTokenMeRoutes,
} from "./modules/auth/index.js";
import { plansRoutes } from "./modules/plans/index.js";
import {
  couponsAdminRoutes,
  couponsPublicRoutes,
} from "./modules/coupons/index.js";
import { billingRoutes, billingAdminRoutes } from "./modules/billing/index.js";
import {
  stripeWebhookRoutes,
  paypalWebhookRoutes,
  razorpayWebhookRoutes,
  billingProviderWebhookRoutes,
} from "./modules/billing/webhooks/index.js";
import { meRoutes } from "./routes/me.js";
import { usersMeRoutes } from "./routes/users-me.js";
import { usersRoutes } from "./routes/users.js";
import { usersImportRoutes } from "./routes/users-import.js";
import {
  tenantAuthRoutes,
  tenantAuthAuthenticatedRoutes,
  operatorTokenRoutes,
} from "./modules/tenant-auth/index.js";
import {
  tenantWorkspacesRoutes,
  tenantInvitationPublicRoutes,
  tenantInvitationAuthRoutes,
} from "./modules/tenant-workspaces/index.js";
import { tenantApplicationsRoutes } from "./modules/tenant-applications/index.js";
import { oauthRoutes, oauthLinkRoutes } from "./modules/oauth/index.js";
import { mfaRoutes } from "./modules/mfa/index.js";
import { tenantMfaRoutes } from "./modules/tenant-mfa/index.js";
import {
  tenantPasskeysAuthenticatedRoutes,
  tenantPasskeysPublicRoutes,
} from "./modules/tenant-passkeys/index.js";
import { tenantOAuthPublicRoutes } from "./modules/tenant-oauth/index.js";
import {
  licensesPublicRoutes,
  licensesSelfRoutes,
  tenantLicenseActivationRoutes,
} from "./modules/licenses/index.js";
import {
  devicesServerRoutes,
  devicesUserRoutes,
  tenantDevicesRoutes,
} from "./modules/devices/index.js";
import { portalConfigRoutes } from "./modules/portal/index.js";
import { usagePublicRoutes, usageSelfRoutes } from "./modules/usage/index.js";
import { creditsPublicRoutes, creditsSelfRoutes } from "./modules/credits/index.js";
import { tenantEmailRoutes } from "./modules/email/index.js";
import {
  tenantWebhookRoutes,
  startWebhookWorker,
  stopWebhookWorker,
} from "./modules/webhooks/index.js";
import {
  organizationsAuthenticatedRoutes,
  organizationsAcceptInvitationRoutes,
} from "./modules/organizations/index.js";
import { securityEventsRoutes } from "./modules/security-events/index.js";
import { mcpRoutes, mcpWellKnownRoutes } from "./modules/mcp/index.js";
import { adminMetricsRoutes } from "./modules/admin-metrics/index.js";
import { operatorInvitesRoutes } from "./modules/operator-invites/index.js";
import {
  tenantMcpRoutes,
  operatorMcpOAuthRoutes,
  operatorMcpWellKnownRoutes,
} from "./modules/tenant-mcp/index.js";
import {
  adminIpAllowlistWarning,
  assertAdminIpAllowlistValid,
} from "./middleware/admin-auth.js";
import { assertDefaultTenantLimitsValid } from "./lib/tenant-limits.js";
import { shutdownBcryptPool } from "./lib/bcrypt-pool.js";

export interface BuildAppOptions {
  /** Override the default logger config (e.g. silence in tests). */
  logger?: boolean | Record<string, unknown>;
  /**
   * Override individual rate-limit budgets for this app instance. For tests:
   * env is parsed once per process, and a budget in the thousands is too slow
   * to exhaust on the wire. Production reads env only.
   */
  rateLimitOverrides?: Partial<GlobalRateLimitBudgets>;
  /** Override API_PROXY_SECRET / API_PROXY_HOPS for this instance (tests; env is parsed once). */
  apiProxy?: { secret?: string; hops?: number; callerSecret?: string };
  /** Replace the client-address resolver (tests: forcing a failure). */
  clientIpResolver?: (raw: import("node:http").IncomingMessage) => boolean;
}

/** Entries proxy-addr understands besides literal IPs/CIDRs. */
const PROXY_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

/** Rough IPv4/IPv6/CIDR shape check, proxy-addr throws on malformed input. */
function looksLikeAddress(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) return true;
  const [addr, mask, ...rest] = entry.split("/");
  if (rest.length > 0 || !addr) return false;
  if (mask !== undefined && !/^\d{1,3}$/.test(mask)) return false;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  if (ipv4.test(addr)) {
    return addr.split(".").every((o) => Number(o) <= 255);
  }
  return ipv6.test(addr) && addr.includes(":");
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
 * X-Forwarded-For and thereby request.ip, which rate limits, lockout, and IP
 * allowlists all key off. Anything unparseable throws at boot rather than
 * leaving proxy-addr to fail per-request on malformed input.
 */
export function trustProxyConfig(
  raw: string | undefined = process.env.TRUSTED_PROXIES,
): false | number | string[] {
  const value = raw?.trim();
  if (!value || value === "false") return false;

  const hops = Number(value);
  if (!Number.isNaN(hops)) {
    if (Number.isInteger(hops) && hops > 0) return hops;
    throw new Error(
      `[CONFIG] TRUSTED_PROXIES="${value}" is not a valid hop count — use a positive integer, an IP/CIDR list, or leave it unset.`,
    );
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const invalid = entries.filter((entry) => !looksLikeAddress(entry));
  if (entries.length === 0 || invalid.length > 0) {
    throw new Error(
      `[CONFIG] TRUSTED_PROXIES contains entries that are not an IP, CIDR, or proxy-addr keyword: ${invalid.join(", ") || "(empty)"}. ` +
        "Trusting X-Forwarded-For from the wrong source lets clients forge request.ip.",
    );
  }
  return entries;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  // Fail the boot on a malformed ADMIN_IP_ALLOWLIST rather than starting with a
  // gate that silently matches nothing (see the middleware for the reasoning).
  assertAdminIpAllowlistValid();
  // Same posture for DEFAULT_TENANT_LIMITS: a default that cannot be parsed
  // would leave every new workspace unlimited while the operator believes they
  // are capped. Refuse to start instead (see lib/tenant-limits.ts).
  assertDefaultTenantLimitsValid();

  // Which forwarded client address to believe: see lib/client-ip.ts. Parsed
  // here so a malformed TRUSTED_PROXIES still fails the boot.
  let lastUnprovenProxyWarning = 0;
  // Replaced by a real logger call once the Fastify logger exists (below).
  let logUnprovenProxy: (peer: string) => void = () => undefined;
  const clientIpPolicy: ClientIpPolicy = {
    internalCallers: trustProxyConfig(),
    proxySecret: options.apiProxy?.secret ?? env.API_PROXY_SECRET,
    proxyHops: options.apiProxy?.hops ?? env.API_PROXY_HOPS,
    internalCallerSecret:
      options.apiProxy?.callerSecret ?? env.INTERNAL_CALLER_SECRET,
    // At most one warning per 10 minutes: it can fire on every request.
    onUnprovenProxy: (peer) => {
      const now = Date.now();
      if (now - lastUnprovenProxyWarning < 10 * 60_000) return;
      lastUnprovenProxyWarning = now;
      logUnprovenProxy(peer);
    },
  };
  const resolveClientIp =
    options.clientIpResolver ?? createClientIpResolver(clientIpPolicy);
  // The Fastify logger does not exist yet when rewriteUrl is defined; the
  // first failure is reported through it once it does.
  let logResolverFailure: (err: unknown) => void = () => undefined;

  const app = Fastify({
    logger:
      options.logger ??
      ({
        level: env.NODE_ENV === "production" ? "info" : "debug",
        redact: {
          paths: [
            "headers.authorization",
            "req.headers.authorization",
            "body.rawKey",
            "body.password",
            "*.rawKey",
          ],
          censor: "[REDACTED]",
        },
      } as Record<string, unknown>),
    bodyLimit: 1024 * 1024,
    // Trusting X-Forwarded-For means trusting whoever set it. Keyed off
    // NODE_ENV this was `true` in production for ANY peer, so a client could
    // mint unlimited rate-limit buckets (and forge request.ip for lockout and
    // IP allowlists) with one header, measured: 60/60 requests bypassed the
    // limiter with a rotating XFF. Now opt-in and explicit: set TRUSTED_PROXIES
    // to your proxy's IP/CIDR list, or a hop count, once you actually run
    // behind one. Default off = request.ip is the real socket peer.
    //
    // Fastify trusts exactly one hop, which is equivalent to trusting nobody:
    // `rewriteUrl` below runs on the raw request before Fastify builds its
    // request object or writes its "incoming request" log line, and leaves at
    // most ONE address in X-Forwarded-For (the one lib/client-ip.ts decided to
    // believe), deleting it otherwise, along with any forwarded host or scheme
    // that did not come from our proxy. So `request.ip` and every log line see
    // the decided address and never a header a client chose.
    trustProxy: 1,
    // Not a URL rewrite: the one hook Fastify runs on the raw request before
    // routing and logging, for inject() as well as the server. Returns the URL
    // unchanged.
    rewriteUrl(req) {
      // Fastify calls this without a try/catch, so a throw here would take the
      // process down. Any failure leaves the address unvouched: never blocked
      // by IP, and the forwarded header gone.
      let vouched = false;
      try {
        vouched = resolveClientIp(req);
      } catch (err) {
        delete req.headers["x-forwarded-for"];
        logResolverFailure(err);
      }
      (req as unknown as Record<symbol, boolean>)[CLIENT_IP_VOUCHED] = vouched;
      return req.url ?? "/";
    },
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
    // nothing. `requestIdHeader: false` disables Fastify's own header handling,
    // it would adopt an inbound value verbatim, and genReqId takes over, so an
    // inbound X-Request-Id is honoured for trace continuity but sanitised and
    // length-capped first (see lib/request-id.ts).
    requestIdHeader: false,
    genReqId: (req) => requestIdFor(req.headers as Record<string, unknown>),
  });

  // Collect every route's `config.access` declaration as it registers. Must
  // sit before the first route plugin, `onRoute` only sees routes added
  // after it. The completeness test reads the table this builds; the scope
  // gate will read the same declarations. See lib/route-access.ts.
  collectRouteAccess(app);

  // FIRST onRequest hook, before any plugin reads request.ip. The decision was
  // already made in `rewriteUrl` above, which rewrote the forwarded header to
  // what can be believed (lib/client-ip.ts); this hook only copies whether
  // request.ip is a client address safe to block by onto the request. Per-IP
  // guards read `clientIpVouched`; unvouched traffic falls back to
  // per-credential, per-account and per-Application limits.
  logUnprovenProxy = (peer) =>
    app.log.warn(
      { peer },
      "API_PROXY_SECRET is set, but a request from a private-network peer carried X-Forwarded-For without X-Rekey-Proxy-Secret. " +
        "Per-IP limits are OFF for that traffic. Check that every router to the API carries the proxy-secret middleware " +
        "(a domain added in the Dokploy UI does not). See docs/rate-limits.md.",
    );
  logResolverFailure = (err) =>
    app.log.error(
      { err },
      "client address resolver failed; request treated as unvouched",
    );
  app.decorateRequest("clientIpVouched", false);
  app.addHook("onRequest", async (req) => {
    req.clientIpVouched =
      (req.raw as unknown as Record<symbol, boolean>)[CLIENT_IP_VOUCHED] ===
      true;
  });
  const proxyWarning = proxySecretWarning(clientIpPolicy);
  if (proxyWarning && env.NODE_ENV !== "test") app.log.warn(proxyWarning);
  const adminWarning = adminIpAllowlistWarning(clientIpPolicy);
  if (adminWarning && env.NODE_ENV !== "test") app.log.warn(adminWarning);

  // CORS, strict allowlist. Reflective `origin: true` is forbidden because
  // browsers will happily send our `rekey_*` credential cookies from any
  // page that the dynamic ACAO header endorses. The allowlist is sourced
  // from CORS_ALLOWED_ORIGINS; dev permits localhost so the panel + sample
  // apps work without manual config.
  const isDev = env.NODE_ENV !== "production";
  const allowList = new Set(corsAllowedOrigins);
  const localhostRe = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  // Warm the per-Application origin cache so the first request sees it.
  await primeCorsOrigins();
  await app.register(cors, {
    credentials: true,
    origin(origin, cb) {
      // Same-origin / non-browser callers (curl, server-to-server) send no
      // Origin header, let those through; cookie auth doesn't apply there.
      if (!origin) return cb(null, true);
      // Global env allowlist (operator/panel origins).
      if (allowList.has(origin)) return cb(null, true);
      // Per-Application origins, any origin a tenant registered for their app.
      if (isRegisteredAppOrigin(origin)) return cb(null, true);
      if (isDev && localhostRe.test(origin)) return cb(null, true);
      // Returning `false` causes @fastify/cors to omit ACAO entirely, which
      // the browser then rejects. We don't throw, surfacing a 500 here
      // leaks the CORS shape; silent omission is the correct posture.
      return cb(null, false);
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === "production",
  });

  // Rate limiter. The default in-memory store is per-process, so with multiple
  // API replicas the effective limit multiplies. We back it with the shared
  // Redis client (null in test → in-memory) so the limit is shared across
  // replicas. Store errors fail open, see `skipOnError` below.
  // Per-route tighter caps on auth endpoints layer on top via authRateLimit().
  const sharedRedis = getRedis();
  const budgets: GlobalRateLimitBudgets = {
    ...resolveGlobalBudgets(env),
    ...options.rateLimitOverrides,
  };
  if (sharedRedis) {
    app.addHook("onClose", async () => {
      await closeRedis();
    });
  }
  await app.register(rateLimit, {
    // One budget per kind of caller, chosen from the bucket key below: per
    // secret API key, per operator / signed-in end user, else per client IP.
    // See `globalRateLimitKey` in lib/rate-limit.ts.
    max: globalRateLimitMaxFor(budgets),
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Fail OPEN when the store errors, deliberately, and ONLY here.
    //
    // This limiter protects throughput, not credentials, so letting requests
    // through during a store outage is better than turning a Redis restart into
    // a full outage. The auth tier does the opposite: `authCeilingOptions` and
    // `authRateLimit` both set `skipOnError: false` so credential endpoints fail
    // closed, and lib/brute-force.ts raises 503 rather than reading an
    // unreachable lock as "not locked". Do not "fix" the asymmetry by making
    // this one closed as well without re-reading both of those.
    //
    // This is nominally the plugin default,
    // but with `enableOfflineQueue: false` on our ioredis client a Redis
    // outage surfaced as a synchronous throw ("Stream isn't writeable") that
    // 500'd EVERY route, including /health and pure-Postgres reads. Set it
    // explicitly so the behaviour is stated, not inherited. Losing rate
    // limiting for the duration of a Redis outage is strictly better than
    // losing the whole API.
    skipOnError: true,
    // Key by the caller's proven identity (API key, operator, end user) and
    // fall back to the client IP only when there is none. Keying operators on
    // the IP put every panel user behind the panel container's one address.
    // The route's own onRequest auth hooks run before this plugin's hook, which
    // test/rate-limit-keying.test.ts proves for each identity kind.
    keyGenerator: globalRateLimitKey,
    // Never block a shared, unvouched address (see lib/client-ip.ts).
    allowList: globalRateLimitAllowList,
    // The plugin's default builder returns a bare Error with a statusCode and
    // no `code`, which our envelope rendered as `BAD_REQUEST` + "check the
    // request shape", unswitchable, and actively misleading for a throttled
    // caller. Set once here: route-level configs inherit it, so every limiter
    // emits RATE_LIMITED with retryAfterSeconds.
    errorResponseBuilder: rateLimitError,
    ...(sharedRedis ? { redis: sharedRedis } : {}),
  });
  await app.register(sensible);
  // Parse application/x-www-form-urlencoded, the OAuth token + authorize
  // endpoints (MCP) receive form-encoded bodies per RFC 6749.
  await app.register(formbody);

  // Raw body capture, opt-in per route via `config: { rawBody: true }`. We
  // need this for Stripe webhook signature verification (the verifier hashes
  // the bytes Stripe sent; any reserialization breaks the HMAC).
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });

  // Error handler before any routes so hook-thrown RekeyError instances
  // hit our envelope, not Fastify's default error shape.
  app.setErrorHandler(rekeyErrorHandler);

  // Stamp the request id on EVERY response, not just error ones, docs/errors.md
  // promises it unconditionally, and a client that wants to log the id of a
  // successful call (to correlate later) needs it there too.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
  });

  // 415 for form-encoded bodies on JSON-only routes. onRequest so it lands
  // before body parsing, see middleware/media-type.ts for why the global
  // formbody parser made this necessary.
  // A NUL byte in the query string can never be valid input: Postgres `text`
  // cannot hold one, so every such value reaches the driver and comes back as
  // `22021 invalid byte sequence for encoding "UTF8"`, a 500 telling the
  // caller to contact support about their own malformed request. Rejecting at
  // the edge covers every string filter at once, rather than adding a
  // refinement to each of the dozen schemas that happen to parse one today.
  app.addHook("onRequest", async (req, reply) => {
    if (req.raw.url?.includes("%00") || req.raw.url?.includes("\u0000")) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_QUERY",
          message: "Query string contains a NUL byte.",
          fix: "Remove the %00 sequence from the request URL.",
          requestId: req.id,
        },
      });
    }
  });

  // The same NUL guard, for the JSON body.
  //
  // The query-string hook above was added first and the body was left alone,
  // which an external audit then walked straight through: a NUL inside any
  // JSON string reached Prisma and Postgres answered `22021 invalid byte
  // sequence`, surfacing as a 500 on 19 routes, including operator sign-up
  // and MCP dynamic client registration, both UNAUTHENTICATED. A caller could
  // produce a 500 on demand.
  //
  // preValidation, so it runs after the body is parsed and before any schema:
  // this is about a byte Postgres cannot store, not about any one route's
  // shape, and putting it here means the next route to accept a string is
  // covered without anyone remembering to think about it.
  app.addHook("preValidation", async (req, reply) => {
    if (
      req.body !== undefined &&
      req.body !== null &&
      containsNulByte(req.body)
    ) {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_BODY",
          message: "Request body contains a NUL byte.",
          fix: "Remove the \\u0000 character from the request body.",
          requestId: req.id,
        },
      });
    }
  });

  app.addHook("onRequest", rejectUnsupportedMediaType);

  // Rejected credentials, counted per client IP. See `createAuthFailureLimiter`
  // for why: the global limiter runs AFTER the auth hooks, so a refused
  // credential never reached it. This check is a ROOT onRequest hook, so it
  // runs before every child plugin's auth hook and a refused address costs no
  // lookup. It only blocks by address when lib/client-ip.ts could vouch for
  // `req.ip`, so it is the forwarded visitor and never the panel or portal peer
  // they share; unvouched traffic is counted by credential kind instead.
  const verifiedKeys = createVerifiedKeyMemo({
    redis: sharedRedis,
    ttlMs: 24 * 60 * 60_000,
    onStoreError: (err) =>
      app.log.warn({ err }, "verified-key memo store unavailable"),
  });
  app.addHook("onClose", async () => verifiedKeys.dispose());
  const authFailures = createAuthFailureLimiter({
    max: budgets.authFailuresPerIp,
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    redis: sharedRedis,
    onStoreError: (err) =>
      app.log.warn(
        { err },
        "auth-failure limiter store unavailable; failing open",
      ),
  });
  app.addHook("onRequest", async (req) => {
    if (req.routeOptions?.config?.rateLimit === false) return;
    // Only an address we can vouch for is blocked: behind a proxy we cannot
    // identify, the address is shared by everyone behind it.
    if (!req.clientIpVouched) return;
    const ttl = await authFailures.blocked(req.ip);
    if (ttl <= 0) return;
    // A blocked address is refused BEFORE any lookup, except for a secret key
    // that has already verified (recognised from memory, no lookup). A forged
    // or unknown key is refused like anything else.
    const rawKey = presentedSecretKey(req);
    if (rawKey !== null && (await verifiedKeys.known(rawKey))) return;
    throw rateLimitedAfter(ttl, budgets.authFailuresPerIp);
  });
  // Remember a secret key once it has verified (requireApiKey ran as an
  // onRequest hook, so req.apiKey is set by preValidation).
  app.addHook("preValidation", async (req) => {
    if (!req.apiKey || req.authKind !== "secret") return;
    const rawKey = presentedSecretKey(req);
    if (rawKey !== null)
      await verifiedKeys.remember(rawKey, req.apiKey.expiresAt);
  });
  app.addHook("onResponse", async (req, reply) => {
    if (reply.statusCode !== 401 && !req.credentialRefused) return;
    if (req.clientIpVouched) {
      await authFailures.record(req.ip);
      return;
    }
    // Unvouched: counted by credential kind, for detection only. Blocking a
    // KIND from a shared address would refuse every legitimate caller of that
    // kind behind it, the outage this path exists to avoid.
    const kind = credentialKindOf(req);
    const count = await authFailures.record(`kind:${kind}`);
    if (count === budgets.authFailuresPerIp) {
      req.log.warn(
        { credentialKind: kind, failuresInWindow: count },
        "rejected credentials of one kind through an unidentified proxy passed the per-IP limit; set API_PROXY_SECRET to block by client",
      );
    }
  });

  // Per-IP ceiling across every operator and end user seen from one address.
  // Identity keying gives each account its own budget, and end users can be
  // minted by signing up, so without this one address could multiply its
  // budget by the number of accounts it holds. API-key traffic is exempt: a
  // customer backend legitimately sends all of it from one address, and keys
  // cannot be minted by the caller. preValidation, so the identity is known.
  const authenticatedIpCeiling = app.createRateLimit({
    max: globalRateLimitMax(budgets.authenticatedPerIp),
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: authenticatedIpCeilingKey,
  });
  app.addHook("preValidation", async (req) => {
    if (req.apiKey || (!req.tenantUser && !req.endUser)) return;
    if (!req.clientIpVouched) return;
    if (req.routeOptions?.config?.rateLimit === false) return;
    const result = await authenticatedIpCeiling(req);
    if (result.isAllowed || !result.isExceeded) return;
    throw rateLimitedAfter(result.ttl, result.max);
  });

  // Coarse ceiling for auth endpoints, at `preValidation`.
  //
  // A route-level `config.rateLimit` REPLACES the global limiter's hook for that
  // route (the plugin's onRoute handler picks one or the other, it does not
  // layer them), so auth routes would otherwise have only their own tight cap.
  //
  // It runs at `preValidation`, like `authRateLimit`, because both keys need
  // something Fastify resolves by then: the parsed body, and the Application.
  // Neither is in place when the body is parsed, so the parse cost is bounded
  // by a per-route `bodyLimit` instead (lib/body-limits.ts), which needs no
  // identity and bites on `Content-Length` before a byte is read.
  //
  // The key is the Application where one resolved, else the secret key, else
  // the client IP (`authCeilingKey`). Operator sign-in routes have no
  // Application, so they key on the IP, and that is only the REAL client when
  // lib/client-ip.ts can vouch for it: otherwise every sign-in attempt on the
  // deployment would share one bucket and anyone spraying the login page would
  // lock every operator out, which is why the hook below skips an unvouched
  // address. See docs/rate-limits.md.
  //
  // Driven through `createRateLimit` rather than a second `rateLimit()` hook on
  // purpose: the hook form sets a per-request "already ran" flag that the
  // route's own limiter shares, so it would silently disable the tight cap.
  const authCeiling = app.createRateLimit(
    authCeilingOptions(env.RATE_LIMIT_MAX, env.RATE_LIMIT_WINDOW_MS),
  );
  // preValidation, not onRequest. The key needs the resolved Application, and
  // `requireApiKey` runs as an onRequest hook on a CHILD instance, parent
  // hooks always run first, so at onRequest time there is nothing to key on
  // but the IP, which is exactly what made this ceiling per-IP in practice.
  app.addHook("preValidation", async (req) => {
    if (!wantsAuthCeiling(req.routeOptions?.config?.rateLimit)) return;
    // No Application to key on and an address shared by everyone behind an
    // unidentified proxy: this ceiling would lock every operator out.
    if (!req.application && !req.apiKey && !req.clientIpVouched) return;
    const result = await authCeiling(req);
    // `isAllowed` is the union discriminant, not redundant with `isExceeded`:
    // narrowing on it is what makes ttl/max visible on the failure branch.
    if (result.isAllowed || !result.isExceeded) return;
    throw rateLimitedAfter(result.ttl, result.max);
  });

  // Generic Idempotency-Key support, opt-in per route via
  // `config: { idempotency: true }` (see middleware/idempotency.ts for the
  // full semantics). Instance-level hooks so they apply to every encapsulated
  // route plugin: the preHandler runs after the per-route onRequest auth
  // middlewares (it scopes keys to the authenticated principal) and the
  // onSend persists/discards the stored response. Both no-op instantly on
  // routes/requests that didn't opt in or don't send the header.
  app.addHook("preHandler", idempotencyPreHandler);
  app.addHook("onSend", idempotencyOnSend);

  // Per-request access log, a global onResponse hook enqueues one bounded row
  // per response. It runs AFTER the response is sent (zero client-latency cost)
  // and only pushes onto an in-memory buffer (no DB, no connection, never
  // throws), the buffer is flushed to `api_request_logs` in batches by the
  // timer below, so request volume never touches the connection pool directly.
  // Identity is read off the request only after per-route auth middleware has
  // populated it; unauthenticated routes log anonymously. `routeOptions.url` is
  // the route *pattern* (no ids/query), so the log neither accumulates
  // high-cardinality paths nor leaks path params.
  app.addHook("onResponse", (req, reply, done) => {
    recordApiRequest({
      method: req.method,
      routePath: req.routeOptions?.url ?? req.url.split("?")[0] ?? req.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      applicationId: req.application?.id ?? null,
      // Operator (tenant-session) requests carry req.tenantId; API-key
      // requests don't, but their Application knows its tenant, enrich from
      // there so the workspace-scoped index is useful for both.
      tenantId: req.tenantId ?? req.application?.tenantId ?? null,
      operatorUserId: req.tenantUser?.id ?? null,
      ip: req.ip || null,
      // The scope that admitted this request, when a scope gate ran (a
      // restricted MEMBER on a scoped route). Null for OWNER/ADMIN, floors
      // and open routes. This log is a bounded tail; the durable record of
      // authority is the security event each write and MCP call records.
      admittedScope: req.accessDecision?.scope ?? null,
    });
    done();
  });

  // Always flush whatever is buffered on shutdown so the last requests aren't
  // lost on a graceful stop.
  app.addHook("onClose", async () => {
    await flushApiRequestLogs();
  });

  // Stop the delivery attempts the in-process test scheduler still holds. Its
  // timers are process-global, so without this an app's retries fire after it
  // closes, into whatever runs next in the same process. Outside test the
  // default scheduler never queues anything (BullMQ owns scheduling) and this
  // returns at once.
  app.addHook("onClose", async () => {
    await stopScheduledDeliveries();
  });

  // Terminate the bcrypt verification workers, if an imported hash ever
  // started them. They are unref'd while idle, so this is tidiness on a normal
  // stop, not what lets the process exit.
  app.addHook("onClose", async () => {
    await shutdownBcryptPool();
  });

  // The operator-auth and org-role caches each hold a dedicated Redis
  // subscriber connection; quit them with the app.
  app.addHook("onClose", async () => {
    await Promise.all([closeOperatorAuthCache(), closeOrganizationRoleCache()]);
  });

  // Periodic batch flush + pruner. The flush writes the buffer in one
  // createMany every few seconds; the pruner caps each app/operator to the
  // last N rows (NOT per-insert, that write-amplification is what we're
  // avoiding). Both are skipped under test, where the suite calls
  // flushApiRequestLogs()/pruneApiRequestLogs() directly for determinism;
  // `.unref()` so neither timer keeps the process alive, both cleared on close.
  if (env.NODE_ENV !== "test") {
    const FLUSH_INTERVAL_MS = 2_000;
    const flushTimer = setInterval(() => {
      void flushApiRequestLogs();
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref();

    // Resolved once, before the timer exists. A half-configured archive must
    // stop the boot: found ten minutes later inside a sweep, it would be a
    // warning in a log while rows were already being deleted unarchived.
    const logArchiveConfig = resolveLogArchiveConfig(env);
    const logArchiver = logArchiveConfig
      ? createS3LogArchiver(logArchiveConfig)
      : null;
    // 0 (the default) keeps every row: the sweep below is skipped entirely,
    // and the archive, if any, is never asked to store anything.
    const logRetentionDays =
      env.LOG_RETENTION_DAYS > 0 ? env.LOG_RETENTION_DAYS : null;
    const webhookEventRetentionDays =
      env.WEBHOOK_EVENT_RETENTION_DAYS > 0
        ? env.WEBHOOK_EVENT_RETENTION_DAYS
        : null;
    app.log.info(
      {
        retentionDays: logRetentionDays ?? "forever",
        webhookEventRetentionDays: webhookEventRetentionDays ?? "forever",
        archive: logArchiveConfig
          ? `${new URL(logArchiveConfig.endpoint).host}/${logArchiveConfig.bucket}/${logArchiveConfig.prefix}`
          : "off",
      },
      "log retention",
    );
    // Two guards. In process: a sweep that outlives the interval (a first run
    // against a large backlog, a slow archive) must not overlap the next tick
    // here. Across replicas: every replica runs this timer, so the sweep takes
    // a Redis lease and skips the tick when another replica holds it or Redis
    // is unreachable (lib/prune-sweep.ts, lib/sweep-lease.ts).
    let pruneSweepRunning = false;

    const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
    const pruneTimer = setInterval(() => {
      if (pruneSweepRunning) return;
      pruneSweepRunning = true;
      void runPruneSweep(getRedis(), {
        logRetentionDays,
        webhookEventRetentionDays,
        logArchiver,
        log: app.log,
      })
        .catch((err) => app.log.warn({ err }, "prune sweep failed"))
        .finally(() => {
          pruneSweepRunning = false;
        });
    }, PRUNE_INTERVAL_MS);
    pruneTimer.unref();

    // Outbound-webhook retry poller. Primary scheduling is BullMQ when Redis is
    // configured (delayed jobs survive a crash), or in-process setTimeout
    // otherwise (webhook.service.ts). Either way this poller re-attempts PENDING
    // deliveries whose nextAttemptAt has passed, the backstop for a row
    // orphaned by a Redis flush or a lost timer. Per-row atomic claims make the
    // poller, the queue worker, and the timer safe to overlap.
    const WEBHOOK_RETRY_POLL_INTERVAL_MS = 60 * 1000;
    const webhookRetryTimer = setInterval(() => {
      void processDueWebhookDeliveries().catch((err) =>
        app.log.warn({ err }, "webhook retry poll failed"),
      );
    }, WEBHOOK_RETRY_POLL_INTERVAL_MS);
    webhookRetryTimer.unref();

    // Dunning scheduler, advances OPEN DunningCases whose nextActionAt has
    // passed (day-3/7 reminder emails, day-14 exhaustion). Per-case atomic
    // claims inside processDueDunningCases make multiple replicas safe; 10
    // minutes of skew is irrelevant against a day-granular schedule.
    const DUNNING_POLL_INTERVAL_MS = 10 * 60 * 1000;
    const dunningTimer = setInterval(() => {
      void processDueDunningCases(100, app.log).catch((err) =>
        app.log.warn({ err }, "dunning poll failed"),
      );
    }, DUNNING_POLL_INTERVAL_MS);
    dunningTimer.unref();

    // BullMQ webhook-delivery worker, REQUIRED outside test. Installs the
    // Redis-backed scheduler so delayed retries survive a crash and distribute
    // across replicas (microservice-compatible). startWebhookWorker THROWS if
    // Redis is unreachable, failing buildApp() so the server refuses to boot
    // without a working queue. The DB poller above stays as the crash backstop.
    if (isQueueEnabled()) {
      await startWebhookWorker(app.log);
    }

    app.addHook("onClose", async () => {
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
  // well-known path, public, no auth, serves public key material only.
  await app.register(jwksRoutes);

  // Public surface, Application API key auth.
  await app.register(meRoutes, { prefix: "/api/v1/me" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(authenticatedAuthRoutes, { prefix: "/api/v1/auth" });
  // User-token-only `GET /api/v1/auth/me`, no secret key (browser SDKs).
  // Separate plugin so it does NOT inherit authRoutes' requireApiKey hook.
  await app.register(userTokenMeRoutes, { prefix: "/api/v1/auth" });
  await app.register(oauthRoutes, { prefix: "/api/v1/auth/oauth" });
  await app.register(oauthLinkRoutes, { prefix: "/api/v1/auth/oauth" });
  await app.register(usersMeRoutes, { prefix: "/api/v1/users/me" });
  // The end-user's own devices (docs/devices.md), same credential tier as
  // /users/me: publishable key + user JWT.
  await app.register(devicesUserRoutes, { prefix: "/api/v1/users/me/devices" });
  // The end-user's own licences, same tier as the self-service billing reads.
  await app.register(licensesSelfRoutes, { prefix: "/api/v1/users/me/licenses" });
  // Secret-key surface over any end-user's devices, for the customer's backend.
  await app.register(devicesServerRoutes, { prefix: "/api/v1/devices" });
  // Secret-key end-user lookup by id / exact email (routes/users.ts). Mounted
  // AFTER /users/me so the literal segment wins over the :id parameter.
  await app.register(usersRoutes, { prefix: "/api/v1/users" });
  // Bulk import from another auth system (routes/users-import.ts).
  await app.register(usersImportRoutes, { prefix: "/api/v1/users" });
  // End-user organizations, gated by `authConfig.organizationsEnabled`
  // at the service layer. Routes are mounted regardless; the service
  // refuses on apps that didn't opt in.
  await app.register(organizationsAuthenticatedRoutes, {
    prefix: "/api/v1/users/me/organizations",
  });
  await app.register(organizationsAcceptInvitationRoutes, {
    prefix: "/api/v1/auth/organizations",
  });
  await app.register(billingRoutes, { prefix: "/api/v1/billing" });
  await app.register(couponsPublicRoutes, {
    prefix: "/api/v1/billing/coupons",
  });
  await app.register(mfaRoutes, { prefix: "/api/v1/auth/mfa" });
  await app.register(licensesPublicRoutes, { prefix: "/api/v1/licenses" });
  await app.register(usagePublicRoutes, { prefix: "/api/v1/usage" });
  await app.register(creditsPublicRoutes, { prefix: "/api/v1/credits" });
  // The signed-in end-user's own usage and credit reads: same prefixes, a
  // separate plugin each, because the two above are secret-key only as a whole.
  await app.register(usageSelfRoutes, { prefix: "/api/v1/usage" });
  await app.register(creditsSelfRoutes, { prefix: "/api/v1/credits" });
  // Hosted customer portal, public config lookup by slug (Portal V2).
  await app.register(portalConfigRoutes, { prefix: "/api/v1/portal" });
  // Per-Application MCP server + OAuth 2.1 AS (gated per-app by authConfig.mcpEnabled).
  await app.register(mcpRoutes, { prefix: "/api/v1/mcp" });
  // Root-level "path-insertion" OAuth metadata discovery (RFC 8414 / 9728). A
  // strict connector constructs the metadata URL by inserting the well-known
  // segment right after the origin and re-appending the issuer's path
  // (`/.well-known/oauth-authorization-server/api/v1/mcp/<slug>`), which the
  // suffix-form routes above 404. Registered with NO prefix so the well-known
  // segment sits directly under the origin; same bodies + mcpEnabled gating.
  await app.register(mcpWellKnownRoutes);

  // Webhook ingestion, provider signature is the auth (no API key here).
  await app.register(stripeWebhookRoutes, {
    prefix: "/api/v1/billing/webhook",
  });
  await app.register(paypalWebhookRoutes, {
    prefix: "/api/v1/billing/webhook",
  });
  await app.register(razorpayWebhookRoutes, {
    prefix: "/api/v1/billing/webhook",
  });
  // Generic provider-module pipeline (docs/specs/billing-provider-modules.md).
  // The legacy per-provider URLs above stay registered forever, operators
  // have them configured at the provider, and (Stripe since P1) forward
  // into this same pipeline. Re-confirmed in the 2.0.0 shim sweep: these are
  // URLs already pasted into live Stripe/PayPal/Razorpay dashboards, so
  // unregistering them 404s a real endpoint. The provider retries, disables it,
  // and the operator's subscriptions stop activating with nothing visible on
  // our side, the exact silent failure a major is not licence to cause.
  await app.register(billingProviderWebhookRoutes, {
    prefix: "/api/v1/webhooks/billing",
  });

  // Tenant operator surface, email/password auth, workspace memberships,
  // tenant-scoped admin. The panel uses these day-to-day.
  await app.register(tenantAuthRoutes, { prefix: "/api/v1/tenant/auth" });
  await app.register(tenantAuthAuthenticatedRoutes, {
    prefix: "/api/v1/tenant/auth",
  });
  await app.register(tenantInvitationPublicRoutes, {
    prefix: "/api/v1/tenant/invitations",
  });
  await app.register(tenantInvitationAuthRoutes, {
    prefix: "/api/v1/tenant/invitations",
  });
  await app.register(tenantWorkspacesRoutes, {
    prefix: "/api/v1/tenant/workspace",
  });
  await app.register(tenantApplicationsRoutes, {
    prefix: "/api/v1/tenant/applications",
  });
  // Operator-PAT-gated surface, authenticated by `rp_op_…` personal-access-tokens
  // (Authorization: Bearer) instead of a session JWT. Default-deny on writes.
  await app.register(operatorTokenRoutes, {
    prefix: "/api/v1/tenant/operator",
  });
  // Operator-side MCP server, JSON-RPC at /api/v1/tenant/mcp. Accepts EITHER
  // the operator PAT that gates `/api/v1/tenant/operator/*` or an OAuth access
  // token, via the hybrid guard in tenant-mcp/bearer-auth.ts.
  // Operator MCP OAuth AS, discovery + register + authorize +
  // token + introspect. Registered BEFORE tenantMcpRoutes so the OAuth
  // endpoints under the same prefix don't fall into the JSON-RPC catch-all.
  // Gated by OPERATOR_MCP_ENABLED (default on): when disabled, neither plugin
  // mounts, so the whole /api/v1/tenant/mcp surface 404s.
  if (env.OPERATOR_MCP_ENABLED) {
    await app.register(operatorMcpOAuthRoutes, {
      prefix: "/api/v1/tenant/mcp",
    });
    await app.register(tenantMcpRoutes, { prefix: "/api/v1/tenant/mcp" });
    // Root-level path-insertion OAuth metadata discovery (RFC 8414 / 9728) for
    // the operator MCP, mirrors `mcpWellKnownRoutes` for the per-app server.
    // A strict connector (Claude) constructs the metadata URL by inserting the
    // well-known segment right after the origin and re-appending the issuer
    // path (`/.well-known/oauth-authorization-server/api/v1/tenant/mcp`), which
    // the suffix-form routes above 404. Registered with NO prefix so the
    // well-known segment sits directly under the origin.
    await app.register(operatorMcpWellKnownRoutes);
  }
  await app.register(tenantEmailRoutes, {
    prefix: "/api/v1/tenant/applications",
  });
  await app.register(tenantWebhookRoutes, {
    prefix: "/api/v1/tenant/applications",
  });
  await app.register(tenantDevicesRoutes, {
    prefix: "/api/v1/tenant/applications",
  });
  await app.register(tenantLicenseActivationRoutes, {
    prefix: "/api/v1/tenant/applications",
  });
  await app.register(tenantMfaRoutes, { prefix: "/api/v1/tenant/auth/mfa" });
  await app.register(securityEventsRoutes, {
    prefix: "/api/v1/tenant/security-events",
  });
  await app.register(tenantPasskeysAuthenticatedRoutes, {
    prefix: "/api/v1/tenant/auth",
  });
  await app.register(tenantPasskeysPublicRoutes, {
    prefix: "/api/v1/tenant/auth",
  });
  await app.register(tenantOAuthPublicRoutes, {
    prefix: "/api/v1/tenant/auth",
  });

  // Bootstrap admin surface, gated by SUPER_ADMIN_KEY. Useful for the very
  // first deploy + ops escape hatch. Day-to-day uses /api/v1/tenant/* above.
  await app.register(tenantsRoutes, { prefix: "/api/v1/admin/tenants" });
  await app.register(applicationsRoutes, {
    prefix: "/api/v1/admin/applications",
  });
  await app.register(apiKeysRoutes, { prefix: "/api/v1/admin/applications" });
  await app.register(plansRoutes, { prefix: "/api/v1/admin/applications" });
  await app.register(couponsAdminRoutes, {
    prefix: "/api/v1/admin/applications",
  });
  // Granting a subscription with no payment provider behind it. Held at
  // SUPER_ADMIN_KEY rather than an operator role floor, see the route file.
  await app.register(billingAdminRoutes, {
    prefix: "/api/v1/admin/applications",
  });
  // Operator-invite key management (mint/list/revoke). Gates new-operator
  // registration when OPERATOR_SIGNUP_MODE='invite'. Gated by SUPER_ADMIN_KEY.
  await app.register(operatorInvitesRoutes, {
    prefix: "/api/v1/admin/operator-invites",
  });
  // Read-only deployment-wide rollups for the super-admin dashboard.
  // GET-only; gated by SUPER_ADMIN_KEY.
  await app.register(adminMetricsRoutes, { prefix: "/api/v1/admin/metrics" });

  app.setNotFoundHandler((req, reply) => {
    // `requestId` here too: docs/errors.md documents it on every error envelope,
    // and a 404 that turns out to be a routing/proxy problem is exactly the case
    // where an operator wants to find the matching log line.
    reply.header("X-Request-Id", req.id);
    return reply.status(404).send({
      success: false,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "Route not found.",
        fix: "Browse /docs for the full route list.",
        requestId: req.id,
      },
    });
  });

  return app;
}

/**
 * Does any string anywhere in a parsed JSON body contain a NUL?
 *
 * Depth-bounded: a body deep enough to matter is already refused by the size
 * limit, and an unbounded walk on attacker-shaped input is its own denial
 * vector. Keys are checked as well as values, a NUL in a metadata key reaches
 * the same column.
 */
function containsNulByte(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value))
    return value.some((v) => containsNulByte(v, depth + 1));
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes("\u0000") || containsNulByte(v, depth + 1)) return true;
    }
  }
  return false;
}
