/**
 * @rekey.dev/shared-types
 *
 * Zod schemas + TypeScript types shared between the API and the SDKs.
 * Anything serialized over the wire lives here — never duplicate a shape.
 */

import { z } from 'zod';

// ============================================================================
// Security events
//
// The audit-log event types + their labels. Re-exported rather than defined
// here because the map is long and self-contained; see that file for why it
// stopped living in the panel.
// ============================================================================

export {
  SECURITY_EVENT_LABEL,
  SECURITY_EVENT_TYPES,
  humanizeSecurityEventType,
  securityEventTypeOptions,
  type SecurityEventType,
} from './security-events.js';

// ============================================================================
// Errors
// ============================================================================

// `RekeyError` + `RekeyErrorShape` live in their own zero-import module so a
// browser bundle can reach the class without dragging zod and every schema in
// this file along with it (see ./error.ts for the measurement). They are
// re-exported here unchanged — same class identity, so `instanceof` holds
// whichever path you import from.
export { RekeyError } from './error.js';
export type { RekeyErrorShape } from './error.js';
import { type RekeyErrorShape } from './error.js';

// Decides the `Secure` attribute on a session cookie from the REQUEST rather
// than from a build-time NODE_ENV. Lives in its own zero-import module for the
// same reason RekeyError does — Edge middleware and client-adjacent code reach
// for it without pulling zod in.
export { cookieSecureFor } from './cookie-security.js';
export type { CookieSecurityInput } from './cookie-security.js';

/**
 * The error envelope every Rekey API response uses on failure. The runtime
 * schema; `RekeyErrorShape` (from `./error.js`) is the identical static type.
 *
 * @example
 * ```ts
 * { code: 'PLAN_NOT_FOUND', message: 'Plan "pro" not found.', fix: 'Run `rekey plans list`.' }
 * ```
 */
export const RekeyErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Concrete remediation a human or AI agent can act on. */
  fix: z.string().optional(),
  /** Documentation URL for this error code. */
  docs: z.string().url().optional(),
  /**
   * Seconds to wait before retrying. The API has always sent this on
   * `RATE_LIMITED` (mirrored in `Retry-After`) and on the idempotency in-flight
   * conflict; it was simply never declared here, so it arrived untyped.
   */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

// The schema and the hand-written interface must not drift. Splitting them
// across two files is what makes the tree-shake possible, so this asserts at
// compile time that they describe exactly the same shape.
type _Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type _Assert<T extends true> = T;
type _RekeyErrorShapeMatchesSchema = _Assert<
  _Equal<z.infer<typeof RekeyErrorSchema>, RekeyErrorShape>
>;

// ============================================================================
// Pagination
// ============================================================================

/**
 * Offset-pagination metadata. The `page` half of every list response.
 *
 * @example
 * ```json
 * { "total": 36, "limit": 25, "offset": 0, "hasMore": true }
 * ```
 */
export const PageMetaSchema = z.object({
  /** Rows matching the query, ignoring `limit`/`offset`. */
  total: z.number().int().nonnegative(),
  /** Rows requested for this window. */
  limit: z.number().int().nonnegative(),
  /** Rows skipped before this window. */
  offset: z.number().int().nonnegative(),
  /** True when another page exists — i.e. `offset + limit < total`. */
  hasMore: z.boolean(),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

/**
 * The `data` of every paginated list response: `{items, page}`.
 *
 * Until 2.0.0-rc.3 these endpoints returned a bare array. A bare array cannot
 * carry `total`, so a caller that did not pass `limit` could not tell a
 * complete list from a truncated one — 36 rows in the database, 25 on the wire,
 * nothing saying so. `page` makes truncation a fact in the response.
 *
 * @example
 * ```ts
 * const { items, page } = await rekey.billing.getPlans();
 * if (page.hasMore) {
 *   const next = await rekey.billing.getPlans({ offset: page.offset + page.limit });
 * }
 * ```
 */
export interface Paged<T> {
  items: T[];
  page: PageMeta;
}

/** Build the zod schema for a `Paged<T>` from the schema of one item. */
export function PagedSchema<T extends z.ZodTypeAny>(
  item: T,
): z.ZodObject<{ items: z.ZodArray<T>; page: typeof PageMetaSchema }> {
  return z.object({ items: z.array(item), page: PageMetaSchema });
}

/**
 * Offset-pagination request params, accepted by every list endpoint.
 *
 * `limit` defaults to 50 and is capped at 100 on most endpoints (a few
 * log-shaped ones allow 200 — each method's docblock says which).
 */
export interface ListPage {
  limit?: number;
  offset?: number;
}

// ============================================================================
// Open unions
// ============================================================================

/**
 * Widen a closed string union so a value the SDK predates still type-checks.
 *
 * A server can grow a new subscription status, plan kind or webhook event in a
 * MINOR release. If the SDK types those fields as a closed union, a consumer
 * who wrote an exhaustive `switch` compiles fine today and breaks on upgrade —
 * and, worse, a `never` in the default branch tells them the case is
 * impossible when it is merely unreleased. So every field that carries a
 * server-authored enum over the wire is typed `Open<…>`: the literals still
 * autocomplete (that is what `string & {}` buys), but TypeScript makes you
 * handle the unknown case.
 *
 * The closed union stays available as `Known…` for the places that own the
 * registry (validation schemas, exhaustive label maps you control).
 *
 * This is the same call `humanizeSecurityEventType` already makes by taking a
 * plain `string`; it is applied consistently here.
 *
 * @example
 * ```ts
 * switch (sub.status) {
 *   case 'ACTIVE': return grant();
 *   case 'CANCELED': return revoke();
 *   default: return leaveAlone(); // ← a 2.1.0 'TRIALING' lands here, not in a compile error
 * }
 * ```
 */
export type Open<T extends string> = T | (string & {});

export const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data }),
    z.object({ success: z.literal(false), error: RekeyErrorSchema }),
  ]);

// ============================================================================
// Workspace limits — the optional ceilings stored in Tenant.limits (Json column).
// ============================================================================

/**
 * Per-workspace (Tenant) resource ceilings.
 *
 * Every key is optional and nullable, and **absent / null means unlimited**.
 * `Tenant.limits` itself is nullable too, so a deployment that never sets a
 * limit is unconstrained — which is what every existing self-host install is.
 *
 * The object shape (rather than a bare number) is deliberate: new limits are
 * added as new optional keys, no migration and no breaking change for anyone
 * already storing a subset.
 *
 * Rekey attaches no pricing meaning to these numbers. They are a mechanism —
 * a multi-team self-host uses them to stop one workspace from consuming the
 * whole deployment; anything that maps a subscription onto them lives outside
 * this codebase.
 *
 * @example
 * ```ts
 * TenantLimitsSchema.parse({ maxActiveEndUsers: 100 }); // capped
 * TenantLimitsSchema.parse({ maxActiveEndUsers: null }); // explicitly unlimited
 * TenantLimitsSchema.parse({});                          // unlimited
 * ```
 */
export const TenantLimitsSchema = z.object({
  /**
   * Maximum non-erased EndUsers across **all** Applications in the workspace.
   * Counted tenant-wide, not per-Application. When the workspace is at or over
   * this number, creating a *new* end-user fails with `TENANT_QUOTA_EXCEEDED`;
   * end-users that already exist keep signing in normally.
   */
  maxActiveEndUsers: z.number().int().min(0).max(2_147_483_647).nullable().optional(),

  /**
   * Maximum Applications in the workspace whose `environment` is `PRODUCTION`.
   * STAGING and DEVELOPMENT Applications are never counted, so a workspace at
   * its ceiling can still create as many non-production Applications as it
   * likes. Creating a *new* production Application over the line fails with
   * `TENANT_QUOTA_EXCEEDED`; production Applications that already exist keep
   * serving traffic.
   *
   * `Application.environment` is write-once (set at create, never updated), so
   * a workspace cannot dodge this by creating a DEVELOPMENT app and promoting
   * it later.
   */
  maxProductionApps: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
});
export type TenantLimits = z.infer<typeof TenantLimitsSchema>;

// ============================================================================
// Application config — the per-app settings stored in Application.authConfig
// and Application.billingConfig (Json columns).
// ============================================================================

/**
 * Auth methods this Application exposes. `password` and `magic_link` are
 * primary methods (the SDK calls them directly). OAuth provider presence is
 * implicit from `Application.oauthConfig` having that provider as a key —
 * not duplicated here. Open string to keep the enum from limiting future
 * additions.
 */
