/**
 * Application API key auth.
 *
 * Routes that consume this middleware require an Application-scoped secret
 * key (`rp_live_*` / `rp_test_*`) presented as `Authorization: Bearer <key>`.
 * On success, the resolved Application and ApiKey are attached to the
 * request via `request.application` and `request.apiKey`.
 *
 * **What this middleware does NOT accept:**
 *   - The bootstrap `SUPER_ADMIN_KEY` (use `requireSuperAdmin` for admin routes).
 *   - Public keys (`rp_pub_*`) — those are browser-safe identifiers, not credentials.
 *
 * Verification chokepoint contract: a key is valid iff it is found by hash AND
 * not revoked AND not past its expiry. Anything else is a bug, here.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ApiKey, Application } from '@prisma/client';
import { apiKeysService } from '../modules/api-keys/api-keys.service.js';
import { prisma } from '../lib/prisma.js';
import { shouldWriteLastUsed } from '../lib/last-used-throttle.js';
import { env } from '../config/env.js';
import { RekeyError } from '../lib/error.js';
import { ipMatchesAllowlist } from '../lib/ip-allowlist.js';
import { portalOriginsForApp } from '../lib/portal-origins.js';
import { recordSecurityEvent, requestContext } from '../lib/security-events.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireApiKey` / `requirePublishableOrSecretKey` after successful auth. */
    application?: Application;
    /** Set by `requireApiKey` after successful auth. The hash is intentionally on this object — it never leaves the server. Unset for publishable requests. */
    apiKey?: ApiKey;
    /**
     * How this request authenticated:
     *   - `'secret'`      — server-side secret key (`rp_live_*`/`rp_test_*`).
     *   - `'publishable'` — browser public key (`rp_pub_*`). Only ever set on
     *     public-bootstrap routes guarded by `requirePublishableOrSecretKey`,
     *     so `requireScope` treats it as pre-authorized (the route-membership
     *     gate: a pub key can never reach a secret-only route).
     */
    authKind?: 'secret' | 'publishable';
  }
}

const SECRET_KEY_PREFIXES = ['rp_live_', 'rp_test_'] as const;
const PUBLISHABLE_KEY_PREFIX = 'rp_pub_';

/**
 * The refusal a disabled Application returns to every end-user-facing caller.
 *
 * Shared by both middlewares so the two doors cannot drift into two different
 * answers for one state. 403, not 401: the credential presented is genuine and
 * re-presenting a better one changes nothing, which is precisely what 403
 * means and 401 does not.
 *
 * The message is read by an operator's developer, not by an end-user, so it
 * names the actual cause rather than hiding behind a generic outage. Nothing
 * is disclosed by it: the caller already holds a valid key for this
 * Application, so they are entitled to know its state.
 */
export function applicationDisabled(): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'APPLICATION_DISABLED',
    message:
      'This application is disabled. It is not serving authentication, billing or any ' +
      'other end-user request, and no data has been deleted.',
    fix: 'A workspace operator can re-enable it in Panel → Application → Settings. If it is in the production environment, re-enabling needs a free production slot in the workspace.',
  });
}