export const AuthMethodSchema = z.string().min(1).max(40);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/**
 * Signature algorithm for END-USER access tokens minted by this Application.
 *
 *   - `HS256` (default) — per-app derived symmetric key. Only the Rekey API
 *     can verify; customers round-trip `auth.getCurrentUser()`.
 *   - `RS256` — asymmetric. Tokens carry a `kid` header and verify against the
 *     deployment's public JWKS at `/.well-known/jwks.json`, enabling offline /
 *     edge verification (`verifyAccessToken` in @rekey.dev/node). Refresh tokens,
 *     MFA-challenge tokens, and operator tokens are unaffected.
 */
export const TokenAlgSchema = z.enum(['HS256', 'RS256']);
export type TokenAlg = z.infer<typeof TokenAlgSchema>;

export const AuthConfigSchema = z.object({
  /** Which primary methods are enabled. Empty array = OAuth-only app. */
  methods: z.array(AuthMethodSchema),
  passwordMinLength: z.number().int().min(8).max(1024).default(8),
  /** Where to send the user after sign-in / sign-up. */
  redirectUrls: z.array(z.string().url()),
  /**
   * Base URL of the CUSTOMER's own application — the origin transactional
   * emails link back to (`{{appUrl}}` in the welcome mail, and the base for
   * the reset / verify / magic-link URLs when the SDK caller doesn't supply
   * one explicitly).
   *
   * Optional on purpose, and there is no default: an unset value means "we
   * cannot build a link," and the templates then render NO call-to-action
   * button rather than a dead one. Never populate this with a placeholder
   * domain — a button pointing somewhere wrong is worse than no button.
   *
   * Lives in `authConfig` (a jsonb column) rather than `emailConfig` because
   * `emailConfig` is rewritten wholesale whenever transport credentials are
   * saved, and because the inference fallback reads `redirectUrls`, its
   * neighbour here. No migration needed.
   */
  appUrl: z.string().url().optional(),
  /** If true, organisations / teams are enabled for this application. */
  organizationsEnabled: z.boolean().default(false),
  /**
   * **Legacy** sign-up switch, retained for back-compat. Derived from
   * `signupMode` after parse — do not set both at once. `false` ⇔
   * `signupMode: 'invite_only'`; `true` ⇔ `'public'`. A value of
   * `'secret_only'` still reports `signupEnabled: true` (signup IS enabled,
   * just restricted to secret keys). Prefer reading `signupMode`.
   *
   * KEPT deliberately in 2.0.0 despite the "legacy" label. `authConfig` is a
   * JSON column, so an Application configured before `signupMode` existed has
   * `{ signupEnabled: false }` and no mode. The transform below is the only
   * thing that reads that as `invite_only`; without it the fallback becomes
   * `'public'` and sign-up silently re-opens on an Application the operator
   * deliberately closed. That is a security regression triggered by a comment
   * cleanup, so this field outlives the major.
   */
  signupEnabled: z.boolean().optional(),
  /**
   * Who may create end-users in this Application:
   *   - `public`      — anyone with the publishable OR secret key (default).
   *   - `secret_only` — only a server-side SECRET key may create users; the
   *                     publishable key is refused with
   *                     `SIGNUP_REQUIRES_SECRET_KEY`. Sign-IN with the
   *                     publishable key is unaffected.
   *   - `invite_only` — no public sign-up at all (either key kind is refused
   *                     with `SIGNUP_DISABLED`); operators invite end-users.
   *
   * Optional (not `.default`) on purpose: absence is what lets us derive the
   * mode from the legacy `signupEnabled` for apps written before this field
   * existed (`false` → `invite_only`, else `public`). The transform below
   * fills it in, so it is always present after parse.
   */
  signupMode: z.enum(['public', 'secret_only', 'invite_only']).optional(),
  /**
   * End-user two-factor (TOTP) policy for this Application:
   *   - `off`      — MFA endpoints are refused (`MFA_NOT_ENABLED`).
   *   - `optional` — end-users may enroll; enrolled users are challenged at
   *                  sign-in (the default — preserves prior behaviour).
   *   - `required` — sign-in returns `mfaEnrollmentRequired: true` for users
   *                  who haven't enrolled yet, so the app can force setup.
   */
  mfa: z.enum(['off', 'optional', 'required']).default('optional'),
  /**
   * If true (default), submitted passwords are checked against the HIBP
   * Pwned Passwords k-anonymity API at sign-up + password-reset +
   * password-change time. Operators on offline / restricted networks can
   * opt out per Application; a deployment-level kill-switch lives at
   * env `HIBP_BREACH_CHECK_DISABLED=true`.
   */
  passwordBreachCheckEnabled: z.boolean().default(true),
  /**
   * If true (default), password sign-up sends the `email_verification` mail
   * *in addition to* `welcome`, so a new account gets its confirmation link
   * without the customer's server calling `/auth/send-verification` itself.
   * Best-effort in exactly the way the welcome mail is: a delivery failure is
   * logged and dropped, never rolled back into the account creation.
   *
   * Only the password path sends it. Magic-link sign-IN and sign-UP both set
   * `emailVerified: true` (consuming the link IS the proof of the mailbox) and
   * an OAuth-first sign-up carries the provider's own `email_verified` claim —
   * neither has anything left for us to verify.
   *
   * Ignored while `requireEmailVerification` is on: the link is then the only
   * way into the account, so sign-up sends it regardless of this switch. A
   * toggle that can strand every new registration is not a toggle.
   */
  sendVerificationEmailOnSignUp: z.boolean().default(true),
  /**
   * If true, an end-user whose `emailVerified` is still false gets NO session:
   * sign-up, sign-in, MFA verification, org switching and refresh all refuse
   * with 403 `EMAIL_NOT_VERIFIED`. Default false: switching it on locks out
   * every already-registered account that never confirmed its address, so it
   * stays the operator's deliberate act rather than something a version bump
   * does to them.
   *
   * Enforced at the session chokepoint, not per credential. Refresh re-checks,
   * so flipping the switch on ends the sessions of users who never confirmed
   * within one access-token lifetime instead of after 30 days.
   *
   * **Magic-link passes the gate. OAuth only usually does.** Completing a
   * magic link is itself proof of the address, and it sets `emailVerified`
   * unconditionally. An OAuth sign-up instead records the PROVIDER's claim —
   * `emailVerified: identity.emailVerified` — which some providers do not
   * assert. Google and Discord do; generic OIDC and Microsoft consumer
   * accounts may not.
   *
   * So a first-time OAuth sign-up from a non-asserting provider creates the
   * account and is then refused a session by this gate — an account with no
   * password and no way in. The two `OAUTH_EMAIL_NOT_VERIFIED` refusals do not
   * cover it: one is an auto-link takeover guard that fires only when an
   * account with that address already exists, and the other is in
   * `linkIdentity`, which runs only for an already-authenticated user adding a
   * provider.
   *
   * This docblock previously claimed OAuth "marks it verified", which made the
   * verification flow look optional when OAuth was on offer. It is not: with
   * this switch on, a verification path is required infrastructure.
   */
  requireEmailVerification: z.boolean().default(false),
  /**
   * If true, this Application exposes a hosted MCP (Model Context Protocol)
   * server at `/api/v1/mcp/<slug>`, fronted by a per-app OAuth 2.1
   * authorization server (dynamic client registration + authorization-code +
   * PKCE). End-users authenticate and connect MCP clients (Claude Code,
   * Claude Desktop, …) to access their own account data. Off by default —
   * while off, the MCP + OAuth endpoints 404.
   */
  mcpEnabled: z.boolean().default(false),
  /**
   * If true, this Application acts as an OpenID Connect **provider**. The
   * per-app authorization server that MCP already fronts additionally serves
   * `/.well-known/openid-configuration`, issues an `id_token` whenever the
   * `openid` scope is granted, and exposes `/oauth/userinfo`. Off by default —
   * while off the OIDC endpoints 404 AND `openid`/`profile`/`email` are not
   * grantable, so no ID Token can be minted for the Application at all.
   *
   * Deliberately independent of `mcpEnabled`. Either toggle alone mounts the
   * shared authorization endpoints (authorize / token / register / introspect);
   * each RESOURCE then gates itself — the MCP JSON-RPC endpoint needs
   * `mcpEnabled` plus the `mcp:account` scope, `/userinfo` needs `oidcEnabled`
   * plus `openid`. An operator who wants single-sign-on must not have to expose
   * an MCP tool server over their users' account data to get it.
   *
   * The `email` scope additionally requires `requireEmailVerification`. Without
   * it Rekey has no proof of the address and will not assert one to a relying
   * party — `scopes_supported` omits `email`, and so does `claims_supported`.
   */
  oidcEnabled: z.boolean().default(false),
  /**
   * If true (default), anyone may register an OAuth client against this
   * Application's authorization server with `POST /oauth/register` (RFC 7591
   * open registration, rate-limited, public clients only). With it off that
   * endpoint answers 403 `CLIENT_REGISTRATION_DISABLED` and neither discovery
   * document advertises `registration_endpoint`; existing clients keep working.
   *
   * Default on because MCP clients (Claude Code, Claude Desktop, …) register
   * themselves as the first step of connecting and there is no operator-side
   * client-creation surface yet — a default of `false` would silently break
   * every deployment that already has MCP switched on and would leave a
   * freshly-enabled OpenID Provider with no way to onboard a relying party at
   * all. Turn it off once your relying parties are registered, which is the
   * posture a public IdP wants: open registration lets anyone stand up a rogue
   * client with an attacker-chosen `client_name` and get a password prompt
   * rendered on the operator's own issuer origin. (`client_name` is escaped and
   * the consent screen is accurate, so this is a phishing surface rather than a
   * credential-theft one — hence a control to harden with, not a default.)
   */
  dynamicClientRegistration: z.boolean().default(true),
  /**
   * Signature algorithm for end-user ACCESS tokens. `HS256` (default) keeps
   * today's per-app derived-secret behaviour. `RS256` signs new access tokens
   * with the deployment's active RSA key (kid in the JWT header) so they can
   * be verified offline against `GET /.well-known/jwks.json`. Switching alg
   * does not invalidate outstanding tokens — the API verifies both.
   */
  tokenAlg: TokenAlgSchema.default('HS256'),
  /**
   * WebAuthn / passkey configuration. Both fields are required when
   * `"passkey"` appears in `methods` — the registration ceremony needs
   * to bind credentials to a specific Relying Party. `rpId` is the
   * eTLD+1 the credential is scoped to (e.g. `"acme.example.com"`),
   * `rpOrigins` is the list of full origins the customer's app will
   * authenticate from (used to verify `origin` on the client response).
   */
  webauthn: z
    .object({
      rpId: z.string().min(1).max(253),
      /** At least one origin required. e.g. `["https://app.acme.example.com"]`. */
      rpOrigins: z.array(z.string().url()).min(1),
      /** Human-readable name shown in the OS passkey UI. Falls back to `rpId`. */
      rpName: z.string().min(1).max(120).optional(),
    })
    .optional(),
  })
  .transform((cfg) => {
    // Reconcile the legacy boolean with the 3-way mode so BOTH fields are
    // always present and mutually consistent after parse, no matter which one
    // the caller supplied. `signupMode` wins when set; otherwise it is derived
    // from `signupEnabled` (old data). `signupEnabled` is then recomputed from
    // the resolved mode so a stale boolean can never contradict it.
    const signupMode =
      cfg.signupMode ?? (cfg.signupEnabled === false ? 'invite_only' : 'public');
    return { ...cfg, signupMode, signupEnabled: signupMode !== 'invite_only' };
  });
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

/**
 * Billing provider name. Deliberately an open `z.string()` (P4, spec:
 * billing-provider-modules): the authoritative set of providers is the API's
 * runtime provider-module registry (`providerNameSchema` in
 * apps/api/.../billing/providers/registry.ts), not a compile-time enum here —
 * so adding a provider module never requires an SDK release, and a stale SDK
 * degrades to a capitalized name rather than a broken flow. Unknown names are
 * rejected server-side by the registry-derived enum.
 */
export const BillingProviderSchema = z.string().min(1);
export type BillingProvider = z.infer<typeof BillingProviderSchema>;

export const BillingConfigSchema = z.object({
  /**
   * Master switch for this Application's billing. Default OFF for new apps —
   * the public billing API (checkout/subscriptions/coupons) returns 403
   * `BILLING_DISABLED` and the panel hides the Billing group until enabled.
   * Existing apps with billing already configured are grandfathered to `true`.
   */
  enabled: z.boolean().default(false),
  /**
   * Failed-payment recovery (dunning): reminder emails on day 0/3/7 and a
   * day-14 auto-cancel for subscriptions that go PAST_DUE. OFF by default — the
   * operator opts in per app. When false, no new dunning case is opened on a
   * payment failure; any case already OPEN keeps running to completion so an
   * in-flight recovery isn't stranded if dunning is later disabled.
   */
  dunningEnabled: z.boolean().default(false),
  provider: BillingProviderSchema,
  /**
   * Who a subscription bills + benefits by default: the individual end-user,
   * or their organization (shared credit pool / feature access for members).
   * `'org'` requires `authConfig.organizationsEnabled`. Checkout can override
   * per call via `organizationId`. Default `'user'` — no change for existing
   * apps. See ORG_BILLING.md.
   */
  billingSubject: z.enum(['user', 'org']).default('user'),
  /**
   * Free-tier fallback. Slug of a plan in this Application whose FEATURE
   * entitlements and included USAGE quota apply to end-users who have NO active
   * subscription — so freemium works without a $0 checkout. Read-time only: no
   * Subscription row is created, and CREDIT/LICENSE grants are NOT minted from
   * it (those are stateful and require a real subscription). Unset = no free
   * tier (current behavior). See #36 / BILLING_MODEL.md.
   */
  defaultPlanSlug: z.string().optional(),
  /** Default currency for this application. ISO 4217. */
  currency: z.string().length(3).default('USD'),
  /** Provider-specific config — Stripe account id, PayPal merchant id, etc. */
  metadata: z.record(z.unknown()).default({}),
});
export type BillingConfig = z.infer<typeof BillingConfigSchema>;

// ============================================================================
// Public DTOs — what the API actually returns over the wire.
// ============================================================================

/**
 * What an Application *is*. The Application is the isolation boundary in
 * Rekey — every domain row carries an `applicationId` — so "keep experiments
 * away from customers" means "use a second Application", and this field says
 * which of the two you are holding.
 *
 * It does NOT restrict which billing credentials the Application may hold —
 * live provider keys on a `DEVELOPMENT` Application are allowed, because
 * deliberately testing against a live processor is a real workflow and it is
 * your processor account. Environment is a label, the unit deployments are
 * billed and quota'd by, and what the API-key prefix is derived from.
 *
 * Set at creation and **immutable** — no endpoint changes it. To go live you
 * create a `PRODUCTION` Application rather than converting this one.
 */
export const AppEnvironmentSchema = z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']);
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

export const ApplicationDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  slug: z.string(),
  /**
   * OPTIONAL — `GET /api/v1/me` (the endpoint `applications.me()` calls, and
   * the documented SDK smoke test) does not return this field. It was declared
   * required here, so `rekey.applications.me().environment` typed as a
   * guaranteed enum and was `undefined` at runtime for every caller.
   *
   * Typed optional rather than "fixed" in the API: adding a field to a
   * response is a server change, and until every deployment ships it a client
   * that assumes its presence is wrong. Narrow before use.
   */
  environment: AppEnvironmentSchema.optional(),
  publicKey: z.string(),
  authConfig: AuthConfigSchema,
  billingConfig: BillingConfigSchema,
  createdAt: z.string().datetime(),
});
export type ApplicationDto = z.infer<typeof ApplicationDtoSchema>;

export const EndUserDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type EndUserDto = z.infer<typeof EndUserDtoSchema>;

export const ApiKeyDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ApiKeyDto = z.infer<typeof ApiKeyDtoSchema>;

// ============================================================================
// Auth requests + responses
// ============================================================================

export const SignUpRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  metadata: z.record(z.unknown()).optional(),
});
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

export const SignInRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

/**
 * Result of a successful primary-factor auth (password sign-in, OAuth
 * callback, MFA-verify). Includes `mfaRequired: false` as the
 * discriminator field for `SignInOutcomeDto`.
 */
export const AuthResultDtoSchema = z.object({
  mfaRequired: z.literal(false).default(false),
  /**
   * True when the Application's MFA policy is `required` but this user has not
   * enrolled yet. The session is still issued; the app should route the user
   * to MFA setup before granting sensitive access.
   */
  mfaEnrollmentRequired: z.boolean().optional(),
  endUser: EndUserDtoSchema,
  /** Short-lived access JWT. Pass via X-Rekey-User-Token. */
  accessToken: z.string(),
  accessTokenExpiresAt: z.string().datetime(),
  /** Long-lived refresh token. Use to mint new access tokens via auth.refresh(). */
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string().datetime(),
});
export type AuthResultDto = z.infer<typeof AuthResultDtoSchema>;

/**
 * The user passed the primary factor (password / OAuth) but has MFA
 * enrolled. The customer's server must prompt the user for their TOTP /
 * backup code and POST it to /auth/mfa-verify along with
 * `mfaChallengeToken` to receive a real session.
 *
 * The challenge token is short-lived (5 min) and bound to (endUser,
 * application). It is **not** a session token — it cannot be used at any
 * other endpoint.
 */
export const MfaChallengeResultDtoSchema = z.object({
  mfaRequired: z.literal(true),
  endUser: EndUserDtoSchema,
  mfaChallengeToken: z.string(),
  mfaChallengeExpiresAt: z.string().datetime(),
});
export type MfaChallengeResultDto = z.infer<typeof MfaChallengeResultDtoSchema>;