export async function requireApiKey(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!presented) {
    throw new RekeyError({
      statusCode: 401,
      code: 'API_KEY_MISSING',
      message: 'This endpoint requires an Authorization: Bearer <secretKey> header.',
      fix: 'Pass your Application secret key (rp_live_… or rp_test_…) from the panel.',
    });
  }

  const looksLikeSecretKey = SECRET_KEY_PREFIXES.some((p) => presented.startsWith(p));
  if (!looksLikeSecretKey) {
    // Could be a public key or the super-admin key, both wrong here. Same code
    // either way — refuse to identify which kind of mistake it was, so an
    // attacker can't probe.
    throw new RekeyError({
      statusCode: 401,
      code: 'API_KEY_INVALID',
      message: 'The presented credential is not a valid Application secret key.',
      fix: 'Use a key starting with rp_live_ or rp_test_ from Panel → Application → API Keys. Public keys (rp_pub_) and the bootstrap admin key are not accepted here.',
    });
  }

  const verified = await apiKeysService.verify(presented);
  if (!verified) {
    throw new RekeyError({
      statusCode: 401,
      code: 'API_KEY_INVALID',
      // Name the deployment that rejected it.
      //
      // Keys are per-deployment: one minted on a local instance does not exist
      // on Rekey Cloud and vice versa, and the single commonest integration
      // mistake is pointing half a configuration at one and half at the other
      // (server `REKEY_URL` still on localhost while the browser's
      // `NEXT_PUBLIC_REKEY_URL` moved to Cloud, say). The old message described
      // three states the key could be in and never mentioned the one thing that
      // makes the difference — WHERE it was checked — so the reader went
      // looking for a revoked key that was never revoked. Reported as #29.
      //
      // This discloses nothing: the caller already knows the origin they sent
      // the request to, and `API_URL` is public.
      message: `API key is unknown, revoked, or expired at ${env.API_URL}.`,
      fix: `Keys belong to the deployment that minted them. Confirm this key came from ${env.API_URL} (Panel → Application → API Keys) and not from another Rekey deployment — a key from a local or staging instance is unknown here. If the origin is right, list your active keys in the panel and mint a new one if needed.`,
    });
  }

  // The Application arrives on the same query as the key (include in
  // `verify`) — this used to be a second sequential round trip. The null
  // check stays as defence in depth: FK CASCADE makes it unreachable, and if
  // that ever breaks, 401 not 500 — the credential's referent is gone.
  const application = verified.application;
  if (!application) {
    throw new RekeyError({
      statusCode: 401,
      code: 'API_KEY_INVALID',
      message: 'API key references an application that no longer exists.',
      fix: 'This key is dead — mint a new one under a current application.',
    });
  }

  // Disabled Applications refuse every end-user-facing request. Checked before
  // the IP allowlist because "this application is switched off" is the more
  // fundamental fact and the more useful thing to be told: an operator
  // debugging a 403 should not first be sent to audit an allowlist that is not
  // the problem. Operator routes do NOT pass through here and stay open, which
  // is what makes the freeze reversible.
  if (application.disabledAt !== null) throw applicationDisabled();

  // Per-Application IP allowlist (server-side secret keys only — this is the
  // secret-key middleware; public keys never reach here). When the app has set
  // an allowlist, the request IP must be in it. `request.ip` honours trustProxy
  // (set in production) so it reflects the real client behind the LB.
  if (
    application.ipAllowlist.length > 0 &&
    !ipMatchesAllowlist(request.ip, application.ipAllowlist)
  ) {
    void recordSecurityEvent({
      type: 'app.ip_blocked',
      actorType: 'system',
      tenantId: application.tenantId,
      applicationId: application.id,
      ...requestContext(request),
      metadata: { apiKeyId: verified.apiKey.id },
    });
    throw new RekeyError({
      statusCode: 403,
      code: 'IP_NOT_ALLOWED',
      message: 'This API key is restricted to an IP allowlist that does not include your address.',
      fix: 'Call from an allowlisted IP/CIDR, or update the allowlist in Panel → Application → Access.',
    });
  }

  request.application = application;
  request.apiKey = verified.apiKey;
  request.authKind = 'secret';

  // Fire-and-forget lastUsedAt update, at most once per key per minute (see
  // lib/last-used-throttle.ts for why per-request writes were a problem).
  // Never block the request on this.
  if (shouldWriteLastUsed(`ak:${verified.apiKey.id}`)) {
    void prisma.apiKey
      .update({ where: { id: verified.apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch((err: unknown) => {
        request.log.warn({ err }, 'lastUsedAt update failed');
      });
  }
}

/**
 * Auth for routes a **browser client** must be able to reach. Accepts EITHER:
 *
 *   - a server-side secret key (`rp_live_*`/`rp_test_*`) — delegates to
 *     `requireApiKey`, identical behaviour (scopes, IP allowlist); or
 *   - a browser **publishable** key (`rp_pub_*`) — a real credential here.
 *
 * The publishable key is **identity, not authorization**: it names the
 * Application and asserts "legit public client". It grants nothing by itself.
 * Two families of route use it, and each carries its own real authorizer:
 *
 *   1. **Public-bootstrap** (sign-in/up, magic-link, passkey authenticate,
 *      license verify, plan listing) — no user exists yet, so the per-route
 *      credential is the gate: password, passkey assertion, emailed token,
 *      license key.
 *   2. **End-user self-service** (MFA enrollment, passkey/session management,
 *      change-password, OAuth linking, org/team management, coupon validate) —
 *      gated by `requireUserSession`, which verifies the end-user JWT's
 *      signature and `typ`, and that its `applicationId` claim matches *this*
 *      Application — nothing beyond that. That session is
 *      strictly stronger than the secret key here: it names the single user the
 *      route may act on. Demanding a secret key on top adds no authorization,
 *      it only forbids the credential a browser is allowed to hold — which
 *      makes the flow unreachable from `@rekey.dev/react`.
 *
 * Beyond that, safety rests on the per-route rate limits and the per-app CORS
 * origin allowlist enforced below (the browser analogue of the secret key's IP
 * allowlist).
 *
 * NEVER attach this where the Application credential is the ONLY gate and the
 * route can move money or read across users — no user session, no per-request
 * secret. Those keep `requireApiKey`, which rejects `rp_pub_*` outright, so a
 * publishable request can structurally never reach them.
 */
/**
 * IMPORTANT — the origin allowlist is NOT the browser equivalent of the IP
 * allowlist, and it must not be described as one.
 *
 * `ipAllowlist` (secret-key path) constrains a NETWORK POSITION: a request from
 * the wrong host is refused no matter what it carries. `corsOrigins`
 * (publishable path) constrains only HONEST BROWSERS — `Origin` is a request
 * header, so any non-browser client sets it freely. It defends against a
 * third-party SITE misusing your publishable key; it does not defend against
 * replay of a stolen end-user token from an arbitrary host.
 *
 * Both default to empty = open. So moving a route from secret-only to
 * publishable-or-secret genuinely WIDENS reach for apps that were relying on
 * `ipAllowlist`; it does not swap one equivalent control for another. Treat any
 * such move as a breaking change and reason about what a stolen end-user access
 * token can now reach.
 */
export async function requirePublishableOrSecretKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  // Anything that isn't a publishable key — including a missing header, a
  // secret key, or junk — goes through the secret-key path, which owns all the
  // missing/invalid-credential error messages.
  if (!presented.startsWith(PUBLISHABLE_KEY_PREFIX)) {
    return requireApiKey(request, reply);
  }

  // Publishable path. Look up the app by its current public key, OR by a
  // previous key still inside its rotation grace window.
  const now = new Date();
  const application = await prisma.application.findFirst({
    where: {
      OR: [
        { publicKey: presented },
        {
          previousPublicKey: presented,
          previousPublicKeyValidUntil: { gt: now },
        },
      ],
    },
  });
  if (!application) {
    throw new RekeyError({
      statusCode: 401,
      code: 'PUBLISHABLE_KEY_INVALID',
      // Names the deployment for the same reason API_KEY_INVALID does: a
      // publishable key minted on one deployment is unknown on another, and
      // browser config is the half most likely to point somewhere else. See
      // the note on API_KEY_INVALID above.
      message: `The presented publishable key is unknown at ${env.API_URL}, or has been rotated out.`,
      fix: `Use the current publishable key (rp_pub_…) from Panel → Application on ${env.API_URL} — a key from another Rekey deployment is unknown here, so check the origin your client points at as well as the key. If you just rotated, redeploy clients with the new key before the grace window ends.`,
    });
  }

  // Same gate as the secret-key path, in the same position relative to the
  // allowlist check, for the same reason. See `applicationDisabled`.
  if (application.disabledAt !== null) throw applicationDisabled();

  // Per-app CORS origin allowlist. When the tenant has declared origins, a
  // publishable request must carry a matching `Origin` header — this is the
  // browser-appropriate analogue of the secret key's IP allowlist. Empty list =
  // open (rate-limited); tenants add origins in Panel → Application → Access.
  // The hosted-portal origin(s) are always allowed for portal-enabled apps
  // (additive — they don't flip an empty/open allowlist into enforcement), so
  // the portal works without the operator hand-adding its host.
  if (application.corsOrigins.length > 0) {
    const origin = request.headers.origin;
    const allowed = [...application.corsOrigins, ...portalOriginsForApp(application)];
    if (!origin || !allowed.includes(origin)) {
      void recordSecurityEvent({
        type: 'app.origin_blocked',
        actorType: 'system',
        tenantId: application.tenantId,
        applicationId: application.id,
        ...requestContext(request),
        metadata: { origin: origin ?? null },
      });
      throw new RekeyError({
        statusCode: 403,
        code: 'ORIGIN_NOT_ALLOWED',
        message: 'This publishable key is restricted to an origin allowlist that does not include this request.',
        fix: 'Call from an allowlisted browser origin, or add it in Panel → Application → Access.',
      });
    }
  }

  request.application = application;
  request.authKind = 'publishable';
}

/**
 * Scope hierarchy:
 *   - `*` grants every recognised scope.
 *   - `auth:write` implies `auth:read`.
 *   - `billing:write` implies `billing:read`.
 *
 * Read scopes never imply write. Other scopes (e.g. `webhooks:read`) are
 * leaf scopes — they must be granted explicitly.
 */
const SCOPE_IMPLICATIONS: Record<string, string[]> = {
  '*': [
    'auth:read',
    'auth:write',
    'billing:read',
    'billing:write',
    'webhooks:read',
  ],
  'auth:write': ['auth:read'],
  'billing:write': ['billing:read'],
};

function effectiveScopes(granted: ReadonlyArray<string>): Set<string> {
  const acc = new Set<string>();
  for (const s of granted) {
    acc.add(s);
    for (const implied of SCOPE_IMPLICATIONS[s] ?? []) acc.add(implied);
  }
  return acc;
}

export function hasScope(
  granted: ReadonlyArray<string> | null | undefined,
  required: string,
): boolean {
  if (!granted) return false;
  return effectiveScopes(granted).has(required);
}

/**
 * Higher-order guard for scope-restricted routes. Returns an `onRequest`
 * hook that runs **after** `requireApiKey` and refuses with 403 if the
 * presented key lacks the required scope (or an implying scope).
 *
 * `["*"]` accepts everything. This is not a legacy artefact — it is still
 * `DEFAULT_SCOPES` in api-keys.service.ts, so every key minted without an
 * explicit `scopes` array gets it. Narrower keys (`["auth:read"]`) get
 * rejected from write endpoints with a clear `API_KEY_SCOPE_INSUFFICIENT`
 * code.
 *
 * @example
 * ```ts
 * app.addHook('onRequest', requireApiKey);
 * app.addHook('onRequest', requireScope('auth:write'));
 * ```
 */
export function requireScope(
  required: string,
): (req: FastifyRequest, _reply: FastifyReply) => Promise<void> {
  return async (request) => {
    // Publishable requests are the route-membership gate: this route opted into
    // `requirePublishableOrSecretKey`, so it is a public-bootstrap route and a
    // pub key is pre-authorized for it. (A pub key can never reach a secret-only
    // route — those use `requireApiKey`, which rejects `rp_pub_*`.) No scope row
    // exists for a pub key, so don't evaluate scopes; allow.
    if (request.authKind === 'publishable') return;
    if (!request.apiKey) {
      // Programming error: this hook must run after `requireApiKey`.
      throw new RekeyError({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'requireScope ran without an ApiKey on the request.',
        fix: 'Register requireApiKey before requireScope on the route.',
      });
    }
    if (!hasScope(request.apiKey.scopes, required)) {
      throw new RekeyError({
        statusCode: 403,
        code: 'API_KEY_SCOPE_INSUFFICIENT',
        message:
          `This endpoint requires the "${required}" scope. ` +
          `The presented key carries: ${request.apiKey.scopes.join(', ') || '(none)'}.`,
        fix: `Mint a new key that includes "${required}" (or "*") via Panel → Application → API Keys.`,
      });
    }
  };
}