/**
 * Discriminated union over `mfaRequired`. Returned by `signIn`, OAuth
 * `callback`, and any future flow that accepts a primary factor — the
 * client always branches on `mfaRequired` to decide whether to render the
 * second-factor prompt or store the session tokens.
 */
export const SignInOutcomeDtoSchema = z.discriminatedUnion('mfaRequired', [
  AuthResultDtoSchema,
  MfaChallengeResultDtoSchema,
]);
export type SignInOutcomeDto = z.infer<typeof SignInOutcomeDtoSchema>;

export const MfaVerifyRequestSchema = z.object({
  mfaChallengeToken: z.string().min(1).max(2048),
  code: z.string().min(1).max(64),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().email().max(254),
  /**
   * Optional URL for the reset link in the email. `{token}` will be
   * URL-encoded and substituted by the server. Required only if you've
   * configured email transport — otherwise the server returns the raw
   * token in the response for you to forward.
   */
  resetUrl: z.string().max(2048).optional(),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ForgotPasswordResultDtoSchema = z.object({
  /** True iff a real user existed and a token was minted. False is also returned when the email is unknown — never enumerate. */
  delivered: z.boolean(),
  /**
   * True iff Rekey sent the email itself (BYO Resend creds or
   * RESEND_DEFAULT_* env configured). When true, `resetToken` is null and
   * no further action is needed from the caller.
   */
  emailSent: z.boolean(),
  /**
   * Raw reset token. Null when `delivered` is false (unknown email) OR
   * when `emailSent` is true (we delivered it). Present when the customer's
   * server is expected to forward it via its own provider.
   */
  resetToken: z.string().nullable(),
});
export type ForgotPasswordResultDto = z.infer<typeof ForgotPasswordResultDtoSchema>;

export const SendVerificationRequestSchema = z.object({
  /** Optional URL for the verify link. `{token}` is URL-encoded + substituted. */
  verifyUrl: z.string().max(2048).optional(),
});
export type SendVerificationRequest = z.infer<typeof SendVerificationRequestSchema>;

export const SendVerificationResultDtoSchema = z.object({
  /** True iff Rekey sent the email via its transport. */
  emailSent: z.boolean(),
  /** Raw verification token; null when emailSent is true. */
  verificationToken: z.string().nullable(),
});
export type SendVerificationResultDto = z.infer<typeof SendVerificationResultDtoSchema>;

export const VerifyEmailRequestSchema = z.object({
  token: z.string().min(1).max(512),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

/**
 * Known transactional email events. Templates can be customised per
 * Application in the panel. New events are added as part of a release;
 * older SDK versions will see unknown keys as plain strings.
 */
export const EmailEventKeySchema = z.enum([
  'password_reset',
  'email_verification',
  'workspace_invitation',
  'welcome',
  'mfa_enabled',
  'password_changed',
]);
export type EmailEventKey = z.infer<typeof EmailEventKeySchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(1).max(512),
  newPassword: z.string().min(1).max(256),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

// ============================================================================
// Billing
// ============================================================================

export const PlanIntervalSchema = z.enum(['MONTH', 'YEAR']);
export type PlanIntervalType = z.infer<typeof PlanIntervalSchema>;

/** What a plan sells. SUBSCRIPTION = recurring; LICENSE = key issued on purchase; USAGE = metered; CREDIT = prepaid balance / lead pack. */
export const PlanKindSchema = z.enum(['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT']);
/** The plan kinds this SDK version knows about. Closed — use it for registries. */
export type KnownPlanKind = z.infer<typeof PlanKindSchema>;
/** {@link Open}. A newer deployment may sell a kind this SDK predates. */
export type PlanKindType = Open<KnownPlanKind>;

/** Shape of a LICENSE-kind plan's key. PERPETUAL = never expires; TIMED = N-day; SEATS = capped activations. */
export const LicenseKindSchema = z.enum(['PERPETUAL', 'TIMED', 'SEATS']);
export type LicenseKindType = z.infer<typeof LicenseKindSchema>;

export const SubscriptionStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'EXPIRED',
]);
/** The statuses this SDK version knows about. Closed — use it for registries. */
export type KnownSubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;
/** {@link Open}. `TRIALING` is the obvious next one; handle the default branch. */
export type SubscriptionStatusType = Open<KnownSubscriptionStatus>;

export const PlanDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  slug: z.string(),
  name: z.string(),
  /** Amount in the smallest currency unit (cents/paise/sen). Always integer. */
  amount: z.number().int(),
  currency: z.string(),
  interval: PlanIntervalSchema,
  /** What this plan sells. Defaults to SUBSCRIPTION for plans created before kinds existed. */
  kind: PlanKindSchema,
  // ── LICENSE-kind config (null for non-LICENSE plans) ──
  licenseKind: LicenseKindSchema.nullable(),
  licenseSeatsAllowed: z.number().int().nullable(),
  /** For TIMED licenses: key lifetime in days from purchase. */
  licenseDurationDays: z.number().int().nullable(),
  // ── USAGE-kind config (null for non-USAGE plans) ──
  /** Slug of the usage meter this plan bills against. */
  meterSlug: z.string().nullable(),
  /** Per-unit price in the smallest currency unit. `amount` is the base/recurring fee. */
  pricePerUnitCents: z.number().int().nullable(),
  // ── CREDIT-kind config (null for non-CREDIT plans) ──
  /** Credits granted to the buyer on successful payment of a CREDIT-kind plan. */
  creditsAmount: z.number().int().nullable(),
  active: z.boolean(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PlanDto = Omit<z.infer<typeof PlanDtoSchema>, 'kind'> & {
  /** {@link Open} — always give your `switch` a default branch. */
  kind: PlanKindType;
};

// ── Credits (prepaid balance / lead-pack drawdown) ──
export const CreditReasonSchema = z.enum(['PURCHASE', 'GRANT', 'CONSUME', 'REFUND', 'ADJUST']);
/** The ledger reasons this SDK version knows about. Closed — use it for registries. */
export type KnownCreditReason = z.infer<typeof CreditReasonSchema>;
/** {@link Open}. */
export type CreditReasonType = Open<KnownCreditReason>;

export const CreditBalanceDtoSchema = z.object({
  applicationId: z.string(),
  /**
   * Exactly one of these is present, naming whose balance this is.
   *
   * `endUserId` used to be required, which was wrong: a credit pool can belong
   * to an organization, and those responses have never carried an end-user id.
   */
  endUserId: z.string().optional(),
  organizationId: z.string().optional(),
  /** Current spendable balance (whole credits, never negative). */
  balance: z.number().int(),
});
export type CreditBalanceDto = z.infer<typeof CreditBalanceDtoSchema>;

export const CreditLedgerEntryDtoSchema = z.object({
  id: z.string(),
  /** Signed change: + added (purchase/grant/refund), − consumed. */
  delta: z.number().int(),
  reason: CreditReasonSchema,
  /** Balance immediately after this entry. */
  balanceAfter: z.number().int(),
  description: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type CreditLedgerEntryDto = Omit<z.infer<typeof CreditLedgerEntryDtoSchema>, 'reason'> & {
  /** {@link Open} — always give your `switch` a default branch. */
  reason: CreditReasonType;
};

/** Body for POST /api/v1/credits/consume (end-user drawdown). */
export const ConsumeCreditsRequestSchema = z.object({
  /** How many credits to deduct. Must be a positive integer. */
  amount: z.number().int().positive(),
  /**
   * Optional idempotency key (e.g. the lead id). A repeated consume with the
   * same key is a no-op that returns the original result — safe to retry.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type ConsumeCreditsRequest = z.infer<typeof ConsumeCreditsRequestSchema>;

/** Body for the operator grant endpoint (manual top-up / adjustment). */
export const GrantCreditsRequestSchema = z.object({
  /**
   * Credits to add (positive) or remove (negative, for ADJUST).
   *
   * Bounded both ways by what an `integer` column holds. Unbounded, a grant of
   * `Number.MAX_SAFE_INTEGER` passed validation and Postgres answered `22003
   * value out of range`, which surfaced to the operator as a 500.
   */
  amount: z.number().int().min(-2_147_483_647).max(2_147_483_647),
  reason: z.enum(['GRANT', 'REFUND', 'ADJUST']).default('GRANT'),
  idempotencyKey: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type GrantCreditsRequest = z.infer<typeof GrantCreditsRequestSchema>;

export const SubscriptionDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  endUserId: z.string(),
  planId: z.string(),
  status: SubscriptionStatusSchema,
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAt: z.string().datetime().nullable(),
  canceledAt: z.string().datetime().nullable(),
  providerSubId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SubscriptionDto = Omit<z.infer<typeof SubscriptionDtoSchema>, 'status'> & {
  /** {@link Open} — always give your `switch` a default branch. */
  status: SubscriptionStatusType;
};

/**
 * The fields that decide whether a cancellation can be SCHEDULED. Accepts a
 * `Date` as well as an ISO string so the API (Prisma rows) and a client (the
 * serialized DTO) can ask the same question of the same subscription.
 */
export interface CancellationTimingInput {
  status: string;
  currentPeriodEnd: Date | string | null;
}

/**
 * What would cancelling this subscription RIGHT NOW do — leave them the rest
 * of the period they paid for, or stop access on the spot?
 *
 * A prediction about an action not yet taken. It does not say whether the
 * subscription is already ending; that is {@link isCancelScheduled}, which
 * reads `cancelAt`.
 *
 * This was called `cancelsAtPeriodEnd`, and that name got read as the state
 * question by everyone who met it, including three of our own starter kits and
 * two guides. Since it returns true for every healthy ACTIVE subscriber, the
 * misreading hides the cancel button from exactly the people who could use it,
 * and shows a `PAST_DUE` subscriber a button labelled "cancel at period end"
 * that ends their access immediately. Returning a value you cannot mistake for
 * a state is the point of the rename.
 *
 * Would `POST /billing/subscription/cancel` with the default
 * `atPeriodEnd: true` actually leave this subscriber the rest of the period
 * they have already paid for?
 *
 * `atPeriodEnd: true` is a REQUEST, not a guarantee. When this returns false
 * the API cancels on the spot: the row goes `CANCELED` immediately,
 * `subscription.canceled` fires, entitlements drop the same moment, and there
 * is no refund for the unused remainder. Anything that asks a customer to
 * confirm a cancellation should ask this first and say which of the two they
 * are about to get — promising "you keep access until <date>" to someone who
 * loses it on click is how a buyer gives up time they paid for.
 *
 * The two cases that still cancel immediately:
 *
 *   - **Not ACTIVE.** A `PAST_DUE` subscription (entitled, but the provider is
 *     mid-dunning) and an abandoned `PENDING` checkout both end at once. There
 *     is no settled period to run out.
 *   - **No `currentPeriodEnd`.** Nothing to schedule against.
 *
 * Having a payment provider is deliberately NOT part of this. It was until
 * 2026-08-03: a hand-provisioned subscription with no provider record was
 * cancelled outright however politely you asked, which is what Rekey Cloud —
 * selling with checkout closed — did to every buyer who cancelled. A provider
 * decides who TERMINATES the subscription when the date arrives (its webhook,
 * versus the API expiring the row locally), not when the paid time ends.
 *
 * ## Why this lives in shared-types
 *
 * It is one rule with two readers — the server that applies it and the UI that
 * has to describe it before the call is made — and the UI cannot derive it
 * from the response, because it has to speak first. Written out twice, it
 * drifted apart within a day of being written: the API stopped requiring a
 * provider and marketing's copy went on warning buyers about an immediate
 * cancellation that no longer happened. One implementation, imported by both.
 *
 * Known third site, deliberately NOT unified: `cancelSubscriptionById` (the
 * operator/MCP cancel-by-id path) still requires a provider. Relaxing it there
 * would leave provider-less rows scheduled with nothing to expire them —
 * `expireIfDue` only runs from `getCurrentSubscription`, which an operator
 * action does not go through. That needs the expiry seam widened first.
 */
export function cancelEffect(sub: CancellationTimingInput): 'period-end' | 'immediate' {
  // ACTIVE or TRIALING — deliberately NOT the full entitling set. PAST_DUE
  // entitles (a card not yet retried to exhaustion should not cut access) but
  // must still cancel IMMEDIATELY: there is no paid period left to run out, so
  // scheduling one would hand out time nobody paid for. Using
  // `isEntitlingStatus` here conflated the two questions and the suite caught
  // it.
  const inPaidPeriod = sub.status === 'ACTIVE' || sub.status === 'TRIALING';
  return inPaidPeriod && sub.currentPeriodEnd !== null ? 'period-end' : 'immediate';
}

/**
 * The statuses that mean "this subscriber currently has what they paid for".
 *
 * ONE definition, exported, because this concept was previously a bare
 * `['ACTIVE', 'PAST_DUE']` literal written out in eleven places across four
 * deployables — the API, the marketing site, the billing worker and the
 * portal. Adding TRIALING to nine of them and missing the rest produced
 * trialists who were entitled by the API, shown the purchase page by
 * marketing, and given no workspace by the provisioning worker.
 *
 * Import this. A miss is then a compile error rather than something a reviewer
 * has to find eleven times.
 *
 * PAST_DUE entitles deliberately: a card that has not yet been retried to
 * exhaustion is a dunning problem, not a reason to cut off a paying customer.
 * TRIALING entitles because a trial the subscriber cannot use is not a trial.
 */
export const ENTITLING_SUBSCRIPTION_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

/** Does this status entitle? Accepts anything, so an unknown value is false. */
export function isEntitlingStatus(status: string | null | undefined): boolean {
  return status != null && (ENTITLING_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Is this subscription ALREADY scheduled to end?
 *
 * The other question, and the one people usually mean. It reads `cancelAt`,
 * which the API sets when a cancellation has been accepted for the end of the
 * period — so it is true only after somebody has cancelled.
 *
 * Use this to decide what to display ("Access until 3 September" rather than
 * "Renews on 3 September") and whether to offer a cancel control at all.
 * Use {@link cancelEffect} to word that control before it is pressed.
 */
export function isCancelScheduled(sub: { cancelAt: Date | string | null }): boolean {
  return sub.cancelAt !== null;
}

export const CreateCheckoutRequestSchema = z.object({
  planSlug: z.string().min(1).max(40),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  /**
   * Optional billing provider override. When omitted, the geo router picks
   * one from the Application's enabled providers using `country` and the
   * per-provider routing rules.
   */
  provider: BillingProviderSchema.optional(),
  /** ISO 3166-1 alpha-2. Used by the geo router when `provider` is absent. */
  country: z.string().length(2).optional(),
  /**
   * Buy on behalf of an organization (owner+beneficiary). The caller must be
   * an OWNER/ADMIN of it; benefits flow to the org (shared pool / member
   * feature access) while the caller remains the owner/payer. Omit to bill the
   * individual end-user.
   */
  organizationId: z.string().min(1).optional(),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequestSchema>;

export const CreateCheckoutRequestWithCouponSchema = CreateCheckoutRequestSchema.extend({
  couponCode: z.string().min(1).max(40).optional(),
});

export const CheckoutResultDtoSchema = z.object({
  url: z.string().url(),
  subscription: SubscriptionDtoSchema,
  /** Discount applied (smallest currency unit). 0 if no coupon. */
  discountAmount: z.number().int().min(0),
  /** Which provider issued this checkout. Stamped on Subscription.provider. */
  provider: BillingProviderSchema,
});
export type CheckoutResultDto = z.infer<typeof CheckoutResultDtoSchema>;

/**
 * What a billing provider module can do, as declared by its registry entry.
 * Served by `GET /api/v1/billing/providers` (P4 discovery) so front-ends can
 * adapt (e.g. no auto-webhook button for Razorpay) without name checks.
 */
export const BillingProviderCapabilitiesSchema = z.object({
  oneTime: z.boolean(),
  captureStep: z.boolean(),
  autoWebhookRegister: z.boolean(),
  periodRotationEvents: z.boolean(),
  onlineVerify: z.boolean(),
  /**
   * Whether an ad-hoc coupon discount can be applied, per flow. Optional
   * because a provider module may predate the field — and absent means
   * "cannot", never "unknown, try it": a checkout that sends a coupon to a
   * provider that drops it charges the buyer full price. Use it to hide the
   * coupon field when the only provider on offer cannot honour one.
   */
  discounts: z.object({ oneTime: z.boolean(), recurring: z.boolean() }).optional(),
});
export type BillingProviderCapabilities = z.infer<typeof BillingProviderCapabilitiesSchema>;

export const BillingProviderInfoDtoSchema = z.object({
  provider: BillingProviderSchema,
  priority: z.number().int().min(0),
  countries: z.array(z.string().length(2)),
  // P4 discovery additions — optional so pre-P4 servers still parse. Prefer
  // `label` when present; fall back to a capitalized `provider` otherwise.
  label: z.string().optional(),
  docsUrl: z.string().optional(),
  capabilities: BillingProviderCapabilitiesSchema.optional(),
});
export type BillingProviderInfoDto = z.infer<typeof BillingProviderInfoDtoSchema>;

export const ProvidersListDtoSchema = z.object({
  country: z.string().length(2).nullable(),
  providers: z.array(BillingProviderInfoDtoSchema),
});
export type ProvidersListDto = z.infer<typeof ProvidersListDtoSchema>;

// ============================================================================
// Coupons
// ============================================================================

export const CouponDiscountTypeSchema = z.enum(['PERCENT', 'AMOUNT']);
export type CouponDiscountTypeValue = z.infer<typeof CouponDiscountTypeSchema>;

export const CouponDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  code: z.string(),
  discountType: CouponDiscountTypeSchema,
  /** PERCENT: basis points (1500 = 15.00%). AMOUNT: smallest currency unit. */
  amountOff: z.number().int().min(0),
  currency: z.string().nullable(),
  planSlugs: z.array(z.string()),
  active: z.boolean(),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
  maxRedemptions: z.number().int().nullable(),
  maxRedemptionsPerUser: z.number().int().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CouponDto = z.infer<typeof CouponDtoSchema>;

export const ValidateCouponRequestSchema = z.object({
  code: z.string().min(1).max(40),
  planSlug: z.string().min(1).max(40),
});
export type ValidateCouponRequest = z.infer<typeof ValidateCouponRequestSchema>;

/**
 * What a BUYER may see of a coupon — everything needed to render "15% off" and
 * nothing else.
 *
 * `CouponDto` above is the operator's view and stays that way. The public
 * validate endpoint used to return it verbatim, so any holder of the
 * publishable key could read `maxRedemptions`, `maxRedemptionsPerUser` and the
 * operator's private `metadata` off a pricing page.
 */
export const PublicCouponDtoSchema = z.object({
  code: z.string(),
  discountType: CouponDiscountTypeSchema,
  /** PERCENT: basis points (1500 = 15.00%). AMOUNT: smallest currency unit. */
  amountOff: z.number().int().min(0),
  currency: z.string().nullable(),
});
export type PublicCouponDto = z.infer<typeof PublicCouponDtoSchema>;

export const ValidateCouponResultDtoSchema = z.object({
  coupon: PublicCouponDtoSchema,
  plan: z.object({
    slug: z.string(),
    name: z.string(),
    amount: z.number().int(),
    currency: z.string(),
  }),
  discountAmount: z.number().int().min(0),
  amountAfterDiscount: z.number().int().min(0),
});
export type ValidateCouponResultDto = z.infer<typeof ValidateCouponResultDtoSchema>;

// ============================================================================
// MCP / OAuth + per-app access controls
// ============================================================================

/** Per-Application network access controls (operator-managed). */
export const AccessConfigSchema = z.object({
  /** CIDRs / IPs (v4+v6) that server-side secret keys may call from. Empty = any. */
  ipAllowlist: z.array(z.string()),
  /** Browser origins allowed for this app's API calls (scheme+host[:port]). */
  corsOrigins: z.array(z.string()),
});
export type AccessConfig = z.infer<typeof AccessConfigSchema>;

/** RFC 7662 token-introspection response (subset Rekey emits). */
export const OAuthIntrospectionResponseSchema = z.object({
  active: z.boolean(),
  sub: z.string().optional(),
  scope: z.string().optional(),
  aud: z.string().optional(),
  exp: z.number().optional(),
  iat: z.number().optional(),
  token_type: z.string().optional(),
  client_id: z.string().optional(),
});
export type OAuthIntrospectionResponse = z.infer<typeof OAuthIntrospectionResponseSchema>;

/** RFC 8414 authorization-server metadata (subset Rekey emits for MCP). */
export const OAuthAuthServerMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  introspection_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});
export type OAuthAuthServerMetadata = z.infer<typeof OAuthAuthServerMetadataSchema>;

/**
 * One RSA public key as published at `GET /.well-known/jwks.json` (RFC 7517).
 * `n` / `e` are base64url. `kid` matches the `kid` header of RS256-signed
 * end-user access tokens.
 */
export const JwkRsaPublicSchema = z.object({
  kty: z.literal('RSA'),
  kid: z.string(),
  alg: z.literal('RS256'),
  use: z.literal('sig'),
  n: z.string(),
  e: z.string(),
});
export type JwkRsaPublic = z.infer<typeof JwkRsaPublicSchema>;

/** Body of `GET /.well-known/jwks.json` — the deployment's RS256 key set. */
export const JwksDtoSchema = z.object({ keys: z.array(JwkRsaPublicSchema) });
export type JwksDto = z.infer<typeof JwksDtoSchema>;

/** A security audit-log event (operator audit view). */
export const SecurityEventDtoSchema = z.object({
  id: z.string(),
  type: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  applicationId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});
export type SecurityEventDto = z.infer<typeof SecurityEventDtoSchema>;

/** Result of POST /api/v1/credits/consume (end-user drawdown). */
export const ConsumeCreditsResultDtoSchema = z.object({
  /** Spendable balance after the drawdown. */
  balance: z.number().int(),
  /** Id of the ledger entry created (or the original entry on an idempotent replay). */
  entryId: z.string(),
  /** False when an idempotent replay matched a prior call — balance is unchanged. */
  applied: z.boolean(),
});
export type ConsumeCreditsResultDto = z.infer<typeof ConsumeCreditsResultDtoSchema>;

// ============================================================================
// Organizations — end-user teams (gated by AuthConfig.organizationsEnabled)
// ============================================================================

export const OrganizationRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const OrganizationDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  metadata: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrganizationDto = z.infer<typeof OrganizationDtoSchema>;

export const OrganizationWithRoleDtoSchema = OrganizationDtoSchema.extend({
  /** The calling user's role in this organization. */
  role: OrganizationRoleSchema,
});
export type OrganizationWithRoleDto = z.infer<typeof OrganizationWithRoleDtoSchema>;

export const OrganizationMemberDtoSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  endUserId: z.string(),
  email: z.string(),
  role: OrganizationRoleSchema,
  createdAt: z.string().datetime(),
});
export type OrganizationMemberDto = z.infer<typeof OrganizationMemberDtoSchema>;

export const OrganizationInvitationDtoSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  role: OrganizationRoleSchema,
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type OrganizationInvitationDto = z.infer<typeof OrganizationInvitationDtoSchema>;

// ============================================================================
// Licenses — keys issued by LICENSE-kind plans
// ============================================================================

export const LicenseStatusSchema = z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']);
export type LicenseStatusType = z.infer<typeof LicenseStatusSchema>;

export const LicenseDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  endUserId: z.string(),
  planId: z.string().nullable(),
  kind: LicenseKindSchema,
  status: LicenseStatusSchema,
  keyPrefix: z.string(),
  expiresAt: z.string().datetime().nullable(),
  seatsAllowed: z.number().int().nullable(),
  metadata: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type LicenseDto = z.infer<typeof LicenseDtoSchema>;

/**
 * Result of POST /api/v1/licenses/verify. Always HTTP 200 — branch on `ok`
 * (invalid licenses are a `false` result, not an error) so client software
 * can loop on the outcome without try/catch.
 */
export const LicenseVerifyResultDtoSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), license: LicenseDtoSchema }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['unknown', 'wrong_application', 'revoked', 'expired', 'seats_exhausted']),
    license: LicenseDtoSchema.optional(),
  }),
]);
export type LicenseVerifyResultDto = z.infer<typeof LicenseVerifyResultDtoSchema>;

// ============================================================================
// Usage metering
// ============================================================================

export const UsageRecordDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  /**
   * The meter's slug, not its internal id.
   *
   * The row stores `meterId`; the caller passed a slug and has no way to
   * resolve an id back. The route shapes the row into this DTO rather than
   * returning it raw — which is what it used to do, so `applicationId` and
   * `meterSlug` were both promised here and absent from the wire.
   */
  meterSlug: z.string(),
  quantity: z.number(),
  /** Set when the usage was attributed to an end-user. Exclusive with `organizationId`. */
  endUserId: z.string().nullable(),
  /** Set when the usage was attributed to an organization. Exclusive with `endUserId`. */
  organizationId: z.string().nullable(),
  occurredAt: z.string().datetime(),
});
export type UsageRecordDto = z.infer<typeof UsageRecordDtoSchema>;

export const UsageAggregateDtoSchema = z.object({
  meterSlug: z.string(),
  /** Summed `quantity` over the window. */
  total: z.number(),
  /** How many records contributed to `total`. Always returned; previously undocumented. */
  count: z.number(),
  /** Echoes the requested window. Null means unbounded on that side. */
  from: z.string().datetime().nullable(),
  to: z.string().datetime().nullable(),
});
export type UsageAggregateDto = z.infer<typeof UsageAggregateDtoSchema>;

// ============================================================================
// Outbound webhooks — the events Rekey POSTs to YOUR app
// ============================================================================
//
// This registry mirrors the API's `KNOWN_WEBHOOK_EVENTS`
// (apps/api/src/modules/webhooks/events.ts) exactly — same names, same order.
// Subscribe an endpoint to specific events (or the `"*"` wildcard) via the
// panel or POST /api/v1/tenant/applications/:id/webhooks. Verify inbound
// deliveries with `verifyWebhookSignature` from `@rekey.dev/node`.

/**
 * Every outbound webhook event Rekey can emit, with a human/agent-readable
 * description. Use it to render event pickers, generate docs, or autocomplete
 * `events` arrays when registering endpoints.
 */
export const WEBHOOK_EVENTS = [
  {
    name: 'user.created',
    description:
      'An end-user account was created — password sign-up or first OAuth sign-in.',
  },
  {
    name: 'user.updated',
    description: "An end-user's profile changed (email, role, metadata).",
  },
  {
    name: 'user.deleted',
    description: 'An end-user account was deleted.',
  },
  {
    name: 'user.erased',
    description:
      'An end-user was erased for GDPR (tombstoned): their PII/auth material was hard-deleted while financial records are retained anonymized, and they can never authenticate again. Propagate the erasure to your own copies of their PII. Payload: `data.user` with `id` + `erasedAt`.',
  },
  {
    name: 'session.revoked',
    description:
      'An end-user session (refresh token) was revoked — sign-out, per-session revoke, or kill-switch.',
  },
  {
    name: 'mfa.enabled',
    description:
      'The end-user enabled a second factor — TOTP enrollment confirmed, or a passkey was registered.',
  },
  {
    name: 'mfa.disabled',
    description: 'The end-user disabled MFA.',
  },
  {
    name: 'password.changed',
    description:
      "The end-user's password changed (authenticated change or reset-token flow). All their other sessions are revoked.",
  },
  {
    name: 'email.verified',
    description: 'The end-user verified their email address.',
  },
  // Billing lifecycle — emitted from the provider inbound-webhook handlers when
  // LOCAL state actually transitions (a provider-event replay that changes
  // nothing emits nothing). A provider retry after a 5xx on Rekey's side may
  // still re-emit; consumers must dedupe on the envelope's `eventId`.
  //
  // Every `subscription.*` payload carries `data.subscription.entitlements` —
  // what THAT subscription grants, with its per-subscription overrides applied.
  // Act on it rather than on the plan slug: two subscribers on one plan can
  // hold different quantities, and the slug cannot tell you so.
  {
    name: 'subscription.activated',
    description:
      'A provider webhook transitioned a Subscription to ACTIVE. Payload: `data.subscription` with ids, plan slug/name/kind, amount/currency/interval, the resolved `entitlements` array, and period end.',
  },
  {
    name: 'subscription.canceled',
    description:
      'A Subscription transitioned to CANCELED. Payload: `data.subscription` (includes `canceledAt`).',
  },
  {
    name: 'subscription.past_due',
    description:
      'A Subscription transitioned to PAST_DUE (payment failed / retrying). Payload: `data.subscription`.',
  },
  {
    name: 'payment.succeeded',
    description:
      'A Payment row was recorded as SUCCEEDED. Payload: `data.payment` with ids, plan slug (when subscription-linked), amount/currency/status.',
  },
  {
    name: 'payment.failed',
    description:
      'A Payment row was recorded as FAILED. Payload: `data.payment`.',
  },
  // Dunning lifecycle — a "case" tracks one subscription's trip through
  // PAST_DUE (reminder emails day 0/3/7; exhaustion at day 14). Payloads carry
  // `data.dunningCase` with ids, status, failedAttempts/remindersSent and the
  // open/close timestamps.
  {
    name: 'dunning.case_opened',
    description:
      'A Subscription went PAST_DUE and a dunning case was opened (reminders scheduled at day 0/3/7; the provider keeps retrying the card). Payload: `data.dunningCase`.',
  },
  {
    name: 'dunning.case_recovered',
    description:
      'A later successful payment / reactivation recovered a PAST_DUE subscription — its dunning case closed as RECOVERED. Payload: `data.dunningCase`.',
  },
  {
    name: 'dunning.case_exhausted',
    description:
      'No recovery within 14 days — the dunning case closed as EXHAUSTED and the subscription was canceled (a `subscription.canceled` event accompanies this). Payload: `data.dunningCase`.',
  },
] as const;

/**
 * Union of every outbound webhook event name this SDK version ships in its
 * registry (e.g. `'user.created'`). Closed — it IS the registry.
 */
export type KnownWebhookEventType = (typeof WEBHOOK_EVENTS)[number]['name'];

/**
 * {@link Open}. What actually arrives on the wire: a deployment one minor
 * version ahead sends events this SDK's registry does not list, so
 * `WebhookEventEnvelope.type` is this and your `switch` needs a default branch.
 * Narrow to the closed set with {@link isKnownWebhookEvent}.
 */
export type WebhookEventType = Open<KnownWebhookEventType>;

/** Just the event names, in registry order — mirrors the API's KNOWN_WEBHOOK_EVENTS. */
export const KNOWN_WEBHOOK_EVENTS: ReadonlyArray<KnownWebhookEventType> = WEBHOOK_EVENTS.map(
  (e) => e.name,
);

/** Type guard narrowing an open event name down to this SDK's registry. */
export function isKnownWebhookEvent(s: string): s is KnownWebhookEventType {
  return (KNOWN_WEBHOOK_EVENTS as ReadonlyArray<string>).includes(s);
}

export const WebhookEventTypeSchema = z.enum(
  KNOWN_WEBHOOK_EVENTS as [KnownWebhookEventType, ...KnownWebhookEventType[]],
);

/**
 * The wire envelope of every outbound delivery. Treat `eventId` as the
 * consumer-side idempotency key — retries (ours or a provider-triggered
 * re-emit) reuse the same id, so deduping is one cheap upsert.
 */
export const WebhookEventEnvelopeSchema = z.object({
  /** Stable cuid; safe to use as the consumer-side idempotency key. */
  eventId: z.string(),
  /** ISO timestamp the event was generated server-side. */
  occurredAt: z.string().datetime(),
  type: WebhookEventTypeSchema,
  /** Application id this event happened in. */
  applicationId: z.string(),
  data: z.record(z.unknown()),
});
export interface WebhookEventEnvelope<TData = Record<string, unknown>> {
  eventId: string;
  occurredAt: string;
  type: WebhookEventType;
  applicationId: string;
  data: TData;
}

// ── Webhook endpoint management (operator surface) ──

/** A registered outbound webhook endpoint (no secret — that is shown once at create/rotate). */
export const WebhookEndpointDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** Subscribed event names, or `["*"]` for everything. */
  events: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
});
export type WebhookEndpointDto = z.infer<typeof WebhookEndpointDtoSchema>;

export const WebhookDeliveryStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED']);
export type WebhookDeliveryStatusType = z.infer<typeof WebhookDeliveryStatusSchema>;

/** One delivery attempt row — GET .../webhooks/:endpointId/deliveries. */
export const WebhookDeliveryDtoSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  status: WebhookDeliveryStatusSchema,
  attempts: z.number().int(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime().nullable(),
});
export type WebhookDeliveryDto = z.infer<typeof WebhookDeliveryDtoSchema>;

/** Result of POST .../webhooks/:endpointId/deliveries/:deliveryId/retry. */
export const RetryWebhookDeliveryResultDtoSchema = z.object({
  queued: z.literal(true),
});
export type RetryWebhookDeliveryResultDto = z.infer<typeof RetryWebhookDeliveryResultDtoSchema>;

// ============================================================================
// Tenant / operator DTOs — payloads of the operator API under /api/v1/tenant/*
// ============================================================================
//
// These endpoints authenticate with an operator PANEL SESSION (tenant JWT) —
// not an Application secret key — so the end-user SDKs (@rekey.dev/node etc.)
// deliberately do NOT expose them. The shapes live here so the panel, agents,
// and any session-bearing automation share one definition.

export const PaymentStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']);
/** The payment statuses this SDK version knows about. Closed — use it for registries. */
export type KnownPaymentStatus = z.infer<typeof PaymentStatusSchema>;
/** {@link Open}. */
export type PaymentStatusType = Open<KnownPaymentStatus>;

/** One row of GET /api/v1/tenant/applications/:id/payments (operator billing view). */
export const TenantPaymentDtoSchema = z.object({
  id: z.string(),
  endUserId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  /** Smallest currency unit (cents/paise/sen). Always integer. */
  amount: z.number().int(),
  currency: z.string(),
  status: PaymentStatusSchema,
  providerPaymentId: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.string().datetime(),
  /** Joined from the paying end-user, when the payment is attributable to one. */
  endUserEmail: z.string().nullable(),
});
export type TenantPaymentDto = Omit<z.infer<typeof TenantPaymentDtoSchema>, 'status'> & {
  /** {@link Open} — always give your `switch` a default branch. */
  status: PaymentStatusType;
};

/** Query params of GET /api/v1/tenant/applications/:id/payments. */
export interface TenantPaymentsListQuery {
  /** Closed on purpose — this is a filter you SEND, so only real statuses are valid. */
  status?: KnownPaymentStatus;
  /** Inclusive createdAt window — ISO date-times. */
  from?: string;
  to?: string;
  /** Default `createdAt`. */
  sort?: 'createdAt' | 'amount' | 'status';
  /** Default `desc`. */
  order?: 'asc' | 'desc';
  /** Default 50, max 100. */
  limit?: number;
  offset?: number;
}

/** One point of the 12-month revenue series. `month` is `YYYY-MM` (UTC). */
export const MonthlyRevenuePointSchema = z.object({
  month: z.string(),
  amountCents: z.number().int(),
});
export type MonthlyRevenuePoint = z.infer<typeof MonthlyRevenuePointSchema>;

/**
 * GET /api/v1/tenant/applications/:id/billing/stats — the Billing Overview
 * tiles. All amounts are integers in the smallest currency unit. MRR counts
 * ACTIVE recurring SUBSCRIPTION plans only (YEAR plans normalized to monthly
 * via floor(amount/12)); amounts in different currencies are never summed —
 * `mrrCents` reports the dominant currency and `mixedCurrencies` flags when
 * other currencies were present (the figure is partial).
 */
export const BillingStatsDtoSchema = z.object({
  activeSubscriptions: z.number().int(),
  pastDueSubscriptions: z.number().int(),
  /** Subscriptions whose cancellation landed in the last 30 days. */
  canceledLast30d: z.number().int(),
  /** Subscriptions created in the last 30 days (any status). */
  newSubscriptionsLast30d: z.number().int(),
  /** Monthly recurring revenue in the smallest unit of `mrrCurrency`. */
  mrrCents: z.number().int(),
  /** Currency of `mrrCents` (dominant across active plans); null when no MRR. */
  mrrCurrency: z.string().nullable(),
  /** True when active SUBSCRIPTION plans span more than one currency. */
  mixedCurrencies: z.boolean(),
  /** SUM(amount) of SUCCEEDED payments in the last 30 days. */
  revenueLast30dCents: z.number().int(),
  paymentsLast30d: z.object({
    succeeded: z.number().int(),
    failed: z.number().int(),
  }),
  /** Last 12 UTC calendar months (oldest first), gap-filled with zeroes. */
  monthlyRevenue: z.array(MonthlyRevenuePointSchema),
});
export type BillingStatsDto = z.infer<typeof BillingStatsDtoSchema>;

/** One row of GET /api/v1/tenant/applications/:id/end-users (operator listing). */
export const TenantEndUserDtoSchema = z.object({
  id: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  /** Per-application RBAC role (free-form; default "user"). */
  role: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type TenantEndUserDto = z.infer<typeof TenantEndUserDtoSchema>;

/** Query params of GET /api/v1/tenant/applications/:id/end-users. */
export interface TenantEndUsersListQuery {
  /** Substring match on email (lowercased server-side). */
  search?: string;
  emailVerified?: boolean;
  /** Only users holding at least one subscription with this status. Closed — you SEND this. */
  subscriptionStatus?: KnownSubscriptionStatus;
  /** Default `createdAt`. */
  sort?: 'createdAt' | 'email';
  /** Default `desc`. */
  order?: 'asc' | 'desc';
  /** Default 25, max 100. */
  limit?: number;
  offset?: number;
}

export const SecurityEventActorTypeSchema = z.enum(['operator', 'end_user', 'system']);
export type SecurityEventActorType = z.infer<typeof SecurityEventActorTypeSchema>;

/**
 * Query params of GET /api/v1/tenant/security-events (OWNER/ADMIN only).
 * `format: 'csv'` returns a downloadable CSV instead of JSON — the CSV path
 * ignores limit/offset and is capped at 5000 newest rows server-side.
 */
export interface SecurityEventsListQuery {
  applicationId?: string;
  /** Event type filter, e.g. `app.api_key.created`. */
  type?: string;
  actorType?: SecurityEventActorType;
  /** Inclusive createdAt window — ISO date-times. */
  from?: string;
  to?: string;
  /** Default `createdAt`. */
  sort?: 'createdAt' | 'type';
  /** Default `desc`. */
  order?: 'asc' | 'desc';
  format?: 'json' | 'csv';
  /** Default 50, max 200 (JSON path). */
  limit?: number;
  offset?: number;
}

// ── GDPR / DSAR end-user data export ──
//
// GET /api/v1/tenant/applications/:id/end-users/:euid/export returns one JSON
// document of everything Rekey stores about an end-user (OWNER/ADMIN only).
// Credential material (password hashes, token hashes, MFA secrets, license key
// hashes, passkey public keys) is never included. Several sections are capped
// server-side; see `notes` in the document. Plain interfaces (no Zod) — this
// is a large read-only document consumers render or archive, not re-validate.

export interface EndUserExportProfile {
  id: string;
  applicationId: string;
  email: string;
  emailVerified: boolean;
  role: string;
  metadata: Record<string, unknown> | null;
  /**
   * Failures counted against this end-user's sign-in scope right now.
   *
   * Sourced from the Redis brute-force limiter, which is where lockout has
   * lived since it moved off the `EndUser` row. The limiter clears its counter
   * the moment it sets a lock, so a LOCKED account reports the policy
   * threshold (10) — the documented floor on what tripped the lock, not a
   * surviving count. Below the threshold this is the live counter.
   */
  failedSignInAttempts: number;
  /**
   * When the current sign-in lockout expires, or `null` when not locked.
   * Reconstructed from the lock's remaining TTL, so it moves with the limiter
   * instead of being a snapshot.
   */
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EndUserExportSession {
  id: string;
  /** `"session"` (SDK refresh) or `"mcp"` (per-app OAuth token). */
  kind: string;
  userAgent: string | null;
  ip: string | null;
  activeOrganizationId: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface EndUserExportSubscription {
  id: string;
  status: SubscriptionStatusType;
  provider: string | null;
  providerSubId: string | null;
  currentPeriodEnd: string | null;
  cancelAt: string | null;
  canceledAt: string | null;
  beneficiaryOrgId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  plan: {
    slug: string;
    name: string;
    kind: PlanKindType;
    amount: number;
    currency: string;
    interval: PlanIntervalType;
  };
}

/** The full DSAR document. `exportVersion` is 1 today; bumps on shape changes. */
export interface EndUserExportDocument {
  exportVersion: number;
  exportedAt: string;
  applicationId: string;
  /** Human-readable caveats — section caps, what is excluded, etc. */
  notes: string[];
  endUser: EndUserExportProfile;
  oauthIdentities: Array<{
    id: string;
    provider: string;
    providerAccountId: string;
    email: string | null;
    createdAt: string;
  }>;
  /** Session METADATA only — never token material. Capped (newest first). */
  sessions: EndUserExportSession[];
  /** MFA enrollment metadata only — never secrets/backup codes. */
  mfa: {
    enrolled: boolean;
    enrolledAt: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  passkeys: Array<{
    id: string;
    credentialId: string;
    deviceName: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }>;
  organizationMemberships: Array<{
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    role: OrganizationRole;
    createdAt: string;
  }>;
  subscriptions: EndUserExportSubscription[];
  /** Capped (newest first). */
  payments: Array<{
    id: string;
    subscriptionId: string | null;
    amount: number;
    currency: string;
    status: PaymentStatusType;
    providerPaymentId: string | null;
    description: string | null;
    createdAt: string;
  }>;
  /** License metadata — keyPrefix only, never the key hash. */
  licenses: Array<{
    id: string;
    kind: LicenseKindType;
    status: LicenseStatusType;
    keyPrefix: string;
    seatsAllowed: number | null;
    organizationId: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    plan: { slug: string; name: string } | null;
  }>;
  /** Sum across the user's credit balances in this Application. */
  creditBalance: number;
  /** Capped (newest first). */
  creditLedger: Array<{
    id: string;
    delta: number;
    reason: CreditReasonType;
    balanceAfter: number;
    description: string | null;
    createdAt: string;
  }>;
  /** Capped (newest first) — `notes` flags when the cap was hit. */
  usageRecords: Array<{
    id: string;
    meterSlug: string;
    meterName: string;
    unit: string;
    quantity: number;
    occurredAt: string;
    createdAt: string;
  }>;
  /** Events where this user was the actor. Capped (newest first). */
  securityEvents: Array<{
    id: string;
    type: string;
    ip: string | null;
    userAgent: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
  impersonations: Array<{
    id: string;
    operatorUserId: string;
    reason: string | null;
    startedAt: string;
    endedAt: string | null;
    ip: string | null;
  }>;
}
