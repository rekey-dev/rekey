/**
 * @rekey.dev/shared-types
 *
 * Zod schemas + TypeScript types shared between the API and the SDKs.
 * Anything serialized over the wire lives here, never duplicate a shape.
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

export {
  CHECKOUT_TOKEN_PATTERN,
  CHECKOUT_BROWSER_ORIGINS,
  CHECKOUT_READINESS_CHECK_IDS,
  checkoutTokenMode,
  STRIPE_JS_RELEASE_TRAIN,
  STRIPE_RETURN_PARAM,
  STRIPE_CHECKOUT_SESSION_ID_PATTERN,
  CHECKOUT_PAGE_PROVIDERS,
  type CheckoutBrowserOrigins,
  type CheckoutPaymentMode,
  type CheckoutReadinessCheckId,
} from './checkout.js';

export {
  CURRENCY_TABLE,
  MAX_PRICE_AMOUNT,
  chargeableStep,
  currencyRecord,
  currencySellability,
  formatMoney,
  isSellableCurrency,
  localCurrencyOf,
  minorUnitExponent,
  percentageDiscount,
  priceFallbackMessage,
  sellableCurrencies,
  validatePriceAmount,
  type CurrencyRecord,
  type CurrencySellability,
  type PriceAmountRule,
  type PriceAmountValidation,
  type PriceFallbackSides,
  type UnsellableReason,
} from './currency/index.js';

export { BILLING_MONEY_ERROR_CODES, isBillingMoneyError, type BillingMoneyErrorCode } from './billing-errors.js';

export {
  BillingCredentialDtoSchema,
  BillingCredentialStatusDtoSchema,
  BillingProviderModuleDtoSchema,
  BillingProviderModulesDtoSchema,
  CreatePlanRequestSchema,
  CreateRefundRequestSchema,
  PlanPriceInputSchema,
  REFUND_BLOCKED_REASONS,
  REFUND_INITIATORS,
  REFUND_STATUSES,
  RefundBlockedReasonSchema,
  RefundDtoSchema,
  RefundResultDtoSchema,
  RefundedPaymentDtoSchema,
  SetPlanPriceRequestSchema,
  UpdatePlanRequestSchema,
  refundBlockedMessage,
  type BillingCredentialDto,
  type BillingCredentialStatusDto,
  type BillingProviderModuleDto,
  type BillingProviderModulesDto,
  type CreatePlanRequest,
  type CreateRefundRequest,
  type PaymentWebhookData,
  type PlanPriceInput,
  type RefundBlockedReason,
  type RefundDto,
  type RefundResultDto,
  type RefundedPaymentDto,
  type SetPlanPriceRequest,
  type SubscriptionWebhookData,
  type UpdatePlanRequest,
} from './billing-operator.js';

export {
  AdminPaymentRowDtoSchema,
  AdminSubscriptionRowDtoSchema,
  type AdminPaymentRowDto,
  type AdminSubscriptionRowDto,
} from './admin-billing.js';

export {
  BILLING_EVENT_ACTOR_TYPES,
  BILLING_EVENT_DATA,
  BILLING_EVENT_TIER,
  BILLING_EVENT_TIERS,
  BILLING_EVENT_TYPES,
  BillingEventSchema,
  RECONCILIATION_FINDING_KINDS,
  diagnosticReasonOf,
  BOUNDED_DIAGNOSTIC_TYPES,
  NOT_RECORDED_REASONS,
  type NotRecordedReason,
  type BoundedDiagnosticType,
  type ReconciliationFindingKind,
  type BillingEvent,
  type BillingEventActorType,
  type BillingEventData,
  type BillingEventOf,
  type BillingEventTier,
  type BillingEventType,
  type DiagnosticBillingEventType,
} from './billing-events.js';

// ============================================================================
// Errors
// ============================================================================

// `RekeyError` + `RekeyErrorShape` live in their own zero-import module so a
// browser bundle can reach the class without dragging zod and every schema in
// this file along with it (see ./error.ts for the measurement). They are
// re-exported here unchanged, same class identity, so `instanceof` holds
// whichever path you import from.
export { RekeyError } from './error.js';
export type { RekeyErrorShape } from './error.js';
import { type RekeyErrorShape } from './error.js';
import { RefundBlockedReasonSchema } from './billing-operator.js';

// Decides the `Secure` attribute on a session cookie from the REQUEST rather
// than from a build-time NODE_ENV. Lives in its own zero-import module for the
// same reason RekeyError does, Edge middleware and client-adjacent code reach
// for it without pulling zod in.
export { cookieSecureFor } from './cookie-security.js';
export type { CookieSecurityInput } from './cookie-security.js';

export {
  SIGNUP_DOMAIN_LIST_MAX,
  SignupRestrictionsSchema,
  domainMatchesRule,
  normalizeDomain,
  normalizeDomainRule,
  type SignupRestrictions,
} from './signup-restrictions.js';
import { SignupRestrictionsSchema } from './signup-restrictions.js';

// Whether a failed request ever reached the server. Zero-import for the same
// reason, and shared so every refresh client keeps one list of codes.
export { NEVER_CONNECTED_CODES, neverConnected } from './transport.js';

// Custom transactional email templates and the send route.
export * from './custom-email.js';
export * from './contacts.js';

// The client platform a session came from, and the `client` hint that names it.
export * from './client-platform.js';
import { ClientHintSchema } from './client-platform.js';

// Profile fields: an Application's onboarding questions and each user's answers.
export * from './profile.js';

// How an end-user account was created (EndUser.createdVia).
export * from './created-via.js';

// An Application's reporting timezone and the settings route that sets it.
export * from './timezone.js';

// The Users overview analytics endpoint: query, sections and response shapes.
export * from './analytics.js';
import { ONBOARDING_STATUSES, type EndUserProfile } from './profile.js';

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
  /**
   * Structured, code-specific context a client can act on without parsing
   * `message`. Shape is documented per code; today `DEVICE_LIMIT_REACHED`
   * carries `{ limit, devices[] }` so an app can offer "release one" instead of
   * a dead end. Absent on every other error.
   */
  details: z.record(z.unknown()).optional(),
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
  /** True when another page exists, i.e. `offset + limit < total`. */
  hasMore: z.boolean(),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

/**
 * The `data` of every paginated list response: `{items, page}`.
 *
 * Until 2.0.0-rc.3 these endpoints returned a bare array. A bare array cannot
 * carry `total`, so a caller that did not pass `limit` could not tell a
 * complete list from a truncated one, 36 rows in the database, 25 on the wire,
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
 * log-shaped ones allow 200, each method's docblock says which).
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
 * who wrote an exhaustive `switch` compiles fine today and breaks on upgrade,
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
// Workspace limits, the optional ceilings stored in Tenant.limits (Json column).
// ============================================================================

/**
 * Per-workspace (Tenant) resource ceilings.
 *
 * Every key is optional and nullable, and **absent / null means unlimited**.
 * `Tenant.limits` itself is nullable too, so a deployment that never sets a
 * limit is unconstrained, which is what every existing self-host install is.
 *
 * The object shape (rather than a bare number) is deliberate: new limits are
 * added as new optional keys, no migration and no breaking change for anyone
 * already storing a subset.
 *
 * Rekey attaches no pricing meaning to these numbers. They are a mechanism,
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

  /**
   * Custom template sends (`POST /api/v1/email/send`) per UTC day, across every
   * Application in the workspace. Unlike the limits above, absent or null does
   * NOT mean unlimited: it means the deployment default `EMAIL_SEND_DAILY_CAP`.
   */
  emailSendDailyCap: z.number().int().min(1).max(100_000_000).nullable().optional(),

  /**
   * Custom template sends to one recipient per hour, across the workspace.
   * Absent or null means `EMAIL_SEND_RECIPIENT_HOURLY_CAP`.
   */
  emailSendRecipientHourlyCap: z.number().int().min(1).max(1_000_000).nullable().optional(),

  /**
   * Not a ceiling: when true, the built-in account emails of every Application
   * in the workspace end with a small "Secured by Rekey" line. Customised
   * templates and workspace mail never carry it. Absent, null or false means
   * off, which is every self-host install.
   */
  emailAttribution: z.boolean().nullable().optional(),

  /**
   * Maximum contacts (people on any list, counted once per Application by
   * address) across every Application in the workspace. Only a subscribe that
   * would store a NEW contact is refused, with `CONTACT_QUOTA_EXCEEDED`;
   * existing contacts can still join or leave lists. Absent or null means
   * unlimited.
   */
  maxContacts: z.number().int().min(0).max(2_147_483_647).nullable().optional(),

  /**
   * Maximum lists that are not archived, across every Application in the
   * workspace. Creating or restoring one over the line fails with
   * `CONTACT_LIST_QUOTA_EXCEEDED`. Absent or null means unlimited.
   */
  maxContactLists: z.number().int().min(0).max(2_147_483_647).nullable().optional(),

  /**
   * Subscribes from browsers (a publishable key, or a secret key that names
   * the visitor with `X-Rekey-Client-Ip`) per UTC day, across the workspace.
   * Over it, the subscribe answers `429 CONTACTS_RATE_LIMITED` until the next
   * UTC day. Absent or null means unlimited.
   */
  contactCaptureDailyCap: z.number().int().min(1).max(100_000_000).nullable().optional(),
});
export type TenantLimits = z.infer<typeof TenantLimitsSchema>;

// ============================================================================
// Application config, the per-app settings stored in Application.authConfig
// and Application.billingConfig (Json columns).
// ============================================================================

/**
 * Auth methods this Application exposes. `password` and `magic_link` are
 * primary methods (the SDK calls them directly). OAuth provider presence is
 * implicit from `Application.oauthConfig` having that provider as a key,
 * not duplicated here. Open string to keep the enum from limiting future
 * additions.
 */
export const AuthMethodSchema = z.string().min(1).max(40);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/**
 * Signature algorithm for END-USER access tokens minted by this Application.
 *
 *   - `HS256` (default), per-app derived symmetric key. Only the Rekey API
 *     can verify; customers round-trip `auth.getCurrentUser()`.
 *   - `RS256`, asymmetric. Tokens carry a `kid` header and verify against the
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
   * Base URL of the CUSTOMER's own application, the origin transactional
   * emails link back to (`{{appUrl}}` in the welcome mail, and the base for
   * the reset / verify / magic-link URLs when the SDK caller doesn't supply
   * one explicitly).
   *
   * Optional on purpose, and there is no default: an unset value means "we
   * cannot build a link," and the templates then render NO call-to-action
   * button rather than a dead one. Never populate this with a placeholder
   * domain, a button pointing somewhere wrong is worse than no button.
   *
   * Lives in `authConfig` (a jsonb column) rather than `emailConfig` because
   * it is not about sending mail, and because the inference fallback reads
   * `redirectUrls`, its neighbour here. No migration needed.
   */
  appUrl: z.string().url().optional(),
  /**
   * Where to send the browser for the sign-in half of THIS Application acting
   * as an OpenID Connect provider (`/api/v1/mcp/:slug/oauth/authorize`).
   *
   * Unset, the API renders its own built-in sign-in + consent page, which
   * accepts an email and a password. That is the right default for a
   * deployment with no front end of its own, and the wrong one for an
   * Application whose users never set a password because they sign in with
   * Google or GitHub: they arrive at a form they cannot satisfy, and the only
   * way through is a password reset on an account that has no password.
   *
   * Set it, and the API redirects there with the authorization request
   * untouched, and the Application's own login page handles it. That page
   * already has whatever sign-in methods the Application offers, and already
   * knows whether this browser is signed in, so a user with a live session is
   * not asked to authenticate a second time. It is NOT excused from asking:
   * clients register themselves, so the page must show a consent screen
   * (`POST /api/v1/mcp/:slug/oauth/authorize/preview` says what to show and
   * mints nothing) and only after the user allows call
   * `POST /api/v1/mcp/:slug/oauth/authorize/grant` with its secret key and the
   * user's access token, then redirect the browser to the confirmed
   * `redirect_uri` with the returned code. See docs/auth.md.
   *
   * Trust: operator-configured, same as `redirectUrls`, and the API forwards
   * only the standard authorization parameters, which are already public. It
   * must not point back at the API's own authorize endpoint; the API refuses
   * to delegate to itself rather than bouncing the browser in a loop.
   */
  hostedAuthorizeUrl: z.string().url().optional(),
  /** If true, organisations / teams are enabled for this application. */
  organizationsEnabled: z.boolean().default(false),
  /**
   * **Legacy** sign-up switch, retained for back-compat. Derived from
   * `signupMode` after parse, do not set both at once. `false` ⇔
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
   *   - `public`     , anyone with the publishable OR secret key (default).
   *   - `secret_only`, only a server-side SECRET key may create users; the
   *                     publishable key is refused with
   *                     `SIGNUP_REQUIRES_SECRET_KEY`. Sign-IN with the
   *                     publishable key is unaffected.
   *   - `invite_only`, no public sign-up at all (either key kind is refused
   *                     with `SIGNUP_DISABLED`); operators invite end-users.
   *
   * Optional (not `.default`) on purpose: absence is what lets us derive the
   * mode from the legacy `signupEnabled` for apps written before this field
   * existed (`false` → `invite_only`, else `public`). The transform below
   * fills it in, so it is always present after parse.
   */
  signupMode: z.enum(['public', 'secret_only', 'invite_only']).optional(),
  /**
   * Which email domains may self sign-up. Checked after `signupMode`, on every
   * path that creates an end-user from a sign-up (password, a magic link for a
   * new address, a first OAuth sign-in), with 403
   * `SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED`. Operator-created and imported users are
   * not checked. See `SignupRestrictionsSchema`.
   */
  signupRestrictions: SignupRestrictionsSchema.optional(),
  /**
   * End-user two-factor (TOTP) policy for this Application:
   *   - `off`     , MFA endpoints are refused (`MFA_NOT_ENABLED`).
   *   - `optional`, end-users may enroll; enrolled users are challenged at
   *                  sign-in (the default, preserves prior behaviour).
   *   - `required`, sign-in returns `mfaEnrollmentRequired: true` for users
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
   * an OAuth-first sign-up carries the provider's own `email_verified` claim,
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
   * unconditionally. An OAuth sign-up instead records the PROVIDER's claim,
   * `emailVerified: identity.emailVerified`, which some providers do not
   * assert. Google and Discord do; generic OIDC and Microsoft consumer
   * accounts may not.
   *
   * So a first-time OAuth sign-up from a non-asserting provider creates the
   * account and is then refused a session by this gate, an account with no
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
   * When a new account gets the `welcome` mail. Password, magic-link and
   * OAuth-first sign-up only; operator-created and imported users never get
   * one. The per-event email switch still applies on top.
   *
   *   - `on_signup` (default): at creation, unless the account cannot sign in
   *     yet. With `requireEmailVerification` on, an unverified address waits
   *     for its first verification, since welcoming an account that is being
   *     refused a session greets an address nobody has proven.
   *   - `on_verified`: always waits until the address is verified, whether or
   *     not sessions are gated. An address verified at creation (magic link,
   *     a vouching OAuth provider) is welcomed straight away.
   *   - `off`: never sent. A welcome already held for verification is dropped.
   */
  welcomeEmail: z.enum(['on_signup', 'on_verified', 'off']).default('on_signup'),
  /**
   * If true, this Application exposes a hosted MCP (Model Context Protocol)
   * server at `/api/v1/mcp/<slug>`, fronted by a per-app OAuth 2.1
   * authorization server (dynamic client registration + authorization-code +
   * PKCE). End-users authenticate and connect MCP clients (Claude Code,
   * Claude Desktop, …) to access their own account data. Off by default,
   * while off, the MCP + OAuth endpoints 404.
   */
  mcpEnabled: z.boolean().default(false),
  /**
   * If true, this Application acts as an OpenID Connect **provider**. The
   * per-app authorization server that MCP already fronts additionally serves
   * `/.well-known/openid-configuration`, issues an `id_token` whenever the
   * `openid` scope is granted, and exposes `/oauth/userinfo`. Off by default,
   * while off the OIDC endpoints 404 AND `openid`/`profile`/`email` are not
   * grantable, so no ID Token can be minted for the Application at all.
   *
   * Deliberately independent of `mcpEnabled`. Either toggle alone mounts the
   * shared authorization endpoints (authorize / token / register / introspect);
   * each RESOURCE then gates itself, the MCP JSON-RPC endpoint needs
   * `mcpEnabled` plus the `mcp:account` scope, `/userinfo` needs `oidcEnabled`
   * plus `openid`. An operator who wants single-sign-on must not have to expose
   * an MCP tool server over their users' account data to get it.
   *
   * The `email` scope additionally requires `requireEmailVerification`. Without
   * it Rekey has no proof of the address and will not assert one to a relying
   * party, `scopes_supported` omits `email`, and so does `claims_supported`.
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
   * client-creation surface yet, a default of `false` would silently break
   * every deployment that already has MCP switched on and would leave a
   * freshly-enabled OpenID Provider with no way to onboard a relying party at
   * all. Turn it off once your relying parties are registered, which is the
   * posture a public IdP wants: open registration lets anyone stand up a rogue
   * client with an attacker-chosen `client_name` and get a password prompt
   * rendered on the operator's own issuer origin. (`client_name` is escaped and
   * the consent screen is accurate, so this is a phishing surface rather than a
   * credential-theft one, hence a control to harden with, not a default.)
   */
  dynamicClientRegistration: z.boolean().default(true),
  /**
   * Signature algorithm for end-user ACCESS tokens. `HS256` (default) keeps
   * today's per-app derived-secret behaviour. `RS256` signs new access tokens
   * with the deployment's active RSA key (kid in the JWT header) so they can
   * be verified offline against `GET /.well-known/jwks.json`. Switching alg
   * does not invalidate outstanding tokens, the API verifies both.
   */
  tokenAlg: TokenAlgSchema.default('HS256'),
  /**
   * Whether primary sign-in flows (password, OAuth, magic link, passkey,
   * MFA verify) must carry a `device` binding. `optional` (default) records a
   * device when the client sends one and changes nothing otherwise;
   * `required` refuses those flows without one (`DEVICE_FINGERPRINT_REQUIRED`).
   * Refresh is never gated by this: a session bound at sign-in stays bound.
   * See docs/devices.md.
   */
  deviceBinding: z.enum(['optional', 'required']).default('optional'),
  /**
   * Who may release a device to free its slot. `self_service` (default) lets
   * the signed-in end-user release their own from a browser or app
   * (`DELETE /users/me/devices/:id`). `server_only` refuses that call from a
   * publishable key (`DEVICE_SELF_RELEASE_DISABLED`), so a release goes
   * through the operator panel or the customer's own backend with a secret
   * key. Listing stays open to the end-user. Only meaningful with
   * `deviceBinding: 'required'`; otherwise a user can sign in unbound.
   * See docs/devices.md.
   */
  deviceRelease: z.enum(['self_service', 'server_only']).default('self_service'),
  /**
   * Who may erase an end user's account through `DELETE /users/me`.
   * `self_service` (default): the signed-in user from a browser (confirming
   * with a password or MFA code) or the customer's backend with a secret key.
   * `server_only`: a publishable key is refused (`ACCOUNT_SELF_DELETION_DISABLED`),
   * so the customer's backend decides and confirms in its own way. `off`: the
   * route is refused for every key; only an operator erasure removes an account.
   */
  accountDeletion: z.enum(['self_service', 'server_only', 'off']).default('self_service'),
  /**
   * WebAuthn / passkey configuration. Both fields are required when
   * `"passkey"` appears in `methods`, the registration ceremony needs
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
 * apps/api/.../billing/providers/registry.ts), not a compile-time enum here,
 * so adding a provider module never requires an SDK release, and a stale SDK
 * degrades to a capitalized name rather than a broken flow. Unknown names are
 * rejected server-side by the registry-derived enum.
 */
export const BillingProviderSchema = z.string().min(1);

/**
 * A country as the billing routes accept it: two characters, a letter first.
 * Wider than ISO 3166-1 alpha-2 on purpose, so a caller can forward its CDN's
 * country header unchanged; the API decides what is actually a country.
 */
const COUNTRY_INPUT = /^[A-Za-z][A-Za-z0-9]$/;
export type BillingProvider = z.infer<typeof BillingProviderSchema>;

export const BillingConfigSchema = z.object({
  /**
   * Master switch for this Application's billing. Default OFF for new apps,
   * the public billing API (checkout/subscriptions/coupons) returns 403
   * `BILLING_DISABLED` and the panel hides the Billing group until enabled.
   * Existing apps with billing already configured are grandfathered to `true`.
   */
  enabled: z.boolean().default(false),
  /**
   * Failed-payment recovery (dunning): reminder emails on day 0/3/7 and a
   * day-14 auto-cancel for subscriptions that go PAST_DUE. OFF by default, the
   * operator opts in per app. When false, no new dunning case is opened on a
   * payment failure; any case already OPEN keeps running to completion so an
   * in-flight recovery isn't stranded if dunning is later disabled.
   */
  dunningEnabled: z.boolean().default(false),
  provider: BillingProviderSchema,
  /**
   * Who a subscription bills + benefits by default: the individual end-user,
   * or their organization (shared credit pool / feature access for members).
   * `'org'` requires `authConfig.organizationsEnabled`. Default `'user'`.
   *
   * EXCLUSIVE, and not a per-call default (#431). An `'org'` Application
   * refuses a checkout with no organization, and a `'user'` one refuses a
   * checkout that names one. Checkout used to be able to override this per
   * call, which is what let a personal and an org-billed subscription to the
   * same plan exist at once, and `Subscription` is unique on
   * `(applicationId, endUserId, planId)` with no beneficiary in the key, so
   * those two are ONE ROW and the second silently replaced the first.
   *
   * Changing it is refused while subscriptions of the other subject are live,
   * since flipping would strand them. See ORG_BILLING.md.
   */
  billingSubject: z.enum(['user', 'org']).default('user'),
  /**
   * How many free trials one billing subject may take in this Application.
   *
   * `once_per_application` (the default) is the rule the limit exists for: a
   * buyer who trials `basic` and then trials `pro` has had two free months of
   * the product, which per-plan would allow. `once_per_plan` is the weaker
   * rule, offered because some catalogues sell genuinely unrelated products
   * from one Application. `unlimited` restores the pre-#477 behaviour and takes
   * no reservation at all; it is a deliberate choice, not a default.
   *
   * The subject is whatever the Application bills, per `billingSubject`: an
   * org-billed Application keys on the beneficiary organization, because keying
   * it on the individual would hand a five-person team five trials.
   *
   * A converted-then-churned customer does not get another trial. The trial is
   * an acquisition cost and they have already been acquired.
   */
  trialPolicy: z
    .enum(['once_per_application', 'once_per_plan', 'unlimited'])
    .default('once_per_application'),
  /**
   * Free-tier fallback. Slug of a plan in this Application whose FEATURE
   * entitlements and included USAGE quota apply on top of what a subject's
   * subscriptions grant. A SUBSCRIPTION or USAGE plan suppresses it entirely;
   * otherwise it applies to a subject with no subscription and to one holding
   * only stateful purchases (a credit pack, a licence).
   *
   * For a key a per-subscription `entitlementOverrides` names, the default is
   * WITHHELD, an override is authoritative. For every other key it takes part
   * in the merge but only upward: it can raise an INT or turn a BOOL true, and
   * it is applied first so a subscription's STRING wins. Its per-unit price
   * always floors the rate a subject is charged, so freemium works without a $0 checkout. Read-time only: no
   * Subscription row is created, and CREDIT/LICENSE grants are NOT minted from
   * it (those are stateful and require a real subscription). Unset = no free
   * tier (current behavior). See #36 / BILLING_MODEL.md.
   */
  defaultPlanSlug: z.string().optional(),
  /**
   * Which buyers a plan's local-currency price is offered to.
   *
   * `trusted` (the default) offers it only when the buyer's country was
   * declared by a secret key or vouched for by a trusted proxy. A cheaper
   * local price is worth lying for, and a country a browser states is a hint.
   * `any` also accepts a hint, which lets a buyer choose their price: for
   * operators who price for convenience, not purchasing power.
   */
  localPrices: z.enum(['trusted', 'any']).default('trusted'),
  /**
   * The currency this Application reports in: the headline on the Revenue
   * page and the MRR tile, the currency offered first for a new price or
   * coupon, and the currency of a plan with no flat price. ISO 4217. Nothing
   * is converted into it: totals in other currencies are listed beside it.
   * Set through `PUT /tenant/applications/:id/billing/reporting-currency`,
   * which holds it to the sellable set.
   */
  reportingCurrency: z.string().length(3).default('USD'),
  /**
   * What a checkout does when the server names a `currency` no provider it
   * can use is able to charge, for a request that does not say itself.
   *
   * `fallback` (the default) charges the plan's default price and logs it.
   * `refuse` answers `BILLING_NO_PROVIDER_FOR_CURRENCY` and charges nobody. A
   * request that sends its own `onUnavailableCurrency` wins over this.
   *
   * It decides nothing else. A local price selected by the buyer's country
   * always falls back, a subscriber is never moved off the currency they pay
   * in, and a default price nobody can charge is refused either way.
   */
  onUnavailableCurrency: z.enum(['fallback', 'refuse']).default('fallback'),
  /** Provider-specific config, Stripe account id, PayPal merchant id, etc. */
  metadata: z.record(z.unknown()).default({}),
});
export type BillingConfig = z.infer<typeof BillingConfigSchema>;

// ============================================================================
// Public DTOs, what the API actually returns over the wire.
// ============================================================================

/**
 * What an Application *is*. The Application is the isolation boundary in
 * Rekey, every domain row carries an `applicationId`, so "keep experiments
 * away from customers" means "use a second Application", and this field says
 * which of the two you are holding.
 *
 * It does NOT restrict which billing credentials the Application may hold,
 * live provider keys on a `DEVELOPMENT` Application are allowed, because
 * deliberately testing against a live processor is a real workflow and it is
 * your processor account. Environment is a label, the unit deployments are
 * billed and quota'd by, and what the API-key prefix is derived from.
 *
 * Set at creation and **immutable**, no endpoint changes it. To go live you
 * create a `PRODUCTION` Application rather than converting this one.
 */
export const AppEnvironmentSchema = z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']);
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

export const ApplicationDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  slug: z.string(),
  environment: AppEnvironmentSchema,
  /**
   * When this Application was PROMOTED into production, or null/absent.
   *
   * Null on a PRODUCTION Application means it was created production rather
   * than promoted into it. `environment` cannot distinguish the two, and only
   * one of them is an event with a date.
   */
  promotedAt: z.string().datetime().nullable(),
  /**
   * Set while the Application is frozen; null when it is running.
   *
   * A disabled Application refuses every end-user request with
   * `403 APPLICATION_DISABLED`, serves no hosted portal, and sends no mail or
   * webhooks. Nothing is deleted and no session is revoked, so re-enabling
   * restores it exactly. A disabled PRODUCTION Application also stops counting
   * against the workspace's `maxProductionApps`.
   */
  disabledAt: z.string().datetime().nullable(),
  /** The operator's own note recorded at the freeze, or null. Never shown to end-users. */
  disabledReason: z.string().nullable(),
  publicKey: z.string(),
  authConfig: AuthConfigSchema,
  billingConfig: BillingConfigSchema,
  /**
   * Where this Application's end-users should write for help, as the operator
   * set it with `PATCH .../email-sender`. Null when unset.
   */
  supportEmail: z.string().email().nullable(),
  /**
   * The IANA zone the daily analytics rollup counts days in (`UTC` by default). Set with
   * `PATCH .../settings`.
   */
  reportingTimezone: z.string(),
  /**
   * Only on `GET /api/v1/tenant/applications?include=summary` rows. Each
   * field is left out when the caller may not read it, so absent means
   * unknown, not zero.
   */
  summary: z
    .object({
      /** Keys that authenticate today: not revoked, not expired. Needs `developer:read`. */
      activeApiKeys: z.number().int().optional(),
      /**
       * The last UTC day an end-user was active, or a key was used when the
       * caller also holds `developer:read`. Null when neither happened.
       * Needs `overview:read`.
       */
      lastActiveOn: z.string().datetime().nullable().optional(),
    })
    .optional(),
  createdAt: z.string().datetime(),
});
export type ApplicationDto = z.infer<typeof ApplicationDtoSchema>;

export const EndUserDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  email: z.string().email(),
  emailVerified: z.boolean(),
  metadata: z.record(z.unknown()).nullable(),
  /** Set while an operator has banned this end-user; every sign-in is refused with END_USER_BANNED. */
  bannedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  /** When the user last signed in with a credential (refresh does not count). Null if never. */
  lastSignedInAt: z.string().datetime().nullable().optional(),
  /** How that sign-in happened: `password`, `magic_link`, `oauth`, `passkey` or `mfa`. */
  lastSignInVia: z.string().nullable().optional(),
  /** Credential sign-ins since the Application's `activityTrackedSince`. */
  signInCount: z.number().int().optional(),
  /** The last UTC day the user signed in or refreshed a session (midnight UTC). Null if never. */
  lastActiveOn: z.string().datetime().nullable().optional(),
  /** Platform of the latest sign-in (`web`, `ios`, `android`, `macos`, `windows`, `linux`, `server`, `mcp`, `other`). */
  lastPlatform: z.string().nullable().optional(),
  /** Every platform the user has signed in or been active from, first seen first. */
  platformsSeen: z.array(z.string()).optional(),
  /** ISO 3166 alpha-2 country of the latest browser sign-in, from `CF-IPCountry`. Null when unknown. */
  lastCountry: z.string().nullable().optional(),
  /** Answers to the Application's profile fields, keyed by field key. See docs/profile-fields.md. */
  profile: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** When onboarding was marked complete. Null until then. */
  onboardingCompletedAt: z.string().datetime().nullable().optional(),
  /** When the user skipped onboarding. Kept after a later completion. Null if never skipped. */
  onboardingSkippedAt: z.string().datetime().nullable().optional(),
  /**
   * `completed`, `skipped` or `pending`, derived from the two times above.
   * Recorded only: Rekey gates nothing on it. See docs/profile-fields.md.
   */
  onboardingStatus: z.enum(ONBOARDING_STATUSES).optional(),
  /**
   * How the account was created: `password`, `magic_link`, `oauth:<provider>`, `passkey`, `operator`,
   * `import` or `billing`. `unknown` for accounts created before this was recorded.
   */
  createdVia: z.string().optional(),
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

/**
 * API-key scopes the `*` wildcard grants. A key minted without a `scopes`
 * array gets `["*"]`, so this list is what a default key can do.
 */
export const STANDARD_API_KEY_SCOPES = [
  'auth:read',
  'auth:write',
  'billing:read',
  'billing:write',
  'webhooks:read',
  'contacts:write',
] as const;

/**
 * API-key scopes `*` does NOT grant: they must be named on the key.
 *
 * Every existing key defaults to `["*"]`, so adding an authority to the
 * wildcard would hand it to every key already deployed without anyone having
 * chosen to. An elevated scope is only ever held by a key an operator minted
 * with it deliberately.
 *
 * - `credits:grant`: add credits to an end-user or organization with
 *   `POST /api/v1/credits/grant`. It mints value, so it is not folded into
 *   `billing:write`, which every default key already holds.
 * - `email:send`: send a published custom template with
 *   `POST /api/v1/email/send`. It mails any address from the operator's own
 *   domain, so a key already deployed must not gain it without anyone choosing.
 * - `contacts:read`: read every member of a list with
 *   `GET /api/v1/lists/:key/members`. A bulk export of people who never signed
 *   up is the privacy risk of lists, so a default key cannot do it.
 */
export const ELEVATED_API_KEY_SCOPES = ['credits:grant', 'email:send', 'contacts:read'] as const;

export type StandardApiKeyScope = (typeof STANDARD_API_KEY_SCOPES)[number];
export type ElevatedApiKeyScope = (typeof ELEVATED_API_KEY_SCOPES)[number];

/** True for a scope that `*` does not grant. */
export function isElevatedApiKeyScope(scope: string): scope is ElevatedApiKeyScope {
  return (ELEVATED_API_KEY_SCOPES as ReadonlyArray<string>).includes(scope);
}

/**
 * Every scope an API key may be minted with: the `*` wildcard, the standard
 * scopes and the elevated ones. A mint naming anything else is refused with
 * `API_KEY_SCOPE_UNKNOWN`.
 */
export const API_KEY_SCOPES = ['*', ...STANDARD_API_KEY_SCOPES, ...ELEVATED_API_KEY_SCOPES] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** True for a scope an API key may be minted with. */
export function isApiKeyScope(scope: string): scope is ApiKeyScope {
  return (API_KEY_SCOPES as ReadonlyArray<string>).includes(scope);
}

// ============================================================================
// Auth requests + responses
// ============================================================================

/**
 * Body accepted by every session-minting endpoint (sign-in, sign-up,
 * mfa-verify, refresh, OAuth callback, magic-link verify, passkey complete) to
 * bind the resulting session to a device, see docs/devices.md. Optional
 * everywhere unless the Application sets `authConfig.deviceBinding =
 * 'required'`, in which case the primary sign-in flows refuse without it
 * (`DEVICE_FINGERPRINT_REQUIRED`). Browser SDKs never send it.
 */
export const DeviceBindingRequestSchema = z.object({
  /** Opaque, client-computed, stable across launches. 8–256 characters. */
  fingerprint: z.string().min(8).max(256),
  /** Human-readable hint shown in device lists ("Work laptop"). */
  label: z.string().min(1).max(120).optional(),
});
export type DeviceBindingRequest = z.infer<typeof DeviceBindingRequestSchema>;

export const SignUpRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  metadata: z.record(z.unknown()).optional(),
  /**
   * Secret key only. `true` says your server has already confirmed that this
   * person owns the address: the account is created verified and no
   * verification email is sent. A publishable key sending it is refused with
   * 403 `EMAIL_VERIFIED_REQUIRES_SECRET_KEY`.
   */
  emailVerified: z.boolean().optional(),
  device: DeviceBindingRequestSchema.optional(),
  /** What the client is, for the session list and platform stats. See `ClientHintSchema`. */
  client: ClientHintSchema.optional(),
});
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

export const SignInRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  device: DeviceBindingRequestSchema.optional(),
  /** What the client is, for the session list and platform stats. See `ClientHintSchema`. */
  client: ClientHintSchema.optional(),
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
  /**
   * The device this session is bound to (the access token's `dev` claim), or
   * null when the client sent no fingerprint.
   */
  deviceId: z.string().nullable(),
  /**
   * True when this request created the account: password sign-up, a magic
   * link or an OAuth callback that made a new user. False for every other
   * sign-in, MFA completion, refresh and organization switch. Route new users
   * to onboarding on it.
   */
  isNewUser: z.boolean(),
});
export type AuthResultDto = z.infer<typeof AuthResultDtoSchema>;

/**
 * The user passed the primary factor (password / OAuth) but has MFA
 * enrolled. The customer's server must prompt the user for their TOTP /
 * backup code and POST it to /auth/mfa-verify along with
 * `mfaChallengeToken` to receive a real session.
 *
 * The challenge token is short-lived (5 min) and bound to (endUser,
 * application). It is **not** a session token, it cannot be used at any
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
 * `callback`, and any future flow that accepts a primary factor, the
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
  device: DeviceBindingRequestSchema.optional(),
  /** What the client is, for the session list and platform stats. See `ClientHintSchema`. */
  client: ClientHintSchema.optional(),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequestSchema>;

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512),
  /**
   * The device presenting the token. When the session is already bound to a
   * device, a different fingerprint is refused (`REFRESH_TOKEN_DEVICE_MISMATCH`)
   * and the chain revoked; when it is not yet bound, this binds it.
   */
  device: DeviceBindingRequestSchema.optional(),
});
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const ForgotPasswordRequestSchema = z.object({
  email: z.string().email().max(254),
  /**
   * Optional URL for the reset link in the email. `{token}` will be
   * URL-encoded and substituted by the server. Required only if you've
   * configured email transport, otherwise the server returns the raw
   * token in the response for you to forward.
   */
  resetUrl: z.string().max(2048).optional(),
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ForgotPasswordResultDtoSchema = z.object({
  /** True iff a real user existed and a token was minted. False is also returned when the email is unknown, never enumerate. */
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
/** The plan kinds this SDK version knows about. Closed, use it for registries. */
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
/** The statuses this SDK version knows about. Closed, use it for registries. */
export type KnownSubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;
/** {@link Open}. `TRIALING` is the obvious next one; handle the default branch. */
export type SubscriptionStatusType = Open<KnownSubscriptionStatus>;

/**
 * One provider's reason for refusing a plan, shaped like an error because it
 * is one: the same code, message and fix the buyer's checkout would raise,
 * delivered to the operator before any buyer sees it.
 *
 * `provider` is null when the blocker belongs to no single provider, which
 * today means the Application has no billing provider configured at all.
 */
export const PlanCheckoutBlockerSchema = z.object({
  provider: z.string().nullable().describe('The provider that refuses the plan. Null when the blocker belongs to no single provider.'),
  code: z.string().describe('The error code a buyer\'s checkout would raise.'),
  message: z.string().describe('What is wrong, for a person.'),
  fix: z.string().describe('How to repair it.'),
});
export type PlanCheckoutBlockerDto = z.infer<typeof PlanCheckoutBlockerSchema>;

/**
 * Per provider, because the failure is per provider. Checkout geo-routes, so a
 * plan can be buyable through PayPal and dead through Stripe, and only the
 * buyers the router sends to Stripe lose. One boolean would report that plan
 * as working to whoever happened to test from the lucky country.
 */
export const PlanCheckoutReadinessSchema = z.object({
  ready: z.boolean().describe('Whether every provider a buyer could be routed to would open a checkout for this plan.'),
  blockers: z.array(PlanCheckoutBlockerSchema).describe('One entry per provider that refuses the plan. Empty when `ready` is true.'),
});
export type PlanCheckoutReadinessDto = z.infer<typeof PlanCheckoutReadinessSchema>;

export const PlanRegistrationStatusSchema = z.enum(['NOT_REQUIRED', 'PENDING', 'REGISTERED', 'FAILED']);

/**
 * Whether a payment provider holds this price. `error` is the provider's own
 * refusal when `status` is FAILED.
 */
export const PlanPriceRegistrationSchema = z.object({
  status: PlanRegistrationStatusSchema.describe('Where the price stands at the payment provider.'),
  error: z.string().nullable().describe('The provider\'s own refusal when `status` is FAILED, otherwise null.'),
});
export type PlanPriceRegistrationDto = z.infer<typeof PlanPriceRegistrationSchema>;

/**
 * One price of a plan as the public catalogue shows it: the default price or
 * a price in another currency. `countries` is where a non-default price
 * applies; empty means wherever that currency is the local one.
 */
export const PublicPlanPriceDtoSchema = z.object({
  id: z.string(),
  /** Upper-case ISO 4217. */
  currency: z.string().describe('Upper-case ISO 4217.'),
  /** Amount in the smallest unit of `currency`. Always integer. */
  amount: z.number().int().describe('Amount in the smallest unit of `currency`. Always integer.'),
  /** Upper-case ISO 3166-1 alpha-2. */
  countries: z.array(z.string()).describe('Upper-case ISO 3166-1 alpha-2.'),
  /** The price a buyer pays when no other price applies. Exactly one per priced plan. */
  isDefault: z.boolean().describe('The price a buyer pays when no other price applies. Exactly one per priced plan.'),
  /** A plan lists only the prices it sells at. */
  archived: z.literal(false).describe('A plan lists only the prices it sells at.'),
});
export type PublicPlanPriceDto = z.infer<typeof PublicPlanPriceDtoSchema>;

/**
 * One price of a plan as its operator reads it, with where it stands at the
 * payment provider, whether its amount may still change, and who is on it.
 * All of that is the operator's to know, so the public catalogue carries
 * {@link PublicPlanPriceDtoSchema} instead.
 */
export const PlanPriceDtoSchema = PublicPlanPriceDtoSchema.extend({
  registration: PlanPriceRegistrationSchema.describe('Whether a payment provider holds this price.'),
  /**
   * Whether `amount` can still be changed. False once a payment provider
   * holds the price or is registering it: the route that changes the amount
   * refuses by the same rule. `countries` can change either way.
   */
  amountEditable: z.boolean().describe('Whether `amount` can still be changed. False once a payment provider holds the price or is registering it (`PLAN_PRICE_IMMUTABLE`), or a live subscription, an open checkout, an ended subscription, a payment or a credit grant names it (`PLAN_PRICE_REFERENCED`): the route that changes the amount refuses by the same rule. `countries` can change either way.'),
  /** How many subscriptions that have not ended are on this price. */
  liveSubscriptions: z.number().int().describe('How many subscriptions that have not ended (not CANCELED or EXPIRED) are on this price. A count, not money. A price with any cannot be removed (`PLAN_PRICE_IN_USE`).'),
  /** How many checkouts are open on this price. */
  openCheckouts: z.number().int().describe('How many checkouts are open on this price: being confirmed, or opened and not yet expired. A count, not money. A price with any cannot be removed (`PLAN_PRICE_IN_USE`).'),
});
export type PlanPriceDto = z.infer<typeof PlanPriceDtoSchema>;

/**
 * Why a price was selected:
 *
 * - `bound`: the buyer already pays in this currency.
 * - `requested`: the operator's server named the currency.
 * - `country`: it is the price for the buyer's country.
 * - `default`: nothing else applied.
 * - `fallback`: another price was selected and no provider can charge it.
 */
export const PRICE_REASONS = ['bound', 'requested', 'country', 'default', 'fallback'] as const;
export const PriceReasonSchema = z.enum(PRICE_REASONS);
export type PriceReason = z.infer<typeof PriceReasonSchema>;

/**
 * The price one buyer would be charged for a plan, resolved by the function
 * checkout uses. A pricing page renders `formatted` and needs no logic.
 */
export const ResolvedPriceDtoSchema = z.object({
  /** The `prices[].id` selected. */
  id: z.string(),
  currency: z.string().describe('Upper-case ISO 4217.'),
  amount: z.number().int().describe('Integer, in the minor unit of `currency` (cents for USD, whole yen for JPY).'),
  /** `amount` written for a person, such as "$19.00" or "₹1,499.00". */
  formatted: z.string().describe('`amount` written for a person, such as "$19.00" or "₹1,499.00".'),
  isDefault: z.boolean().describe('Whether this is the plan\'s default price.'),
  reason: PriceReasonSchema.describe('Why this price was selected: `bound` (the buyer already pays in this currency), `requested` (the operator\'s server named the currency), `country` (it is the price for the buyer\'s country), `default` (nothing else applied), or `fallback` (another price was selected and no provider can charge it).'),
  /**
   * When `reason` is `fallback`: the currency selected for the buyer, which no
   * enabled provider can charge. Null for every other reason.
   */
  requestedCurrency: z
    .string()
    .nullable()
    .describe('When `reason` is `fallback`: the currency selected for the buyer, upper-case ISO 4217, which no enabled provider can charge. Null for every other reason.'),
});
export type ResolvedPriceDto = z.infer<typeof ResolvedPriceDtoSchema>;

/** One side of a price fallback: a price row and what it charges. */
export const FallbackPriceDtoSchema = z.object({
  /** The `prices[].id`. */
  id: z.string(),
  currency: z.string().describe('Upper-case ISO 4217.'),
  amount: z.number().int().describe('Integer, in the minor unit of `currency`.'),
  formatted: z.string().describe('`amount` written for a person, such as "$19.00".'),
});

/**
 * A checkout that charges the plan's default price because no provider could
 * charge the price selected for the buyer.
 */
export const PriceFallbackDtoSchema = z.object({
  requested: FallbackPriceDtoSchema.describe('The price selected for the buyer, which no enabled provider can charge.'),
  charged: FallbackPriceDtoSchema.describe('The plan\'s default price, which the checkout charges instead.'),
  reason: z.enum(['no_provider_for_currency']).describe('Why the selected price was not charged.'),
});
export type PriceFallbackDto = z.infer<typeof PriceFallbackDtoSchema>;

/** What any reader of a plan gets: what it is and what it sells, with nothing about how it is configured. */
const planCommonShape = {
  id: z.string(),
  slug: z.string().describe('The plan\'s stable name within the Application, used in checkout requests.'),
  name: z.string().describe('Display name.'),
  /** What this plan sells. */
  kind: PlanKindSchema.describe('What this plan sells.'),
  interval: PlanIntervalSchema.describe('How often a SUBSCRIPTION plan bills.'),
  /** Whether the plan charges nothing at all. A metered plan with no base fee is not free. */
  isFree: z.boolean().describe('Whether the plan charges nothing at all. A metered plan with no base fee is not free.'),
  /** Free trial length in days, or null for none. */
  trialDays: z.number().int().nullable().describe('Free trial length in days, or null for none.'),
  // LICENSE-kind config (null for non-LICENSE plans)
  licenseKind: LicenseKindSchema.nullable().describe('LICENSE-kind config (null for non-LICENSE plans)'),
  licenseSeatsAllowed: z.number().int().nullable().describe('For SEATS licenses: how many seats a key carries. Null otherwise.'),
  /** For TIMED licenses: key lifetime in days from purchase. */
  licenseDurationDays: z.number().int().nullable().describe('For TIMED licenses: key lifetime in days from purchase.'),
  /** Slug of the usage meter a USAGE plan bills against. */
  meterSlug: z.string().nullable().describe('Slug of the usage meter a USAGE plan bills against.'),
  /** Credits granted to the buyer on successful payment of a CREDIT-kind plan. */
  creditsAmount: z.number().int().nullable().describe('Credits granted to the buyer on successful payment of a CREDIT-kind plan.'),
  /**
   * The price this caller's buyer would be charged, or null for a plan with
   * no flat price. Resolved by the function checkout uses, from the buyer's
   * country (`?country=`), the currency they already pay in when the request
   * carries their token, and what the providers can charge.
   */
  price: ResolvedPriceDtoSchema.nullable().describe('The price this caller\'s buyer would be charged, or null for a plan with no flat price. Resolved by the function checkout uses, from the buyer\'s country (`?country=`), the currency they already pay in when the request carries their token, and what the providers can charge.'),
};

export const PlanLocalPricesSchema = z.enum(['INHERIT', 'TRUSTED', 'OFF']);

/** A plan as its operator reads it. */
export const PlanDtoSchema = z.object({
  ...planCommonShape,
  applicationId: z.string().describe('The Application the plan belongs to.'),
  /**
   * Every price the plan sells at: the default price first, then the others
   * sorted by currency. Empty for a plan with no flat price. Checkout picks
   * between them by the buyer's country; see `localPrices` on the billing config.
   */
  prices: z.array(PlanPriceDtoSchema).describe('Every price the plan sells at: the default price first, then the others sorted by currency. Empty for a plan with no flat price. Checkout picks between them by the buyer\'s country; see `localPrices` on the billing config.'),
  /** The `prices[].id` of the default price, or null for a plan with no flat price. */
  defaultPriceId: z.string().nullable().describe('The `prices[].id` of the default price, or null for a plan with no flat price.'),
  /**
   * Whether a buyer's country may select one of this plan's other prices:
   * `INHERIT` follows the Application's `localPrices`, `TRUSTED` needs a
   * country a server declared or a CDN vouched for, `OFF` never does.
   */
  localPrices: PlanLocalPricesSchema.describe('Whether a buyer\'s country may select one of this plan\'s other prices: `INHERIT` follows the Application\'s `localPrices`, `TRUSTED` needs a country a server declared or a CDN vouched for, `OFF` never does.'),
  active: z.boolean().describe('Whether the operator offers the plan. `checkout` says whether the providers will honour it.'),
  /** Where the plan stands at the provider that registers plans when they are created. */
  registrationStatus: PlanRegistrationStatusSchema.describe('Where the plan stands at the provider that registers plans when they are created.'),
  /** The provider's own refusal when `registrationStatus` is FAILED. */
  registrationError: z.string().nullable().describe('The provider\'s own refusal when `registrationStatus` is FAILED.'),
  metadata: z.record(z.unknown()).describe('Operator and provider data kept on the plan.'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /**
   * Whether a buyer sent to checkout for this plan would actually get a
   * checkout, and if not, which provider refuses and how to repair it.
   * Present on the routes that list plans; the routes that return one plan
   * after a write leave it out.
   *
   * `active` says what the operator INTENDED; this says what the providers
   * will honour, and the two disagree in one common case: a plan created
   * before the Application had provider credentials was never registered, has
   * no price behind it, and stays that way because configuring a provider
   * does not reach back and fix plans that already exist.
   */
  checkout: PlanCheckoutReadinessSchema.optional().describe('Whether a buyer sent to checkout for this plan would actually get a checkout, and if not, which provider refuses and how to repair it. Present on the routes that list plans; the routes that return one plan after a write leave it out. `active` says what the operator INTENDED; this says what the providers will honour, and the two disagree in one common case: a plan created before the Application had provider credentials was never registered, has no price behind it, and stays that way because configuring a provider does not reach back and fix plans that already exist.'),
});
export type PlanDto = Omit<z.infer<typeof PlanDtoSchema>, 'kind'> & {
  /** {@link Open}, always give your `switch` a default branch. */
  kind: PlanKindType;
};

/**
 * The public catalogue's readiness signal: whether a buyer sent to checkout
 * for this plan would get one from every provider they could be routed to.
 * Only the boolean: which provider refuses and why is operator configuration.
 * A pricing page can hide a plan whose `ready` is false. It describes
 * checkout only, so a free default plan granted without checkout can read
 * false while still applying to every signed-in user.
 */
export const PublicPlanCheckoutSchema = z.object({
  ready: z.boolean().describe('False when a buyer sent to checkout for this plan would be refused.'),
});
export type PublicPlanCheckoutDto = z.infer<typeof PublicPlanCheckoutSchema>;

/**
 * A plan as `GET /billing/plans` returns it to a publishable key or a buyer:
 * what a pricing page shows. It carries no operator configuration: no
 * provider ids, no registration state, no `metadata`.
 */
export const PublicPlanDtoSchema = z
  .object({
    ...planCommonShape,
    prices: z.array(PublicPlanPriceDtoSchema).describe('Every price the plan sells at, the default price first. Empty for a plan with no flat price.'),
    checkout: PublicPlanCheckoutSchema.describe('Whether a buyer sent to checkout for this plan would get one.'),
  })
  .strict();
export type PublicPlanDto = Omit<z.infer<typeof PublicPlanDtoSchema>, 'kind'> & {
  /** {@link Open}, always give your `switch` a default branch. */
  kind: PlanKindType;
};

/**
 * One feature's value for a subject (`GET /billing/entitlements/features/:key`).
 *
 * `value` is what `features[key]` holds in the full entitlements response, or
 * null when nothing grants the key. `granted` is `Boolean(value)`, the same
 * test as `if (features[key])`: a `false` flag, a `0` limit and an absent key
 * all read as not granted. Compare `value` yourself for a numeric limit.
 */
export const FeatureCheckDtoSchema = z.object({
  key: z.string(),
  granted: z.boolean(),
  value: z.union([z.boolean(), z.number(), z.string()]).nullable(),
});
export type FeatureCheckDto = z.infer<typeof FeatureCheckDtoSchema>;

// ── Credits (prepaid balance / lead-pack drawdown) ──
export const CreditReasonSchema = z.enum(['PURCHASE', 'GRANT', 'CONSUME', 'REFUND', 'ADJUST']);
/** The ledger reasons this SDK version knows about. Closed, use it for registries. */
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
  /** {@link Open}, always give your `switch` a default branch. */
  reason: CreditReasonType;
};

/** Body for POST /api/v1/credits/consume (end-user drawdown). */
export const ConsumeCreditsRequestSchema = z.object({
  /** How many credits to deduct. Must be a positive integer. */
  amount: z.number().int().positive(),
  /**
   * Optional idempotency key (e.g. the lead id). A repeated consume with the
   * same key is a no-op that returns the original result, safe to retry.
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

/**
 * Largest grant one `POST /api/v1/credits/grant` call may make.
 *
 * A bound on a single call, not a budget. The route exists for a referral
 * payout or a support top-up, and a key that can mint any int4 in one request
 * turns one bad deploy into an unbounded liability. Larger amounts are an
 * operator grant from the panel.
 */
export const MAX_KEY_CREDIT_GRANT = 1_000_000;

/**
 * Body for `POST /api/v1/credits/grant`, the Application-key grant.
 *
 * Narrower than the operator's {@link GrantCreditsRequestSchema} on purpose:
 * positive amounts only (a key never removes credits; `consume` does that and
 * refuses to overdraw), a per-call ceiling, and a REQUIRED idempotency key so a
 * retried request can never mint twice.
 */
export const KeyGrantCreditsRequestSchema = z.object({
  /** Exactly one of `endUserId` / `organizationId`. */
  endUserId: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  amount: z.number().int().min(1).max(MAX_KEY_CREDIT_GRANT),
  reason: z.enum(['GRANT', 'REFUND']).default('GRANT'),
  /** Required. A repeat with the same key (per subject) grants nothing and returns the original entry. */
  idempotencyKey: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type KeyGrantCreditsRequest = z.input<typeof KeyGrantCreditsRequestSchema>;

/**
 * One entry of the signed-in end-user's own credit ledger
 * (`GET /api/v1/credits/me/ledger`).
 *
 * {@link CreditLedgerEntryDtoSchema} without `metadata`. The route is reachable
 * from a browser with the publishable key, and ledger metadata is written by
 * the operator and the Application's backend for their own use (support notes,
 * internal references). The description is the line a person should read.
 */
export const SelfCreditLedgerEntryDtoSchema = CreditLedgerEntryDtoSchema.omit({ metadata: true });
export type SelfCreditLedgerEntryDto = Omit<CreditLedgerEntryDto, 'metadata'>;

/**
 * `data` of the `credit.granted`, `credit.consumed` and `credit.adjusted`
 * webhooks: one ledger entry, as written, with the balance it left behind.
 *
 * `delta` is signed and `balance` is the subject's balance after this entry,
 * so a mirror can apply every credit event the same way, whichever of the
 * three names it arrived under.
 */
export interface CreditWebhookData {
  credit: {
    /** The ledger entry id. Stable, and unique per entry. */
    entryId: string;
    /** Exactly one of `endUserId` / `organizationId` is set. */
    endUserId: string | null;
    organizationId: string | null;
    /** Signed change: positive added, negative removed. */
    delta: number;
    /** `Math.abs(delta)`. */
    amount: number;
    reason: CreditReasonType;
    /** Balance of the subject immediately after this entry. */
    balance: number;
    idempotencyKey: string | null;
    description: string | null;
    createdAt: string;
  };
}

/**
 * What a billing provider module can do, as declared by its registry entry.
 * Served by `GET /api/v1/billing/providers` (P4 discovery) so front-ends can
 * adapt (e.g. no auto-webhook button for Razorpay) without name checks.
 */
export const BillingProviderCapabilitiesSchema = z.object({
  /**
   * Whether buyers can be sent to this provider to pay. `false` marks an
   * inbound-only provider, one that only receives events from the operator's
   * own billing system.
   */
  checkout: z.boolean(),
  oneTime: z.boolean(),
  captureStep: z.boolean(),
  autoWebhookRegister: z.boolean(),
  periodRotationEvents: z.boolean(),
  onlineVerify: z.boolean(),
  /**
   * Whether an ad-hoc coupon discount can be applied, per flow. A provider
   * module that declares nothing leaves it out, and absent means
   * "cannot", never "unknown, try it": a checkout that sends a coupon to a
   * provider that drops it charges the buyer full price. Use it to hide the
   * coupon field when the only provider on offer cannot honour one.
   */
  discounts: z.object({ oneTime: z.boolean(), recurring: z.boolean() }).optional(),
});
export type BillingProviderCapabilities = z.infer<typeof BillingProviderCapabilitiesSchema>;

export const SubscriptionDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  endUserId: z.string(),
  planId: z.string(),
  status: SubscriptionStatusSchema,
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAt: z.string().datetime().nullable(),
  canceledAt: z.string().datetime().nullable(),
  /**
   * Which payment processor holds this subscription, or null for one Rekey
   * provisioned itself (a hand-granted plan, an import, a Cloud subscription
   * set up by an operator).
   *
   * This shipped as `providerSubId` alone, which is an id belonging to nobody:
   * a consumer could see `sub_1A2B3C` and had no way to know whether that was
   * Stripe's, PayPal's or Razorpay's. Every question worth asking about a live
   * subscription needs the name. Which "Manage billing" link to render. Which
   * logo to put next to it. Whether a support ticket goes to the Stripe
   * dashboard or the PayPal one.
   *
   * It also fixes a rule that the new provider picker makes easy to break: a
   * subscription cannot move between processors. A buyer already paying
   * through PayPal who is offered a Stripe checkout for an upgrade gets a
   * SECOND subscription, not a changed one, and is billed twice. Reading this
   * field is how a pricing page avoids offering that choice.
   *
   * Open string, not an enum, for the same reason as `BillingProviderSchema`:
   * the authoritative set is the API's runtime module registry, so a new
   * provider must not require an SDK release.
   */
  provider: z.string().nullable(),
  /**
   * What the provider holding this subscription can do, from the API's module
   * registry, so a front-end can ask instead of matching on `provider`. The
   * question it exists for: `checkout: false` marks an inbound-only provider,
   * where the money is managed in the operator's own system and a cancel
   * through Rekey is refused, so a portal should not offer one.
   *
   * Null when `provider` is null or unknown to this server. Served by
   * `GET /billing/subscription`; the other routes that return a subscription
   * leave it out.
   */
  providerCapabilities: BillingProviderCapabilitiesSchema.nullable().optional(),
  providerSubId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SubscriptionDto = Omit<z.infer<typeof SubscriptionDtoSchema>, 'status'> & {
  /** {@link Open}, always give your `switch` a default branch. */
  status: SubscriptionStatusType;
};

/**
 * The keys of a subscription's `metadata` its holder may see. Both are written
 * by Rekey at checkout and describe the buyer's own purchase.
 */
export const SelfSubscriptionMetadataSchema = z.object({
  /** The provider's id for the checkout (or PayPal subscription) that created this row. */
  checkoutSessionId: z.string().optional(),
  /** True for a one-off purchase rather than a recurring subscription. */
  oneTime: z.boolean().optional(),
});
export type SelfSubscriptionMetadata = z.infer<typeof SelfSubscriptionMetadataSchema>;

/**
 * A subscription as its holder sees it: every end-user billing route
 * (`GET /billing/subscription`, `GET /billing/subscriptions`, cancel, subscribe,
 * checkout and `include=subscription`).
 *
 * {@link SubscriptionDtoSchema} with `metadata` cut down to
 * {@link SelfSubscriptionMetadataSchema}. Those routes are reachable from a
 * browser with the publishable key, and the rest of a subscription's metadata
 * is what the operator and the providers wrote for themselves: a grant's
 * private note, retired checkout sessions, the provider the row moved from.
 * The secret-key operator routes still return all of it.
 */
export const SelfSubscriptionDtoSchema = SubscriptionDtoSchema.extend({
  metadata: SelfSubscriptionMetadataSchema,
  /** The organization this subscription is for, or null for the buyer's own. */
  beneficiaryOrgId: z.string().nullable(),
  /** When a TRIALING subscription's free trial ends; null when there is none. */
  trialEndsAt: z.string().datetime().nullable(),
  /**
   * What this subscriber pays each period: the price their checkout, grant or
   * import fixed, which can differ from the plan's default price. Render
   * `formatted`. Null for a subscription to a plan with no flat price, and
   * for a checkout that has not been paid yet.
   */
  price: FallbackPriceDtoSchema.nullable(),
});
export type SelfSubscriptionDto = Omit<SubscriptionDto, 'metadata'> & {
  metadata: SelfSubscriptionMetadata;
  beneficiaryOrgId: string | null;
  trialEndsAt: string | null;
  price: z.infer<typeof FallbackPriceDtoSchema> | null;
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
 * What would cancelling this subscription RIGHT NOW do, leave them the rest
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
 * are about to get, promising "you keep access until <date>" to someone who
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
 * cancelled outright however politely you asked, which is what Rekey Cloud,
 * selling with checkout closed, did to every buyer who cancelled. A provider
 * decides who TERMINATES the subscription when the date arrives (its webhook,
 * versus the API expiring the row locally), not when the paid time ends.
 *
 * ## Why this lives in shared-types
 *
 * It is one rule with two readers, the server that applies it and the UI that
 * has to describe it before the call is made, and the UI cannot derive it
 * from the response, because it has to speak first. Written out twice, it
 * drifted apart within a day of being written: the API stopped requiring a
 * provider and marketing's copy went on warning buyers about an immediate
 * cancellation that no longer happened. One implementation, imported by both.
 *
 * Known third site, deliberately NOT unified: `cancelSubscriptionById` (the
 * operator/MCP cancel-by-id path) still requires a provider. Relaxing it there
 * would leave provider-less rows scheduled with nothing to expire them,
 * `expireIfDue` only runs from `getCurrentSubscription`, which an operator
 * action does not go through. That needs the expiry seam widened first.
 */
/**
 * Why a subscriber cancelled, as they may say on `POST /billing/subscription/cancel`.
 * The same set Stripe's cancellation details use, so a cancel survey maps one to one.
 */
export const CANCEL_REASONS = [
  'too_expensive',
  'missing_features',
  'switched_service',
  'unused',
  'too_complex',
  'low_quality',
  'customer_service',
  'other',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** At most this many characters of free-text feedback are kept with a cancellation. */
export const CANCEL_FEEDBACK_MAX = 1000;

export function cancelEffect(sub: CancellationTimingInput): 'period-end' | 'immediate' {
  // ACTIVE or TRIALING, deliberately NOT the full entitling set. PAST_DUE
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
 * deployables, the API, the marketing site, the billing worker and the
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
 * period, so it is true only after somebody has cancelled.
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
  /**
   * ISO 3166-1 alpha-2. Used by the geo router when `provider` is absent, and
   * to pick between a plan's prices when it has more than one currency.
   */
  country: z.string().regex(COUNTRY_INPUT).optional(),
  /**
   * Secret key only. Charge the plan's price in this ISO 4217 currency
   * instead of the one the buyer's country selects. The plan must have a
   * price in it. A publishable-key request that sends it is refused with
   * `BILLING_CURRENCY_NOT_ALLOWED`.
   */
  currency: z.string().length(3).optional(),
  /**
   * What to do when no provider can charge `currency`. `fallback`, the
   * default, charges the plan's default price instead and says so in
   * `priceFallback`. `refuse` answers `BILLING_NO_PROVIDER_FOR_CURRENCY`.
   */
  onUnavailableCurrency: z.enum(['fallback', 'refuse']).optional(),
  /**
   * Buy on behalf of an organization (owner+beneficiary). The caller must be
   * an OWNER/ADMIN of it; benefits flow to the org (shared pool / member
   * feature access) while the caller remains the owner/payer. Omit to bill the
   * individual end-user.
   */
  organizationId: z.string().min(1).optional(),
  /**
   * Proceed at full price for a buyer who has already used their free trial.
   *
   * The documented escape hatch from the `409 BILLING_TRIAL_ALREADY_USED`
   * refusal. It is a per-request acknowledgement from the call site that
   * rendered the price, not a setting: send it only after the buyer has been
   * told they are paying today, and send it with a NEW `Idempotency-Key` or the
   * retry answers `IDEMPOTENCY_KEY_REUSED` forever.
   *
   * Never send it blindly in response to the 409. Read
   * `GET /billing/trial-eligibility` and show the paid price first; a buyer who
   * merely abandoned a trial checkout still reads `eligible: true`, and
   * acknowledging on their behalf charges them today for the trial the next
   * checkout was about to grant.
   */
  allowWithoutTrial: z.boolean().optional(),
  /**
   * `redirect` sends this checkout to the provider's own page even when the
   * Application has the Rekey checkout page switched on. `embedded` asks for
   * the Rekey page, which is served only when the Application has it switched
   * on for this checkout's payment mode and every readiness check passes.
   * Omit to follow the Application's setting.
   */
  mode: z.enum(['redirect', 'embedded']).optional(),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequestSchema>;

export const CreateCheckoutRequestWithCouponSchema = CreateCheckoutRequestSchema.extend({
  couponCode: z.string().min(1).max(40).optional(),
});

/**
 * A checkout that went through but will be refused by a later release.
 *
 * `CHECKOUT_RETURN_URL_UNREGISTERED`: `successUrl` or `cancelUrl` points at an
 * origin the Application has not registered (its App URL, its redirect URLs,
 * or its hosted portal). The buyer is still sent there today; the next minor
 * release refuses the checkout instead.
 *
 * @example
 * { code: 'CHECKOUT_RETURN_URL_UNREGISTERED', field: 'successUrl',
 *   origin: 'https://shop.example', message: '…', fix: '…' }
 */
export const CheckoutReturnUrlWarningSchema = z.object({
  code: z.literal('CHECKOUT_RETURN_URL_UNREGISTERED').describe('Always `CHECKOUT_RETURN_URL_UNREGISTERED`.'),
  field: z.enum(['successUrl', 'cancelUrl']).describe('Which URL points at an unregistered origin.'),
  origin: z.string().describe('The origin that is not registered on the Application.'),
  message: z.string().describe('What is wrong, for a person.'),
  fix: z.string().describe('How to repair it.'),
});
export type CheckoutReturnUrlWarning = z.infer<typeof CheckoutReturnUrlWarningSchema>;

/**
 * `CHECKOUT_EMBEDDED_FELL_BACK`: the Application has the Rekey checkout page
 * switched on, a readiness check failed for this checkout, and the failure
 * behaviour is "fall back", so `url` is the provider's own page. `check` names
 * the failed check and `fix` is that check's repair.
 */
export const CheckoutFellBackWarningSchema = z.object({
  code: z.literal('CHECKOUT_EMBEDDED_FELL_BACK').describe('Always `CHECKOUT_EMBEDDED_FELL_BACK`.'),
  check: z.string().describe('The readiness check that failed.'),
  message: z.string().describe('What is wrong, for a person.'),
  fix: z.string().describe('How to repair that check.'),
});
export type CheckoutFellBackWarning = z.infer<typeof CheckoutFellBackWarningSchema>;

export const CheckoutWarningSchema = z.discriminatedUnion('code', [
  CheckoutReturnUrlWarningSchema,
  CheckoutFellBackWarningSchema,
]);
export type CheckoutWarning = z.infer<typeof CheckoutWarningSchema>;

export const CheckoutResultDtoSchema = z.object({
  url: z.string().url().describe('Where to send the buyer to pay.'),
  subscription: SelfSubscriptionDtoSchema.describe('The PENDING subscription this checkout opened. It activates when the provider confirms payment.'),
  /** Discount applied (smallest currency unit). 0 if no coupon. */
  discountAmount: z.number().int().min(0).describe('Discount applied (smallest currency unit). 0 if no coupon.'),
  /**
   * The currency this checkout charges, upper-case ISO 4217. A plan can be
   * priced in more than one, so this is the one selected for this buyer.
   */
  currency: z.string().describe('The currency this checkout charges, upper-case ISO 4217. A plan can be priced in more than one, so this is the one selected for this buyer.'),
  /** The plan price charged, before any discount, in the smallest unit of `currency`. */
  unitAmount: z.number().int().min(0).describe('The plan price charged, before any discount, in the smallest unit of `currency`.'),
  /** The price this checkout charges and why it was selected. Null for a plan with no flat price. */
  price: ResolvedPriceDtoSchema.nullable().describe('The price this checkout charges and why it was selected. Null for a plan with no flat price.'),
  /**
   * Set when the price selected for this buyer could not be charged and the
   * checkout charges the plan's default price instead. Tell the buyer before
   * they pay. Null when the price selected is the price charged.
   */
  priceFallback: PriceFallbackDtoSchema.nullable().describe('Set when the price selected for this buyer could not be charged and the checkout charges the plan\'s default price instead. Tell the buyer before they pay. Null when the price selected is the price charged.'),
  /** Which provider issued this checkout. Stamped on Subscription.provider. */
  provider: BillingProviderSchema.describe('Which provider issued this checkout. Stamped on Subscription.provider.'),
  /**
   * Problems that did not stop this checkout, or changed how it is presented.
   * Empty when there are none.
   */
  warnings: z.array(CheckoutWarningSchema).describe('Problems that did not stop this checkout, or changed how it is presented. Empty when there are none.'),
  /**
   * `embedded` when `url` is the Rekey-hosted checkout page, `redirect` when it
   * is the provider's own page.
   */
  mode: z.enum(['redirect', 'embedded']).describe('`embedded` when `url` is the Rekey-hosted checkout page, `redirect` when it is the provider\'s own page.'),
  /** Rekey's id for this checkout. Not a credential, so it is safe to log. */
  checkoutSessionId: z.string().describe('Rekey\'s id for this checkout. Not a credential, so it is safe to log.'),
});
export type CheckoutResultDto = z.infer<typeof CheckoutResultDtoSchema>;

/**
 * What the Rekey-hosted checkout page may show for one session, as
 * `GET /api/v1/checkout-sessions/:token` returns it.
 *
 * `order` is present only while the session can still be paid (`open`) or is
 * waiting for the processor's webhook (`confirming`). A `complete` or
 * `expired` session carries no order details and no email, only where to send
 * the buyer back to.
 */
const PaypalSubscriptionClientSchema = z.object({
  provider: z.literal('paypal'),
  /** The PayPal REST app's client id for this session's mode. Public by design. */
  clientId: z.string(),
  /** The subscription Rekey created server-side, handed to the Buttons. */
  subscriptionId: z.string(),
  sdk: z.literal('v5-subscription'),
});

const PaypalOrderClientSchema = z.object({
  provider: z.literal('paypal'),
  /** The PayPal REST app's client id for this session's mode. Public by design. */
  clientId: z.string(),
  /** The Orders v2 order Rekey created server-side, handed to the Buttons' `createOrder`. */
  orderId: z.string(),
  sdk: z.literal('v5-order'),
  /** ISO 4217 code of the order. PayPal's script must be loaded with the order's currency. */
  currency: z.string(),
});

/** Razorpay Standard Checkout, opened on a subscription or on an order Rekey created server-side. */
const RazorpayClientSchema = z.object({
  provider: z.literal('razorpay'),
  /** The Razorpay key id for this session's mode. Public by design: checkout.js takes it. */
  keyId: z.string(),
  sdk: z.literal('razorpay-checkout'),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('subscription'), subscriptionId: z.string() }),
    z.object({ kind: z.literal('order'), orderId: z.string() }),
  ]),
});

const StripeElementsClientSchema = z.object({
  provider: z.literal('stripe'),
  /** The Application's `pk_test_` / `pk_live_` key, in this session's mode. Public by design. */
  publishableKey: z.string(),
  /** The Checkout Session's client secret: scoped to this one session and meant for the browser. */
  clientSecret: z.string(),
  sdk: z.literal('elements'),
});

export const CheckoutPageClientSchema = z.discriminatedUnion('sdk', [
  PaypalSubscriptionClientSchema,
  PaypalOrderClientSchema,
  RazorpayClientSchema,
  StripeElementsClientSchema,
]);
export type CheckoutPageClient = z.infer<typeof CheckoutPageClientSchema>;
export type PaypalCheckoutPageClient = Extract<CheckoutPageClient, { provider: 'paypal' }>;

export const CheckoutPageOrderSchema = z.object({
  merchant: z.object({
    displayName: z.string(),
    logoUrl: z.string().nullable(),
    primaryColor: z.string().nullable(),
    backgroundColor: z.string().nullable(),
    surfaceColor: z.string().nullable(),
    supportEmail: z.string().nullable(),
    supportUrl: z.string().nullable(),
    termsUrl: z.string().nullable(),
    privacyUrl: z.string().nullable(),
    refundUrl: z.string().nullable(),
  }),
  plan: z.object({
    name: z.string(),
    /** Smallest currency unit. */
    amount: z.number().int(),
    currency: z.string(),
    interval: z.enum(['MONTH', 'YEAR']).nullable(),
    kind: z.enum(['recurring', 'one_time']),
  }),
  /** Smallest currency unit. */
  discountAmount: z.number().int(),
  /** Smallest currency unit. */
  totalDueToday: z.number().int(),
  /** The signed-in buyer the checkout was created for. */
  buyerEmail: z.string(),
  successUrl: z.string(),
  cancelUrl: z.string(),
  /** The hosted portal URL for this Application, when it has one, for the cancel sentence. */
  manageUrl: z.string().nullable(),
  expiresAt: z.string(),
  /**
   * Set when the price selected for this buyer could not be charged and the
   * checkout charges the plan's default price instead, as recorded when the
   * checkout was opened. Tell the buyer before they pay. Null otherwise.
   */
  priceFallback: PriceFallbackDtoSchema.nullable(),
  client: CheckoutPageClientSchema,
});
export type CheckoutPageOrder = z.infer<typeof CheckoutPageOrderSchema>;

export const CheckoutPageViewSchema = z.object({
  status: z.enum(['open', 'confirming', 'complete', 'expired']),
  slug: z.string(),
  paymentMode: z.enum(['test', 'live']),
  provider: z.string(),
  /** Where the buyer goes from a complete or expired page. */
  returnUrl: z.string(),
  order: CheckoutPageOrderSchema.nullable(),
});
export type CheckoutPageView = z.infer<typeof CheckoutPageViewSchema>;

export const CheckoutReadinessCheckSchema = z.object({
  id: z.enum([
    'portal',
    'provider',
    'webhook',
    'plans',
    'return_urls',
    'browser_credential',
    'branding',
    'csp_reports',
  ]),
  provider: z.string().nullable(),
  status: z.enum(['PASS', 'WARN', 'FAIL', 'N/A']),
  message: z.string(),
  /** A concrete repair, or null for a PASS. */
  fix: z.string().nullable(),
});
export type CheckoutReadinessCheck = z.infer<typeof CheckoutReadinessCheckSchema>;

/** Readiness for both payment modes, as the panel's Test and Live columns show it. */
export const CheckoutReadinessSchema = z.object({
  test: z.array(CheckoutReadinessCheckSchema),
  live: z.array(CheckoutReadinessCheckSchema),
  ranAt: z.string(),
});
export type CheckoutReadiness = z.infer<typeof CheckoutReadinessSchema>;

export const CheckoutSettingsSchema = z.object({
  checkoutModeTest: z.enum(['REDIRECT', 'EMBEDDED']),
  checkoutModeLive: z.enum(['REDIRECT', 'EMBEDDED']),
  checkoutFailureMode: z.enum(['FALLBACK_TO_REDIRECT', 'REFUSE']),
});
export type CheckoutSettings = z.infer<typeof CheckoutSettingsSchema>;

const ReadinessCountsSchema = z.object({
  PASS: z.number().int(),
  WARN: z.number().int(),
  FAIL: z.number().int(),
  'N/A': z.number().int(),
});

/** The Billing page's status panel for the Rekey checkout page. */
export const CheckoutStatusPanelSchema = z.object({
  settings: CheckoutSettingsSchema,
  readiness: z
    .object({ ranAt: z.string(), test: ReadinessCountsSchema, live: ReadinessCountsSchema })
    .nullable(),
  /** Last verified webhook, per provider, labelled with the provider's current credential mode. */
  lastWebhooks: z.array(z.object({ provider: z.string(), mode: z.enum(['test', 'live']), receivedAt: z.string() })),
  /** Last Rekey-page checkout completed, per payment mode. */
  lastEmbeddedCompleted: z.object({ test: z.string().nullable(), live: z.string().nullable() }),
  /** Checkouts served on the provider's page because a check failed, last 7 days, newest first. */
  recentFallbacks: z.array(
    z.object({ at: z.string(), check: z.string(), provider: z.string(), paymentMode: z.string() }),
  ),
  fallbackCount: z.number().int(),
});
export type CheckoutStatusPanel = z.infer<typeof CheckoutStatusPanelSchema>;

/**
 * One plan's answer to "may THIS buyer start its trial".
 *
 * Advisory: the authoritative decision is taken under a lock at checkout, so
 * two tabs can both read `eligible: true` and only one gets the trial.
 */
export const TrialEligibilityItemSchema = z.object({
  planSlug: z.string(),
  /** The plan's real value, reported even when the trial is misconfigured. */
  trialDays: z.number().int().nullable(),
  eligible: z.boolean(),
  /**
   * First match wins, in this order:
   *
   * - `PLAN_HAS_NO_TRIAL`, the plan offers none.
   * - `PLAN_TRIAL_MISCONFIGURED`, it carries a trial this checkout could never
   *   honour (one-off purchase, or a provider that cannot run trials), so the
   *   plan is UNBUYABLE rather than merely trial-less; checkout answers 400.
   * - `TRIAL_IN_PROGRESS`, a trial is running on THIS plan.
   * - `ALREADY_REDEEMED`, an earlier trial spends the slot under this policy.
   */
  reason: z
    .enum(['PLAN_HAS_NO_TRIAL', 'PLAN_TRIAL_MISCONFIGURED', 'TRIAL_IN_PROGRESS', 'ALREADY_REDEEMED'])
    .nullable(),
  redeemedAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  /**
   * The processor this plan's own checkout would go to for this buyer, which
   * the answer was resolved against. It can differ from the response's
   * top-level `provider` when the plan is priced in a currency the country's
   * default cannot charge. Present only where the answer depends on a
   * provider: a recurring plan that offers a trial.
   */
  provider: BillingProviderSchema.optional(),
});
export type TrialEligibilityItemDto = z.infer<typeof TrialEligibilityItemSchema>;

/** What spends a trial slot, the Application's `trialPolicy`. */
export const TrialPolicySchema = z.enum([
  'once_per_application',
  'once_per_plan',
  'unlimited',
]);
export type TrialPolicyType = z.infer<typeof TrialPolicySchema>;

/**
 * The body of `GET /billing/trial-eligibility`.
 *
 * Not a bare `Paged<TrialEligibilityItemDto>`: the route also answers `policy`
 * and `provider`, and the endpoint's own description tells callers to read
 * `provider` and re-ask when the buyer changes processor, because a plan can be
 * unbuyable on one and fine on another. A type that omitted them would make the
 * documented flow untypeable.
 */
export const TrialEligibilityDtoSchema = z.object({
  items: z.array(TrialEligibilityItemSchema),
  page: PageMetaSchema,
  policy: TrialPolicySchema,
  provider: BillingProviderSchema,
});
export type TrialEligibilityDto = z.infer<typeof TrialEligibilityDtoSchema>;

export const BillingProviderInfoDtoSchema = z.object({
  provider: BillingProviderSchema.describe('The provider\'s name, such as `stripe`.'),
  priority: z.number().int().min(0).describe('The router\'s preference rank. Lower is preferred.'),
  countries: z.array(z.string().length(2)).describe('ISO 3166-1 alpha-2 codes whose buyers are routed to this provider first.'),
  /** The currencies this provider account charges, upper-case ISO 4217. Empty means none. */
  currencies: z.array(z.string()).describe('The currencies this provider account charges, upper-case ISO 4217. Empty means none.'),
  // Left out for a configured provider this server has no module for. Prefer
  // `label` when present; fall back to a capitalized `provider` otherwise.
  label: z.string().optional().describe('Left out for a configured provider this server has no module for. Prefer `label` when present; fall back to a capitalized `provider` otherwise.'),
  docsUrl: z.string().optional().describe('The provider\'s documentation.'),
  capabilities: BillingProviderCapabilitiesSchema.optional().describe('What the provider module can do.'),
});
export type BillingProviderInfoDto = z.infer<typeof BillingProviderInfoDtoSchema>;

export const ProvidersListDtoSchema = z.object({
  country: z.string().length(2).nullable().describe('The buyer\'s country as resolved, ISO 3166-1 alpha-2, or null when none is known.'),
  /**
   * How far `country` can be believed: `declared` by a secret-key caller,
   * `vouched` by a trusted proxy or the portal, or a `hint` from a browser
   * caller or an unverified CDN header. Null when no country is known.
   */
  countrySource: z.enum(['declared', 'vouched', 'hint']).nullable().describe('How far `country` can be believed: `declared` by a secret-key caller, `vouched` by a trusted proxy or the portal, or a `hint` from a browser caller or an unverified CDN header. Null when no country is known.'),
  /**
   * The provider a checkout that names none is routed to: preselect it in a
   * picker. Null when no provider is enabled.
   */
  routedProvider: z.string().nullable().describe('The provider a checkout that names none is routed to: preselect it in a picker. Null when no provider is enabled.'),
  providers: z.array(BillingProviderInfoDtoSchema).describe('The enabled providers, in the order the router prefers them for this buyer.'),
});
export type ProvidersListDto = z.infer<typeof ProvidersListDtoSchema>;

/**
 * One OAuth provider a sign-in page can offer, as `GET /api/v1/auth/oauth/providers`
 * returns it. Deliberately just the two fields a button needs: the client id,
 * redirect URI, scopes and issuer stay operator-only.
 */
export const OAuthProviderSummaryDtoSchema = z
  .object({
    /** The `:provider` path segment for `/api/v1/auth/oauth/:provider/start`, e.g. `"google"`. */
    id: z.string().min(1),
    /** Display name for the button, e.g. `"Google"`. */
    name: z.string().min(1),
  })
  .strict();
export type OAuthProviderSummaryDto = z.infer<typeof OAuthProviderSummaryDtoSchema>;

/** The body of `GET /api/v1/auth/oauth/providers`. */
export const OAuthProvidersListDtoSchema = z.object({
  providers: z.array(OAuthProviderSummaryDtoSchema),
});
export type OAuthProvidersListDto = z.infer<typeof OAuthProvidersListDtoSchema>;

// ============================================================================
// Coupons
// ============================================================================

export const CouponDiscountTypeSchema = z.enum(['PERCENT', 'AMOUNT']);
export type CouponDiscountTypeValue = z.infer<typeof CouponDiscountTypeSchema>;

/** What a fixed-amount coupon takes off in one currency, in that currency's minor unit. */
export const CouponAmountDtoSchema = z.object({
  /** Upper-case ISO 4217. */
  currency: z.string().describe('Upper-case ISO 4217.'),
  amountOff: z.number().int().min(1).describe('What the coupon takes off, an integer in the minor unit of `currency`.'),
});
export type CouponAmountDto = z.infer<typeof CouponAmountDtoSchema>;

/**
 * A coupon as an operator reads it.
 *
 * A PERCENT coupon carries `basisPoints` and works in every currency unless
 * `currencies` limits it. An AMOUNT coupon carries one `amounts` row per
 * currency and works only in those: an amount is never converted or reused
 * in another currency.
 *
 * @example
 * { discountType: 'AMOUNT', basisPoints: null, currencies: [], coveredCurrencies: ['INR', 'USD'],
 *   amounts: [{ currency: 'INR', amountOff: 40000 }, { currency: 'USD', amountOff: 500 }] }
 */
export const CouponDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string().describe('The Application the coupon belongs to.'),
  code: z.string().describe('The code a buyer enters.'),
  discountType: CouponDiscountTypeSchema.describe('PERCENT takes `basisPoints` off any covered price. AMOUNT takes a fixed amount per currency.'),
  /** PERCENT: hundredths of a percent, 1500 is 15.00%. Null on an AMOUNT coupon. */
  basisPoints: z.number().int().min(0).max(10000).nullable().describe('PERCENT: hundredths of a percent, 1500 is 15.00%. Null on an AMOUNT coupon.'),
  /** AMOUNT: one row per currency, sorted by currency. Empty on a PERCENT coupon. */
  amounts: z.array(CouponAmountDtoSchema).describe('AMOUNT: one row per currency, sorted by currency. Empty on a PERCENT coupon.'),
  /** PERCENT: the currencies it is limited to, empty for any. Always empty on an AMOUNT coupon. */
  currencies: z.array(z.string()).describe('PERCENT: the currencies it is limited to, empty for any. Always empty on an AMOUNT coupon.'),
  /** Every currency a checkout may use this coupon in, sorted. Null means any currency. */
  coveredCurrencies: z.array(z.string()).nullable().describe('Every currency a checkout may use this coupon in, sorted. Null means any currency.'),
  planSlugs: z.array(z.string()).describe('The plans the coupon applies to. Empty means every plan.'),
  active: z.boolean().describe('Whether the coupon can be redeemed.'),
  startsAt: z.string().datetime().nullable().describe('When the coupon starts working, or null for immediately.'),
  endsAt: z.string().datetime().nullable().describe('When the coupon stops working, or null for never.'),
  maxRedemptions: z.number().int().nullable().describe('How many times the coupon may be redeemed in all, across every currency. Null for no limit.'),
  maxRedemptionsPerUser: z.number().int().nullable().describe('How many times one buyer may redeem it. Null for no limit.'),
  metadata: z.record(z.unknown()).describe('Operator data kept on the coupon.'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CouponDto = z.infer<typeof CouponDtoSchema>;

/**
 * A coupon with what it has given away, as the operator's coupon list returns
 * it. There is one row per currency and no total: money in two currencies is
 * never added together.
 */
export const CouponWithStatsDtoSchema = CouponDtoSchema.extend({
  /** Settled redemptions in every currency. Open checkouts holding the coupon are not counted. */
  redemptionCount: z.number().int().min(0).describe('Settled redemptions in every currency. Open checkouts holding the coupon are not counted.'),
  /**
   * What the coupon took off, per currency charged: the Application's
   * reporting currency first, then by redemptions. A redemption recorded
   * before currencies were kept, which nothing can place, is in
   * `redemptionCount` and in no row here.
   */
  discountIssuedByCurrency: z.array(
    z.object({
      currency: z.string().describe('Upper-case ISO 4217: the currency charged.'),
      /** Minor units of `currency`. */
      amount: z.number().int().min(0).describe('Minor units of `currency`.'),
      redemptions: z.number().int().min(0).describe('Settled redemptions in this currency.'),
    }),
  ).describe('What the coupon took off, per currency charged: the Application\'s reporting currency first, then by redemptions. A redemption recorded before currencies were kept, which nothing can place, is in `redemptionCount` and in no row here.'),
});
export type CouponWithStatsDto = z.infer<typeof CouponWithStatsDtoSchema>;

const CouponCurrencyInput = z.string().length(3);
// Ranges are checked by the API, which answers them with a `fix`:
// COUPON_AMOUNT_INVALID for an amount or a rate, COUPON_CURRENCY_INVALID for a code.
const CouponAmountInputSchema = z.object({
  currency: CouponCurrencyInput,
  /** Above 0, in the smallest unit of `currency`. */
  amountOff: z.number().int(),
});
/** Hundredths of a percent, 1 to 10000. */
const CouponBasisPointsInput = z.number().int();

/**
 * `POST .../coupons`. Send `basisPoints` with PERCENT and `amounts` with
 * AMOUNT. `amountOff` and `currency` at the top level are gone and are
 * refused with `BILLING_FIELD_REMOVED`.
 *
 * @example
 * { code: 'LAUNCH', discountType: 'PERCENT', basisPoints: 1500, currencies: ['USD'] }
 * { code: 'FIVEOFF', discountType: 'AMOUNT', amounts: [{ currency: 'USD', amountOff: 500 }, { currency: 'INR', amountOff: 40000 }] }
 */
export const CreateCouponRequestSchema = z.object({
  code: z.string().min(1).max(40),
  discountType: CouponDiscountTypeSchema,
  basisPoints: CouponBasisPointsInput.optional(),
  amounts: z.array(CouponAmountInputSchema).max(200).optional(),
  currencies: z.array(CouponCurrencyInput).max(200).optional(),
  planSlugs: z.array(z.string().min(1).max(40)).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  maxRedemptions: z.number().int().min(1).max(2_147_483_647).optional(),
  maxRedemptionsPerUser: z.number().int().min(1).max(2_147_483_647).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateCouponRequest = z.infer<typeof CreateCouponRequestSchema>;

const CouponCapInput = z.number().int().min(1).max(2_147_483_647);

/**
 * `PATCH .../coupons/:code`. Every field is optional and at least one is
 * sent. `amounts` replaces the whole set, so send every currency the coupon
 * should keep. A coupon's `discountType` cannot be changed.
 *
 * `endsAt`, `maxRedemptions` and `maxRedemptionsPerUser` each take a value or
 * `null`: null removes the end date or the cap. A cap below what is already
 * redeemed is refused with `COUPON_LIMIT_BELOW_REDEEMED`.
 *
 * @example
 * { amounts: [{ currency: 'USD', amountOff: 500 }, { currency: 'EUR', amountOff: 450 }] }
 * { endsAt: '2026-12-31T23:59:59.000Z', maxRedemptions: 500, maxRedemptionsPerUser: null }
 */
export const UpdateCouponRequestSchema = z
  .object({
    active: z.boolean().optional(),
    basisPoints: CouponBasisPointsInput.optional(),
    amounts: z.array(CouponAmountInputSchema).max(200).optional(),
    currencies: z.array(CouponCurrencyInput).max(200).optional(),
    planSlugs: z.array(z.string().min(1).max(40)).optional(),
    /** When the coupon stops working. Null removes the end. */
    endsAt: z.string().datetime().nullable().optional(),
    /** Redemptions allowed in all, across every buyer and currency. Null removes the cap. */
    maxRedemptions: CouponCapInput.nullable().optional(),
    /** Redemptions allowed per buyer. Null removes the cap. */
    maxRedemptionsPerUser: CouponCapInput.nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Send at least one field to change.',
  });
export type UpdateCouponRequest = z.infer<typeof UpdateCouponRequestSchema>;

export const ValidateCouponRequestSchema = z.object({
  code: z.string().min(1).max(40),
  planSlug: z.string().min(1).max(40),
  /**
   * The buyer's country, ISO 3166-1 alpha-2, under the checkout's rules: fact
   * from a secret key, a hint from a publishable key. It selects the price the
   * quote is made against. Two characters as the API takes them, so a CDN's
   * country header can be forwarded as it is (`T1`, `XX`).
   */
  country: z.string().regex(COUNTRY_INPUT).optional(),
  /**
   * Secret key only, as at checkout: quote the plan's price in this ISO 4217
   * currency. A publishable-key request that sends it is refused with
   * `BILLING_CURRENCY_NOT_ALLOWED`.
   */
  currency: z.string().length(3).optional(),
  /** As at checkout: `refuse` answers `BILLING_NO_PROVIDER_FOR_CURRENCY` where `fallback` would quote the default price. */
  onUnavailableCurrency: z.enum(['fallback', 'refuse']).optional(),
  /** The provider the checkout will name, if it names one: the quote is made at the price it can charge. */
  provider: BillingProviderSchema.optional(),
  /** The organization the checkout will bill, for an Application that bills per organization. */
  organizationId: z.string().min(1).optional(),
});
export type ValidateCouponRequest = z.infer<typeof ValidateCouponRequestSchema>;

/**
 * What a BUYER may see of a coupon: enough to render "15% off" and nothing
 * else. Never the limits, the operator's `metadata`, or the other currencies
 * a fixed-amount coupon has an amount in.
 */
export const PublicCouponDtoSchema = z.object({
  code: z.string().describe('The code as stored.'),
  discountType: CouponDiscountTypeSchema.describe('PERCENT or AMOUNT.'),
  /** PERCENT: hundredths of a percent, 1500 is 15.00%. Null on an AMOUNT coupon, whose size is `discountAmount`. */
  basisPoints: z.number().int().min(0).max(10000).nullable().describe('PERCENT: hundredths of a percent, 1500 is 15.00%. Null on an AMOUNT coupon, whose size is `discountAmount`.'),
});
export type PublicCouponDto = z.infer<typeof PublicCouponDtoSchema>;

/**
 * The quote for one coupon on one plan, at the price this caller's checkout
 * would charge. Every amount is in `currency`.
 */
export const ValidateCouponResultDtoSchema = z.object({
  coupon: PublicCouponDtoSchema.describe('What the buyer may see of the coupon.'),
  plan: z
    .object({ slug: z.string().describe('The plan slug.'), name: z.string().describe('Display name.') })
    .describe('The plan the quote is for.'),
  /** The price the checkout would charge, before the discount. Null for a plan with no flat price. */
  price: ResolvedPriceDtoSchema.nullable().describe('The price the checkout would charge, before the discount. Null for a plan with no flat price.'),
  /** Set when the price selected for this buyer cannot be charged and the default price is quoted instead. */
  priceFallback: PriceFallbackDtoSchema.nullable().describe('Set when the price selected for this buyer cannot be charged and the default price is quoted instead.'),
  /** Upper-case ISO 4217: the currency the checkout would charge. */
  currency: z.string().describe('Upper-case ISO 4217: the currency the checkout would charge.'),
  /** The price before the discount, minor units of `currency`. */
  amount: z.number().int().min(0).describe('The price before the discount, minor units of `currency`.'),
  discountAmount: z.number().int().min(0).describe('What the coupon takes off, minor units of `currency`.'),
  amountAfterDiscount: z.number().int().min(0).describe('What the buyer pays, minor units of `currency`.'),
  /** `discountAmount` and `amountAfterDiscount` written for a person, such as "$3.00" and "$16.99". */
  formatted: z
    .object({
      discount: z.string().describe('`discountAmount` written for a person, such as "$3.00".'),
      total: z.string().describe('`amountAfterDiscount` written for a person, such as "$16.99".'),
    })
    .describe('`discountAmount` and `amountAfterDiscount` written for a person.'),
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
  /**
   * End-user MCP tokens only: the organization the grant acts for, chosen at
   * consent. Absent on a personal grant. A token whose holder can no longer
   * act for it is reported `active: false`.
   */
  oid: z.string().optional(),
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

/** Body of `GET /.well-known/jwks.json`, the deployment's RS256 key set. */
export const JwksDtoSchema = z.object({ keys: z.array(JwkRsaPublicSchema) });
export type JwksDto = z.infer<typeof JwksDtoSchema>;

/** A security audit-log event (operator audit view). */
export const SecurityEventDtoSchema = z.object({
  id: z.string(),
  type: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  /**
   * The actor's email, resolved when the log is read: the operator account for
   * `operator`, the end-user (within this event's Application) for `end_user`.
   * `null` for `system`, and for an actor that no longer exists; `actorId`
   * still identifies it.
   */
  actorEmail: z
    .string()
    .nullable()
    .describe(
      'Email of the actor, resolved at read time: the operator for `operator`, the end-user for `end_user`. ' +
        'Null for `system` and for an actor that no longer exists.',
    ),
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
  /** False when an idempotent replay matched a prior call, balance is unchanged. */
  applied: z.boolean(),
});
export type ConsumeCreditsResultDto = z.infer<typeof ConsumeCreditsResultDtoSchema>;

// ============================================================================
// Organizations, end-user teams (gated by AuthConfig.organizationsEnabled)
// ============================================================================

/**
 * The authority tier Rekey itself enforces. Every organization role name maps
 * onto exactly one of these, and every server-side gate (the canManage
 * ladder, the last-OWNER guard, org-scoped billing writes) compares the TIER.
 * Compare against this, not against `role`, when deciding what a member may do.
 */
export const OrganizationBaseRoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER']);
export type OrganizationBaseRole = z.infer<typeof OrganizationBaseRoleSchema>;

/**
 * An organization role NAME, drawn from the Application's catalog.
 *
 * Was a fixed `z.enum(['OWNER','ADMIN','MEMBER'])`. It is now a string because
 * operators can define their own names (`editor`, `content-manager`) against a
 * base tier. The three built-ins still exist on every Application and still
 * spell exactly the same, so every previously-valid value remains valid. A
 * client that switches exhaustively over the old union must now handle names
 * it does not know, which is the point of the catalog.
 *
 * `GET /api/v1/users/me/organizations/roles` lists what an Application accepts.
 */
export const OrganizationRoleSchema = z.string().min(1).max(40);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

/** One row of an Application's organization-role catalog. */
export const OrganizationRoleDefDtoSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  baseRole: OrganizationBaseRoleSchema,
  /** Assigned when an invitation or operator add-member omits a role. */
  isDefault: z.boolean(),
  /** True for OWNER / ADMIN / MEMBER. Cannot be renamed, re-tiered or deleted. */
  isBuiltIn: z.boolean(),
});
export type OrganizationRoleDefDto = z.infer<typeof OrganizationRoleDefDtoSchema>;

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
  /** The calling user's role NAME in this organization. */
  role: OrganizationRoleSchema,
  /** The tier that name maps to. Gate on this, not on `role`. */
  baseRole: OrganizationBaseRoleSchema,
});
export type OrganizationWithRoleDto = z.infer<typeof OrganizationWithRoleDtoSchema>;

export const OrganizationMemberDtoSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  endUserId: z.string(),
  email: z.string(),
  role: OrganizationRoleSchema,
  baseRole: OrganizationBaseRoleSchema,
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
// Devices, the machines an end-user signs in from
// ============================================================================

/**
 * The FEATURE entitlement key that caps ACTIVE devices per end-user. Put it on
 * a plan as `{ kind: 'FEATURE', key: 'max_devices', valueType: 'INT', value: '3' }`
 * and the devices service enforces it at sign-in and licence verification. It
 * resolves through the ordinary entitlement union, MAX across the end-user's
 * active subscriptions, with the Application's default plan supplying the free
 * tier, so a plan upgrade raises the cap without touching a device row. An
 * end-user whose plans grant no such feature is uncapped.
 */
export const DEVICE_LIMIT_FEATURE_KEY = 'max_devices';

export const DeviceStatusSchema = z.enum(['ACTIVE', 'RELEASED', 'BLOCKED']);
export type DeviceStatusType = z.infer<typeof DeviceStatusSchema>;

/**
 * A device as returned by every device-listing route. `fingerprint` is the
 * opaque value the client supplied; `blockedReason` is operator-facing and is
 * omitted on end-user routes (see `EndUserDeviceDtoSchema`).
 */
export const DeviceDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  endUserId: z.string(),
  fingerprint: z.string(),
  label: z.string().nullable(),
  status: DeviceStatusSchema,
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  lastSeenIp: z.string().nullable(),
  releasedAt: z.string().datetime().nullable(),
  blockedAt: z.string().datetime().nullable(),
  blockedReason: z.string().nullable(),
  metadata: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DeviceDto = z.infer<typeof DeviceDtoSchema>;

/** What an end-user sees of their own devices: no operator notes, no IP. */
export const EndUserDeviceDtoSchema = DeviceDtoSchema.omit({ blockedReason: true, lastSeenIp: true });
export type EndUserDeviceDto = z.infer<typeof EndUserDeviceDtoSchema>;

/**
 * `details` on a `DEVICE_LIMIT_REACHED` (403) refusal.
 *
 * The error's own `fix` tells the client to offer "release one of these", so
 * the list has to be readable from the thrown error rather than re-fetched:
 * the caller has no session yet, which is the whole reason sign-in refused.
 * These are deliberately fewer fields than `EndUserDeviceDto`: it is what
 * `auth.service.ts` puts on the envelope, enough to render a chooser.
 */
export const DeviceLimitDetailsSchema = z.object({
  /**
   * False when the Application sets `deviceRelease: 'server_only'`: offer
   * "contact support" rather than a release. Absent on APIs older than the
   * setting, which always allowed self-release.
   */
  selfRelease: z.boolean().optional(),
  /** The `max_devices` entitlement that was reached. */
  limit: z.number().int(),
  devices: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable(),
      firstSeenAt: z.string().datetime(),
      lastSeenAt: z.string().datetime(),
    }),
  ),
});
export type DeviceLimitDetails = z.infer<typeof DeviceLimitDetailsSchema>;

// ============================================================================
// `?include=` on GET /api/v1/auth/me and GET /api/v1/users/me
// ============================================================================

/**
 * The values `?include=` accepts on the two current-user routes. Each one adds
 * a top-level property of the same name to the response; with none, the
 * response is exactly what it was before the parameter existed.
 */
export const ME_INCLUDE_VALUES = [
  'entitlements',
  'device',
  'subscription',
  'organization',
  'licenses',
  'support',
] as const;
export type MeInclude = (typeof ME_INCLUDE_VALUES)[number];

/** One row of `GET /billing/entitlements` → `entitlements`. */
export interface ResolvedEntitlementDto {
  kind: 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
  key: string;
  valueType: 'BOOL' | 'INT' | 'STRING' | null;
  value: string | null;
  quantity: number | null;
  /** USAGE only: credits charged per unit past `quantity`. Null means a hard cap. */
  creditsPerUnit?: number | null;
  licenseKind: 'PERPETUAL' | 'TIMED' | 'SEATS' | null;
  rollover: boolean;
}

/** `data` of `GET /billing/entitlements`, and `entitlements` on the current-user routes. */
export interface ResolvedEntitlementsDto {
  /** Feature flags and numeric limits, keyed by code. Gate your app on these. */
  features: Record<string, boolean | number | string>;
  /** The raw resolved entitlement rows, every kind. */
  entitlements: ResolvedEntitlementDto[];
  /** Live credit balance of the resolved subject. */
  creditBalance: number;
}

/**
 * Support mode as the end-user's own session and the application's backend
 * read it. Rekey reports the state; the application decides what each
 * capability means, and must check anything valuable on its backend.
 */
export type SupportModeDto =
  | {
      active: true;
      /** Capability names from the Application's catalogue, sorted. */
      capabilities: string[];
      /** `device` when the case is limited to named devices and this is one of them. */
      scope: 'user' | 'device';
      /** When the case was opened. */
      since: string;
      /** When its capabilities or devices last changed. Cache on this, not on `since`. */
      updatedAt: string;
    }
  | { active: false; capabilities: [] };

export const SUPPORT_CASE_CLOSED_CAUSES = ['operator', 'banned', 'erased', 'device_released'] as const;
export type SupportCaseClosedCause = (typeof SUPPORT_CASE_CLOSED_CAUSES)[number];

/** An operator's note on a support case. Operator-only, append-only. */
export interface SupportCaseNoteDto {
  id: string;
  body: string;
  /** Operator (TenantUser) id. */
  authorId: string;
  /** That operator's email, or null once they no longer exist. */
  authorEmail: string | null;
  createdAt: string;
}

/** A support case as operators see it. Never returned to an end-user. */
export interface SupportCaseDto {
  id: string;
  applicationId: string;
  endUserId: string;
  /** Null once the end-user is erased or deleted. */
  endUserEmail: string | null;
  status: 'OPEN' | 'CLOSED';
  capabilities: string[];
  /** `USER` covers every device. `DEVICES` covers only `deviceIds`. */
  scope: 'USER' | 'DEVICES';
  deviceIds: string[];
  /** Operator-only. Null after the end-user is erased or deleted. */
  reason: string | null;
  openedBy: string | null;
  openedByEmail: string | null;
  openedAt: string;
  updatedAt: string;
  closedBy: string | null;
  closedByEmail: string | null;
  closedAt: string | null;
  closedCause: SupportCaseClosedCause | null;
  /**
   * Operator notes, oldest first. Only on `GET .../end-users/:euid/support`,
   * where one response carries the newest 200 notes across its cases.
   */
  notes?: SupportCaseNoteDto[];
  /** How many notes the case has. Can exceed `notes.length` on the per-user read. */
  noteCount?: number;
}

/** One entry of an Application's support capability catalogue. */
export interface SupportCapabilityDto {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `data.support` of the `support.opened`, `support.updated` and `support.closed` webhooks. */
export interface SupportWebhookState {
  caseId: string;
  active: boolean;
  capabilities: string[];
  scope: 'USER' | 'DEVICES';
  deviceIds: string[];
  since: string;
  updatedAt: string;
  /** Present on `support.closed` only. */
  closedCause?: SupportCaseClosedCause;
}

/** What each `include` value adds to the current-user response, under its own name. */
export interface MeIncludedFields {
  /**
   * Same object as `GET /billing/entitlements/for-user` for the Application's
   * billing subject: the active organization in an org-billed Application,
   * otherwise the end-user.
   */
  entitlements: ResolvedEntitlementsDto;
  /**
   * The device the access token's `dev` claim names. Null when the session is
   * not device-bound. A session whose device was released or blocked is
   * refused with 401 before this is read, so a returned device is ACTIVE.
   */
  device: EndUserDeviceDto | null;
  /** Same value as `GET /billing/subscription` for the same billing subject as `entitlements`. */
  subscription: SelfSubscriptionDto | null;
  /** The session's active organization with the caller's role, or null. */
  organization: OrganizationWithRoleDto | null;
  /**
   * The first 100 rows of `GET /users/me/licenses`: the caller's own licences,
   * plus the active organization's in an org-billed Application. `truncated`
   * is true when there are more; page the route for the rest.
   */
  licenses: { items: EndUserLicenseDto[]; truncated: boolean };
  /**
   * Support mode for this session. A case limited to devices is active only
   * on a session whose `dev` claim names one of them; a session that is not
   * device-bound sees such a case as inactive.
   */
  support: SupportModeDto;
}

/**
 * What `GET /users/me`, `PATCH /users/me` and `GET /auth/me` return before any
 * `include`: the end-user plus the session's active organization and the
 * caller's role in it (null when there is none or membership lapsed).
 */
export type CurrentUserDto = EndUserDto & {
  activeOrganizationId: string | null;
  /** The caller's role NAME in the active organization. Not the app-wide `role`. */
  activeOrganizationRole: string | null;
  /** The tier that role maps to. Gate organization permissions on this. */
  activeOrganizationBaseRole: OrganizationBaseRole | null;
};

/** The properties a given `include` list adds. `MeIncluded<never>` is `{}`. */
export type MeIncluded<I extends MeInclude> = Pick<MeIncludedFields, I>;

/**
 * What an `include` LIST adds, as the SDKs type it. A literal list (inline, or
 * `as const`) is a tuple, so the result has exactly those properties. A list
 * typed as `MeInclude[]` could hold any subset at runtime, so every property
 * it might add is optional rather than promised.
 */
export type MeIncludedFor<L extends readonly MeInclude[]> = number extends L['length']
  ? Partial<MeIncluded<L[number]>>
  : MeIncluded<L[number]>;

// ============================================================================
// Licenses, keys issued by LICENSE-kind plans
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
 * A licence as its holder sees it (`GET /users/me/licenses`, `include=licenses`).
 *
 * The raw key is never stored, only its hash, so it cannot be returned here;
 * `keyPrefix` is the display prefix every other licence surface shows.
 * `metadata` is the operator's own notes about the licence and is left out.
 * `organizationId` is set when the licence's seats are pooled to a team.
 */
export const EndUserLicenseDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  endUserId: z.string(),
  organizationId: z.string().nullable(),
  planId: z.string().nullable(),
  kind: LicenseKindSchema,
  status: LicenseStatusSchema,
  keyPrefix: z.string(),
  /** Which of the plan's LICENSE entitlements issued it; "" for a plan's single one. */
  entitlementKey: z.string(),
  expiresAt: z.string().datetime().nullable(),
  seatsAllowed: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type EndUserLicenseDto = z.infer<typeof EndUserLicenseDtoSchema>;

/**
 * Result of POST /api/v1/licenses/verify. Always HTTP 200, branch on `ok`
 * (invalid licenses are a `false` result, not an error) so client software
 * can loop on the outcome without try/catch.
 */
export const LicenseVerifyResultDtoSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), license: LicenseDtoSchema }),
  z.object({
    ok: z.literal(false),
    // `suspended`: the holder is banned from the Application by an operator.
    reason: z.enum(['unknown', 'wrong_application', 'revoked', 'expired', 'seats_exhausted', 'suspended']),
    license: LicenseDtoSchema.optional(),
  }),
]);
export type LicenseVerifyResultDto = z.infer<typeof LicenseVerifyResultDtoSchema>;

/**
 * One machine's hold on a license seat. `releasedAt` set means the seat was
 * given back (POST /licenses/deactivate, or an operator release) and no
 * longer counts toward `seatsAllowed`; `deviceId` is the Device the same
 * fingerprint resolved to under the license holder, when one exists.
 */
export const LicenseActivationDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  licenseId: z.string(),
  machineFingerprint: z.string(),
  label: z.string().nullable(),
  deviceId: z.string().nullable(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable(),
});
export type LicenseActivationDto = z.infer<typeof LicenseActivationDtoSchema>;

/**
 * Result of POST /api/v1/licenses/deactivate. Always HTTP 200; branch on
 * `ok`, like verify. `released: false` on `ok: true` means the machine held
 * no seat (idempotent).
 */
export const LicenseDeactivateResultDtoSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), released: z.boolean() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['unknown', 'wrong_application', 'revoked', 'expired']),
  }),
]);
export type LicenseDeactivateResultDto = z.infer<typeof LicenseDeactivateResultDtoSchema>;

/** Body of POST /api/v1/licenses/deactivate. */
export const LicenseDeactivateRequestSchema = z.object({
  key: z.string().min(1).max(256),
  machineFingerprint: z.string().min(1).max(256),
});
export type LicenseDeactivateRequest = z.infer<typeof LicenseDeactivateRequestSchema>;

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
   * returning it raw, which is what it used to do, so `applicationId` and
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

/**
 * A usage meter as an integrator sees it (`GET /api/v1/usage/meters`): the
 * slug to record against and what one unit costs past the included quota.
 */
export const UsageMeterCatalogueEntryDtoSchema = z.object({
  id: z.string(),
  /** What `POST /usage/record` takes as `meterSlug`. */
  slug: z.string(),
  name: z.string(),
  /** What one unit counts, e.g. `calls`, `tokens`. */
  unit: z.string(),
  /** An inactive meter refuses records with `USAGE_METER_INACTIVE`. */
  active: z.boolean(),
  /**
   * Fallback credits charged per unit past a subscriber's included quota, for
   * a subscriber whose plan does not price this meter. Null: no fallback.
   */
  creditsPerUnit: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});
export type UsageMeterCatalogueEntryDto = z.infer<typeof UsageMeterCatalogueEntryDtoSchema>;

/**
 * One meter's standing for one subject in the current quota period. Computed
 * by the same code `POST /usage/record` enforces with, so `remaining` is what
 * the next record will be measured against.
 */
export const UsageMeterRemainingDtoSchema = z.object({
  meterSlug: z.string(),
  name: z.string(),
  unit: z.string(),
  active: z.boolean(),
  /**
   * Units the subject's plans include this period. Null: the subject has no
   * quota for this meter, so records are neither capped nor charged.
   */
  included: z.number().int().nullable(),
  /** Units recorded for this subject in the current period. */
  used: z.number().int(),
  /**
   * `max(0, included - used)`, or null when `included` is null. A record of
   * more than this is refused with 402 `USAGE_QUOTA_EXCEEDED` when
   * `creditsPerUnit` is null, and charged in credits past it otherwise.
   */
  remaining: z.number().int().nullable(),
  /**
   * Credits charged per unit past the quota, the rate `record` would apply
   * (the subject's plan rate, else the meter's). Null: past the quota is
   * refused, not charged. Always null when `included` is null.
   */
  creditsPerUnit: z.number().int().nullable(),
  /** Start of the quota period (inclusive): the first instant of the calendar month, UTC. */
  periodStart: z.string().datetime(),
  /** End of the quota period (exclusive): the first instant of the next calendar month, UTC. */
  periodEnd: z.string().datetime(),
});
export type UsageMeterRemainingDto = z.infer<typeof UsageMeterRemainingDtoSchema>;

/** `data` of `GET /api/v1/usage/remaining` and `GET /api/v1/usage/remaining/for-user`. */
export const UsageRemainingDtoSchema = z.object({
  /** Whose quota this is. Exactly one of the two is set. */
  endUserId: z.string().nullable(),
  organizationId: z.string().nullable(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  /** One entry per meter, oldest first, or just the one asked for with `?meter=`. */
  meters: z.array(UsageMeterRemainingDtoSchema),
  /** How many meters the Application has (1 with `?meter=`). */
  totalMeters: z.number().int(),
  /**
   * True when `meters` stops short of `totalMeters`: an unfiltered read reports
   * the first 200 meters. Read the rest one at a time with `?meter=`.
   */
  truncated: z.boolean(),
});
export type UsageRemainingDto = z.infer<typeof UsageRemainingDtoSchema>;

// ============================================================================
// Outbound webhooks, the events Rekey POSTs to YOUR app
// ============================================================================
//
// This registry mirrors the API's `KNOWN_WEBHOOK_EVENTS`
// (apps/api/src/modules/webhooks/events.ts) exactly, same names, same order.
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
      'An end-user account was created: sign-up, first OAuth or magic-link sign-in, an operator, an import, or a billing sale. `data.via` says which.',
  },
  {
    name: 'user.updated',
    description:
      "An end-user's role, metadata or verified flag changed. `data.changed` names the fields.",
  },
  {
    name: 'user.onboarding_completed',
    description:
      'An end-user finished onboarding: every profile field marked required was answered and onboarding was ' +
      'marked complete. Sent once per user. Payload: `data.userId`, `completedAt`, `via` (`self`, `server` or `operator`).',
  },
  {
    name: 'user.onboarding_skipped',
    description:
      'An end-user skipped onboarding. Sent once per user, and never once onboarding was completed. Rekey records ' +
      'the skip and gates nothing on it. Payload: `data.userId`, `skippedAt`, `via` (`self`, `server` or `operator`).',
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
    name: 'user.banned',
    description:
      'An operator banned an end-user: every session and grant was ended and every sign-in is refused with END_USER_BANNED until the ban is lifted. Subscriptions are not touched. Payload: `data.user` with `id` + `bannedAt`, and `data.sessionsRevoked`. The operator\'s reason is never included.',
  },
  {
    name: 'user.unbanned',
    description:
      'An operator lifted an end-user\'s ban. They can sign in again; sessions the ban ended stay ended. Payload: `data.user` with `id` + `bannedAt: null`.',
  },
  {
    name: 'session.created',
    description:
      'An end-user signed in and a session was minted: password (including sign-up), magic link, OAuth, passkey, or MFA completion. Never sent for a refresh or an organization switch. Payload: `data.userId`, `sessionId`, `deviceId`, `via`, `firstSignIn` (true for the first session the user ever gets), `platform` and `country` (CF-IPCountry, null when unknown).',
  },
  {
    name: 'session.revoked',
    description:
      'An end-user session (refresh token) was revoked, sign-out, per-session revoke, or kill-switch.',
  },
  {
    name: 'mfa.enabled',
    description:
      'The end-user enabled a second factor, TOTP enrollment confirmed, or a passkey was registered.',
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
  // Billing lifecycle, emitted from the provider inbound-webhook handlers when
  // LOCAL state actually transitions (a provider-event replay that changes
  // nothing emits nothing). A provider retry after a 5xx on Rekey's side may
  // still re-emit; consumers must dedupe on the envelope's `eventId`.
  //
  // Every `subscription.*` payload carries `data.subscription.entitlements`,
  // what THAT subscription grants, with its per-subscription overrides applied.
  // Act on it rather than on the plan slug: two subscribers on one plan can
  // hold different quantities, and the slug cannot tell you so. The field is
  // ABSENT when Rekey could not resolve it; that is "unknown", never "grants
  // nothing", so leave your provisioning as it is and re-read it later.
  {
    name: 'subscription.activated',
    description:
      'A provider webhook transitioned a Subscription to ACTIVE. Payload: `data.subscription` with ids, plan slug/name/kind, amount/currency/interval, the resolved `entitlements` array (absent if it could not be resolved, which does not mean empty), and period end.',
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
    name: 'subscription.entitlements_updated',
    description:
      'What a Subscription GRANTS changed without its status changing, an operator wrote ' +
      '`entitlementOverrides` on it. Emitted only when the resolved entitlements actually ' +
      'differ, so a no-op write announces nothing, and never sent when they could not be ' +
      'resolved, since the grant is the whole message. Payload: `data.subscription`, identical in ' +
      'shape to `subscription.activated`, with `entitlements` already merged. Subscribe to this ' +
      'if you project entitlements onto state of your own: a status-only subscription will ' +
      'never hear about a bespoke deal being adjusted.',
  },
  {
    name: 'subscription.trial_started',
    description:
      'A Subscription entered TRIALING. Payload: `data.subscription`, the `subscription.activated` shape, with `trialEndsAt`.',
  },
  {
    name: 'subscription.trial_will_end',
    description:
      'A TRIALING Subscription reaches its trial end within 3 days. Sent once per subscription and trial end date (again if the trial is re-dated). Payload: `data.subscription` with `trialEndsAt`.',
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
  {
    name: 'payment.refunded',
    description:
      'A refund was recorded against a payment, whoever started it: the provider, or an operator through Rekey. Payload: `data.payment` (its `refundedAmount` is the running total and `status` is PARTIALLY_REFUNDED or REFUNDED) and `data.refund` with this one refund\'s id, amount, currency, status and `providerRefundId`. One event per refund.',
  },
  // Dunning lifecycle, a "case" tracks one subscription's trip through
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
      'A later successful payment / reactivation recovered a PAST_DUE subscription, its dunning case closed as RECOVERED. Payload: `data.dunningCase`.',
  },
  {
    name: 'dunning.case_exhausted',
    description:
      'No recovery within 14 days, the dunning case closed as EXHAUSTED and the subscription was canceled (a `subscription.canceled` event accompanies this). Payload: `data.dunningCase`.',
  },
  // Devices, the machines an end-user signs in from. Payloads carry
  // `data.device` (id, endUserId, fingerprint, label, status, timestamps)
  // except `device.limit_reached`, which has no row to describe.
  {
    name: 'device.registered',
    description:
      'A device was registered for an end-user: a new fingerprint at sign-in or refresh, or a previously released device coming back (`data.reactivated`). A sign-in from an already-active device emits nothing; licence verification registers nothing. Payload: `data.device`.',
  },
  {
    name: 'device.released',
    description:
      'A device gave its slot back (the end-user, an operator, or the application server released it) and every session minted on it was revoked (`data.sessionsRevoked`). Payload: `data.device`, `data.releasedBy` (`end_user` | `operator` | `server`).',
  },
  {
    name: 'device.blocked',
    description:
      'An operator blocked a device: sign-in from that fingerprint is refused until it is unblocked, and its sessions were revoked. Payload: `data.device`, `data.sessionsRevoked`.',
  },
  {
    name: 'device.unblocked',
    description:
      'An operator lifted a block. The device comes back as RELEASED and takes a slot again only on its next sign-in, subject to the limit. Payload: `data.device`.',
  },
  {
    name: 'device.limit_reached',
    description:
      'A new device was refused because the end-user is at their `max_devices` entitlement. Payload: `data.endUserId`, `data.limit`, the refused `data.fingerprint`, and `data.devices`, the active devices filling the cap, so you can prompt the user to release one.',
  },
  {
    name: 'license.deactivated',
    description:
      'A machine gave back its seat on a license: the customer\'s software called POST /licenses/deactivate, or an operator released the activation (`data.releasedBy`). Payload: `data.license` (id, endUserId, kind) and `data.machineFingerprint`.',
  },
  // Credits. One event per ledger entry, written in the transaction that wrote
  // the entry, so a balance change and its event commit together or not at
  // all. Every payload is `data.credit` (see `CreditWebhookData`) with the
  // signed `delta` and the `balance` after it, so a mirror can apply all three
  // the same way. An idempotent replay writes no entry and emits nothing.
  {
    name: 'credit.granted',
    description:
      'Credits were added to an end-user or organization: an operator or Application-key grant, a refund, or a credit-pack purchase or plan provisioning (`data.credit.reason`). Payload: `data.credit` with entryId, endUserId or organizationId, delta, amount, reason, balance (after), idempotencyKey, description, createdAt.',
  },
  {
    name: 'credit.consumed',
    description:
      'Credits were drawn down (`POST /credits/consume`, or usage recorded past an included quota on a priced meter). Fires once per ledger entry and never for a refused (402) or replayed call. Payload: `data.credit`, `delta` negative.',
  },
  {
    name: 'credit.adjusted',
    description:
      'An operator corrected a balance: reason ADJUST in either direction, or any other operator entry that removes credits (`data.credit.delta` carries the sign). Separate from `credit.consumed` so a correction is never read as usage. Payload: `data.credit`.',
  },
  {
    name: 'organization.invitation.created',
    description:
      'An end-user organization invitation was created. Payload: `data.invitation` with id, organizationId, email, role, invitedById, expiresAt, createdAt. Never the invitation token.',
  },
  {
    name: 'organization.invitation.accepted',
    description:
      'An organization invitation was accepted, once per invitation. Payload: `data.invitation` (id, organizationId, email, role, acceptedAt) and `data.membership` (id, organizationId, endUserId, role).',
  },
  {
    name: 'contact.subscribed',
    description:
      'Someone joined a list: a first subscribe, or a secret-key subscribe with consent that added back a person who had left. Never sent for a repeat that changed nothing. Payload: `data.contact` (id, email, name), `data.list` (id, key), `data.member` (status, source, consentVersion, consentAt).',
  },
  {
    name: 'contact.unsubscribed',
    description:
      'Someone left a list: a server called DELETE /lists/:key/members/:email, or an operator took them off in the panel. Sent once per change. Payload: `data.contact` (id, email, name), `data.list` (id, key), `data.member` (status, unsubscribedAt).',
  },
  {
    name: 'contact.submission.created',
    description:
      'A subscribe carried `fields` and they were stored, for example a contact form message. Payload: `data.contact` (id, email), `data.list` (id, key), `data.submission` (id, fields, createdAt). Erasing the contact scrubs stored deliveries of this event.',
  },
  {
    name: 'email.unsubscribed',
    description:
      'A recipient left notification email: a one-click unsubscribe, or PATCH /users/:id/email-preferences set a topic to unsubscribed. Sent once per change. Payload: `data.address`, `data.endUserId` (when the address belongs to an end user), `data.category` (`notification`) and `data.topic` (absent when they left every notification email).',
  },
  {
    name: 'support.opened',
    description:
      'An operator opened a support case on an end-user, putting the account in support mode. Payload: `data.user.id` and `data.support` (caseId, active, capabilities, scope, deviceIds, since, updatedAt). The reason and the operator are never sent.',
  },
  {
    name: 'support.updated',
    description:
      'The capabilities or devices of an open support case changed: an operator edited it, or a device it named was released or blocked. Payload: `data.user.id` and `data.support`, the full state after the change.',
  },
  {
    name: 'support.closed',
    description:
      'A support case closed and its capabilities stopped being reported. Payload: `data.user.id` and `data.support` with `active: false`, `capabilities: []` and `closedCause` (`operator` | `banned` | `erased` | `device_released`).',
  },
] as const;

/**
 * Union of every outbound webhook event name this SDK version ships in its
 * registry (e.g. `'user.created'`). Closed, it IS the registry.
 */
export type KnownWebhookEventType = (typeof WEBHOOK_EVENTS)[number]['name'];

/**
 * {@link Open}. What actually arrives on the wire: a deployment one minor
 * version ahead sends events this SDK's registry does not list, so
 * `WebhookEventEnvelope.type` is this and your `switch` needs a default branch.
 * Narrow to the closed set with {@link isKnownWebhookEvent}.
 */
export type WebhookEventType = Open<KnownWebhookEventType>;

/** Just the event names, in registry order, mirrors the API's KNOWN_WEBHOOK_EVENTS. */
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
 * consumer-side idempotency key, retries (ours or a provider-triggered
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

/** A registered outbound webhook endpoint (no secret, that is shown once at create/rotate). */
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

/** One delivery attempt row, GET .../webhooks/:endpointId/deliveries. */
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
// Tenant / operator DTOs, payloads of the operator API under /api/v1/tenant/*
// ============================================================================
//
// These endpoints authenticate with an operator PANEL SESSION (tenant JWT),
// not an Application secret key, so the end-user SDKs (@rekey.dev/node etc.)
// deliberately do NOT expose them. The shapes live here so the panel, agents,
// and any session-bearing automation share one definition.

export const PaymentStatusSchema = z.enum([
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUNDED',
  // Part of the charge went back and part did not. Distinct from REFUNDED
  // because the buyer still holds some of the money and the operator can
  // still refund the rest.
  'PARTIALLY_REFUNDED',
]);
/** The payment statuses this SDK version knows about. Closed, use it for registries. */
export type KnownPaymentStatus = z.infer<typeof PaymentStatusSchema>;
/** {@link Open}. */
export type PaymentStatusType = Open<KnownPaymentStatus>;

/**
 * A payment as its operator reads it: one row of
 * `GET /api/v1/tenant/applications/:id/payments`, and the whole of
 * `GET /api/v1/tenant/applications/:id/payments/:paymentId`.
 *
 * @example
 * { id: 'pay_1', endUserId: 'eu_1', subscriptionId: 'sub_1', amount: 1900, currency: 'USD',
 *   status: 'SUCCEEDED', refundedAmount: 0, verification: 'verified', provider: 'stripe',
 *   refundable: true, refundBlockedReason: null, providerPaymentId: 'in_1', description: null,
 *   createdAt: '2026-10-12T09:00:00.000Z', endUserEmail: 'buyer@example.com' }
 */
export const TenantPaymentDtoSchema = z.object({
  id: z.string(),
  endUserId: z.string().nullable().describe('The paying end user, when the payment is attributable to one.'),
  subscriptionId: z.string().nullable().describe('The subscription the payment was applied to. Null for a payment recorded and not applied.'),
  /** Smallest currency unit (cents/paise/sen). Always integer. */
  amount: z.number().int().describe('Smallest currency unit (cents/paise/sen). Always integer.'),
  currency: z.string().describe('Upper-case ISO 4217.'),
  status: PaymentStatusSchema.describe('PENDING, SUCCEEDED, FAILED, PARTIALLY_REFUNDED or REFUNDED.'),
  /** The sum of this payment's refunds that have not failed, smallest unit of `currency`. 0 when nothing was refunded. */
  refundedAmount: z.number().int().describe('The sum of this payment\'s refunds that have not failed, smallest unit of `currency`. 0 when nothing was refunded.'),
  /** `unverified` for a charge recorded and not applied. It is in no revenue figure. */
  verification: z
    .enum(['verified', 'unverified'])
    .describe('`unverified` for a charge that was recorded and not applied: it matched no subscription, or not the price it was for. It is in no revenue figure.'),
  /** The provider that took the payment, as a refund would reach it. Null when Rekey has no record of one. */
  provider: z
    .string()
    .nullable()
    .describe('The provider that took the payment: the one recorded on the payment, else on its unapplied case, else on its subscription. Null when Rekey has no record of one.'),
  /** Whether `POST .../payments/:paymentId/refunds` would ask the provider for money back. */
  refundable: z
    .boolean()
    .describe('Whether a refund request for this payment would reach its provider. The provider can still refuse one.'),
  /** Why not. Null exactly when `refundable` is true. */
  refundBlockedReason: RefundBlockedReasonSchema.nullable().describe(
    'Why the payment cannot be refunded through Rekey: `payment_not_succeeded`, `no_provider_charge_id`, `already_refunded`, `provider_unknown`, `provider_cannot_refund` or `provider_not_configured`. Null exactly when `refundable` is true.',
  ),
  providerPaymentId: z.string().nullable().describe('The provider\'s id for the charge.'),
  description: z.string().nullable().describe('The provider\'s description of the charge, when it sent one.'),
  createdAt: z.string().datetime(),
  /** Joined from the paying end-user, when the payment is attributable to one. */
  endUserEmail: z.string().nullable().describe('Joined from the paying end-user, when the payment is attributable to one.'),
});
export type TenantPaymentDto = Omit<z.infer<typeof TenantPaymentDtoSchema>, 'status'> & {
  /** {@link Open}, always give your `switch` a default branch. */
  status: PaymentStatusType;
};

/** Query params of GET /api/v1/tenant/applications/:id/payments. */
export interface TenantPaymentsListQuery {
  /** Closed on purpose, this is a filter you SEND, so only real statuses are valid. */
  status?: KnownPaymentStatus;
  /** Inclusive createdAt window, ISO date-times. */
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
  month: z.string().describe('`YYYY-MM`, UTC.'),
  amountCents: z.number().int().describe('Verified payments of the month net of refunds, minor units of the row\'s currency.'),
});
export type MonthlyRevenuePoint = z.infer<typeof MonthlyRevenuePointSchema>;

/** MRR in one currency. A yearly price counts as a twelfth, rounded down per subscription. */
export const CurrencyMrrDtoSchema = z.object({
  /** Upper-case ISO 4217. */
  currency: z.string().describe('Upper-case ISO 4217.'),
  /** Smallest unit of `currency`. */
  mrrCents: z.number().int().describe('Smallest unit of `currency`.'),
  activeSubscriptions: z.number().int().describe('ACTIVE recurring subscriptions priced in this currency.'),
});
export type CurrencyMrrDto = z.infer<typeof CurrencyMrrDtoSchema>;

/** Payments of one period in one currency. `netCents` is `grossCents` less `refundedCents`. */
export const CurrencyRevenueDtoSchema = z.object({
  /** Upper-case ISO 4217. */
  currency: z.string().describe('Upper-case ISO 4217.'),
  /** What succeeded and partly refunded payments charged, smallest unit of `currency`. */
  grossCents: z.number().int().describe('What succeeded and partly refunded payments charged, smallest unit of `currency`.'),
  /** What has been refunded on those payments, counted against the payment's own date. */
  refundedCents: z.number().int().describe('What has been refunded on those payments, counted against the payment\'s own date.'),
  netCents: z.number().int().describe('`grossCents` less `refundedCents`.'),
  payments: z.number().int().describe('How many payments the row counts.'),
});
export type CurrencyRevenueDto = z.infer<typeof CurrencyRevenueDtoSchema>;

/**
 * Money a provider charged that Rekey recorded and did not apply, in one
 * currency: a charge that matched no subscription, or not the price it was
 * for. It is never part of revenue or MRR. Net of what has been refunded.
 */
export const CurrencyUnverifiedDtoSchema = z.object({
  /** Upper-case ISO 4217. */
  currency: z.string().describe('Upper-case ISO 4217.'),
  /** Smallest unit of `currency`. */
  amountCents: z.number().int().describe('Smallest unit of `currency`.'),
  payments: z.number().int().describe('How many unverified payments are still held in this currency.'),
});
export type CurrencyUnverifiedDto = z.infer<typeof CurrencyUnverifiedDtoSchema>;

/**
 * GET /api/v1/tenant/applications/:id/billing/stats, the Billing Overview
 * tiles. Money is reported per currency and never added across currencies:
 * every list has one entry per currency, the Application's reporting currency
 * first (present even at zero) and the others by code. There is no converted
 * total. MRR counts ACTIVE subscriptions on recurring SUBSCRIPTION plans, each
 * at its own price. Revenue counts verified payments only.
 */
export const BillingStatsDtoSchema = z.object({
  activeSubscriptions: z.number().int().describe('Subscriptions that are ACTIVE now.'),
  pastDueSubscriptions: z.number().int().describe('Subscriptions that are PAST_DUE now.'),
  /** Subscriptions whose cancellation landed in the last 30 days. */
  canceledLast30d: z.number().int().describe('Subscriptions whose cancellation landed in the last 30 days.'),
  /** Subscriptions created in the last 30 days (any status). */
  newSubscriptionsLast30d: z.number().int().describe('Subscriptions created in the last 30 days (any status).'),
  /** Live subscriptions (ACTIVE, TRIALING or PAST_DUE) with no price of their own, on a plan that has a flat price. Each reports `price: null` and is not counted in `mrr`. It should be zero: only a subscription to a plan with no flat price goes without one. */
  unpricedLiveSubscriptions: z.number().int().describe('Live subscriptions (ACTIVE, TRIALING or PAST_DUE) with no price of their own, on a plan that has a flat price. Each reports `price: null` and is not counted in `mrr`. It should be zero: only a subscription to a plan with no flat price goes without one.'),
  /** `billingConfig.reportingCurrency`: the first entry of every list below. */
  reportingCurrency: z.string().describe('`billingConfig.reportingCurrency`: the first entry of every list below.'),
  mrr: z.array(CurrencyMrrDtoSchema).describe('Monthly recurring revenue, one entry per currency, the reporting currency first. Counts ACTIVE subscriptions at their own price; one with no price of its own is not counted (see `unpricedLiveSubscriptions`).'),
  /** Verified payments, net of refunds. A refund counts against the day of the payment it refunds. */
  revenueLast30d: z.array(CurrencyRevenueDtoSchema).describe('Verified payments, net of refunds. A refund counts against the day of the payment it refunds.'),
  /**
   * Unverified payments still held, of any age: only the currencies that have
   * some, the reporting currency first. Empty when every charge was applied.
   */
  unverified: z.array(CurrencyUnverifiedDtoSchema).describe('Unverified payments still held, of any age: only the currencies that have some, the reporting currency first. Empty when every charge was applied.'),
  /**
   * Counts of every payment recorded in the last 30 days, across every
   * currency, verified or not. A fully refunded payment is in neither.
   */
  paymentsLast30d: z.object({
    succeeded: z.number().int().describe('Payments recorded as succeeded, partly refunded ones included, whether verified or not.'),
    failed: z.number().int().describe('Payments recorded as failed.'),
  }).describe('Counts of every payment recorded in the last 30 days, across every currency, verified or not: `succeeded` counts succeeded and partly refunded payments, including unverified ones that are not in `revenueLast30d`; `failed` counts every failed charge. A fully refunded payment is in neither.'),
  /** Per currency, the last 12 UTC calendar months (oldest first), gap-filled with zeroes: verified payments, net of refunds. */
  monthlyRevenue: z
    .array(
      z.object({
        currency: z.string().describe('Upper-case ISO 4217.'),
        months: z.array(MonthlyRevenuePointSchema).describe('Twelve points, oldest first.'),
      }),
    )
    .describe('Per currency, the last 12 UTC calendar months (oldest first), gap-filled with zeroes: verified payments, net of refunds.'),
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
  /** Set while an operator has banned this end-user. */
  bannedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  /** Last credential sign-in. Null if the user never signed in. */
  lastSignedInAt: z.string().datetime().nullable().optional(),
  /** Platform of the latest sign-in. Null if never. */
  lastPlatform: z.string().nullable().optional(),
  /** Profile answers, keyed by field key. */
  profile: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** `completed`, `skipped` or `pending`. Recorded only: Rekey gates nothing on it. */
  onboardingStatus: z.enum(ONBOARDING_STATUSES).optional(),
});
export type TenantEndUserDto = z.infer<typeof TenantEndUserDtoSchema>;

/** Query params of GET /api/v1/tenant/applications/:id/end-users. */
export interface TenantEndUsersListQuery {
  /** Substring match on email (lowercased server-side). */
  search?: string;
  /** `true`: only banned end-users; `false`: only the rest. */
  banned?: boolean;
  emailVerified?: boolean;
  /** Only users holding at least one subscription with this status. Closed, you SEND this. */
  subscriptionStatus?: KnownSubscriptionStatus;
  /** Default `createdAt`. `lastSignedInAt` puts users who never signed in last, either order. */
  sort?: 'createdAt' | 'email' | 'lastSignedInAt';
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
 * `format: 'csv'` returns a downloadable CSV instead of JSON, the CSV path
 * ignores limit/offset and is capped at 5000 newest rows server-side.
 */
export interface SecurityEventsListQuery {
  applicationId?: string;
  /** Event type filter, e.g. `app.api_key.created`. */
  type?: string;
  actorType?: SecurityEventActorType;
  /** Inclusive createdAt window, ISO date-times. */
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
// server-side; see `notes` in the document. Plain interfaces (no Zod), this
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
   * threshold (10), the documented floor on what tripped the lock, not a
   * surviving count. Below the threshold this is the live counter.
   */
  failedSignInAttempts: number;
  /**
   * When the current sign-in lockout expires, or `null` when not locked.
   * Reconstructed from the lock's remaining TTL, so it moves with the limiter
   * instead of being a snapshot.
   */
  lockedUntil: string | null;
  /** When an operator banned this person, or `null`. The operator's reason is never exported. */
  bannedAt: string | null;
  /** Profile answers, keyed by field key. */
  profile: EndUserProfile;
  onboardingCompletedAt: string | null;
  onboardingSkippedAt: string | null;
  /** How the account was created; null when it predates the record. */
  createdVia: string | null;
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
    interval: PlanIntervalType;
  };
  /**
   * What this subscription costs: the price its checkout, grant or import
   * fixed. Null when the subscription has no price of its own.
   */
  price: { amount: number; currency: string } | null;
}

/** The full DSAR document. `exportVersion` is 2 today; bumps on shape changes. */
export interface EndUserExportDocument {
  exportVersion: number;
  exportedAt: string;
  applicationId: string;
  /** Human-readable caveats, section caps, what is excluded, etc. */
  notes: string[];
  endUser: EndUserExportProfile;
  oauthIdentities: Array<{
    id: string;
    provider: string;
    providerAccountId: string;
    email: string | null;
    createdAt: string;
  }>;
  /** Session METADATA only, never token material. Capped (newest first). */
  sessions: EndUserExportSession[];
  /** MFA enrollment metadata only, never secrets/backup codes. */
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
  /** License metadata, keyPrefix only, never the key hash. */
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
  /** Capped (newest first), `notes` flags when the cap was hit. */
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
  /**
   * Every support case opened on this user, open or closed. The operator's
   * reason is left out, as a ban's is.
   */
  supportCases: Array<{
    id: string;
    status: 'OPEN' | 'CLOSED';
    capabilities: string[];
    scope: 'USER' | 'DEVICES';
    deviceIds: string[];
    openedAt: string;
    updatedAt: string;
    closedAt: string | null;
    closedCause: SupportCaseClosedCause | null;
  }>;
  /**
   * The billing log's events about this user: checkouts opened, refused and
   * completed, payments, refunds and what their subscriptions did. `data` is
   * shaped per `type` by `BillingEventSchema`. The id of whoever acted is
   * left out.
   */
  billingEvents: Array<{
    id: string;
    type: string;
    occurredAt: string;
    actorType: string;
    subscriptionId: string | null;
    checkoutSessionId: string | null;
    paymentId: string | null;
    refundId: string | null;
    planId: string | null;
    planPriceId: string | null;
    couponId: string | null;
    provider: string | null;
    currency: string | null;
    amount: number | null;
    data: unknown;
  }>;
  /**
   * The contact at this user's address, with every list they joined and what
   * they submitted. Empty when the address is on no list.
   */
  contacts: EndUserExportContact[];
}

/** A contact inside a DSAR export: list memberships with their consent proof, and submissions. */
export interface EndUserExportContact {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  memberships: Array<{
    listKey: string;
    listName: string;
    status: string;
    source: string;
    consentVersion: number | null;
    /** The exact text of `consentVersion`, when the list had one. */
    consentText: string | null;
    consentAt: string | null;
    consentIpPrefix: string | null;
    sourceUrl: string | null;
    unsubscribedAt: string | null;
    createdAt: string;
  }>;
  submissions: Array<{ listKey: string; fields: Record<string, unknown>; createdAt: string }>;
}

// ============================================================================
// Billing log readers, reporting currency and the routing preview.
// ============================================================================

export {
  BILLING_LOG_DEFAULT_LIMIT,
  BILLING_LOG_ENTRY_TYPES_COMPLETE,
  BILLING_LOG_INCLUDES,
  BILLING_LOG_MAX_LIMIT,
  BillingLogActorsSchema,
  BillingLogEndUserSchema,
  BillingLogOperatorSchema,
  BillingLogEntrySchema,
  BillingLogPageSchema,
  BillingLogQuerySchema,
  BillingOutboxStatusSchema,
  BillingOutboxStuckRowSchema,
  PriceFallbackGroupSchema,
  PriceFallbackSummarySchema,
  RECONCILIATION_MAX_FINDINGS,
  ReconciliationFindingSchema,
  ReconciliationReportSchema,
  type BillingLogEntry,
  type BillingLogActors,
  type BillingLogEndUser,
  type BillingLogInclude,
  type BillingLogOperator,
  type BillingLogPage,
  type BillingLogQuery,
  type BillingOutboxStatus,
  type PriceFallbackSummary,
  type ReconciliationFinding,
  type ReconciliationReport,
} from './billing-log.js';

/** `GET` and `PUT /tenant/applications/:id/billing/reporting-currency`. */
export const ReportingCurrencyDtoSchema = z.object({
  /** Upper-case ISO 4217. */
  reportingCurrency: z.string().describe('Upper-case ISO 4217.'),
  /** The currency's English name, such as "US Dollar". */
  name: z.string().describe('The currency\'s English name, such as "US Dollar".'),
});
export type ReportingCurrencyDto = z.infer<typeof ReportingCurrencyDtoSchema>;

export const SetReportingCurrencyRequestSchema = z
  .object({ reportingCurrency: z.string().regex(/^[A-Za-z]{3}$/) })
  .strict();
export type SetReportingCurrencyRequest = z.infer<typeof SetReportingCurrencyRequestSchema>;

export const ROUTING_PROVIDER_REASONS = ['bound', 'named', 'country', 'only_capable', 'priority'] as const;

/**
 * `POST /tenant/applications/:id/billing/checkout/preview`: which price and
 * provider a buyer in `country` would get, without opening a checkout.
 *
 * @example
 * RoutingPreviewRequestSchema.parse({ country: 'IN', plan: 'pro' });
 */
export const RoutingPreviewRequestSchema = z
  .object({
    country: z.string().regex(/^[A-Za-z]{2}$/),
    /** A plan's id or slug. Left out, every active plan is previewed. */
    plan: z.string().min(1).max(200).optional(),
    /**
     * How the checkout would learn the country, which also says who opens it.
     * `vouched`: a browser, with the country taken from a trusted proxy.
     * `hint`: a browser that states its own country, which selects a local
     * price only when local prices are open to any buyer. `declared`: the
     * operator's server, with the secret key.
     */
    countrySource: z.enum(['declared', 'vouched', 'hint']).default('vouched'),
    /** An end user, to preview what they would get given what they already pay for. */
    endUserId: z.string().min(1).max(64).optional(),
    /** A currency the server would name. Only a `declared` preview may name one, as at checkout. */
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    /** What the previewed checkout would send. Left out, the Application's `billingConfig.onUnavailableCurrency` applies, as at checkout. */
    onUnavailableCurrency: z.enum(['fallback', 'refuse']).optional(),
    /** A provider the checkout would name. */
    provider: z.string().min(1).max(40).optional(),
    /** A coupon code the checkout would carry. Each item then says what it takes off, or why it is refused. */
    couponCode: z.string().min(1).max(64).optional(),
  })
  .strict();
export type RoutingPreviewRequest = z.infer<typeof RoutingPreviewRequestSchema>;

const RoutingPreviewRefusalSchema = z.object({
  code: z.string().describe('The error code checkout would answer with.'),
  message: z.string().describe('What is wrong, for a person.'),
  fix: z.string().nullable().describe('How to repair it, when there is a repair.'),
});

/**
 * What the previewed coupon does to one plan's price. Exactly one of
 * `discount` and `refusal` is set. A checkout carrying a refused coupon is
 * itself refused, with this error.
 */
export const RoutingPreviewCouponSchema = z.object({
  /** The code as stored when the coupon exists, as sent otherwise. */
  code: z.string().describe('The code as stored when the coupon exists, as sent otherwise.'),
  discount: z
    .object({
      /** Upper-case ISO 4217: the currency charged. */
      currency: z.string().describe('Upper-case ISO 4217: the currency charged.'),
      /** Smallest unit of `currency`. */
      discountAmount: z.number().int().describe('Smallest unit of `currency`.'),
      amountAfterDiscount: z.number().int().describe('What the buyer would pay, smallest unit of `currency`.'),
      formatted: z
        .object({
          discount: z.string().describe('`discountAmount` written for a person.'),
          total: z.string().describe('`amountAfterDiscount` written for a person.'),
        })
        .describe('`discountAmount` and `amountAfterDiscount` written for a person.'),
    })
    .nullable().describe('What the coupon takes off the price charged. Null when the coupon is refused.'),
  refusal: RoutingPreviewRefusalSchema.nullable().describe('The error a checkout carrying this coupon would answer with. Null when the coupon applies.'),
});
export type RoutingPreviewCoupon = z.infer<typeof RoutingPreviewCouponSchema>;

export const RoutingPreviewItemSchema = z.object({
  plan: z
    .object({
      id: z.string(),
      slug: z.string().describe('The plan slug.'),
      name: z.string().describe('Display name.'),
      kind: z.string().describe('SUBSCRIPTION, LICENSE, USAGE or CREDIT.'),
    })
    .describe('The plan previewed.'),
  /** The price checkout would charge. Null for a plan with no flat price, and when checkout would refuse. */
  price: ResolvedPriceDtoSchema.nullable().describe('The price checkout would charge. Null for a plan with no flat price, and when checkout would refuse.'),
  /** Set when the price selected first cannot be charged and the default price is charged instead. */
  priceFallback: PriceFallbackDtoSchema.nullable().describe('Set when the price selected first cannot be charged and the default price is charged instead.'),
  /** The provider that would charge. Null when checkout would refuse. */
  provider: z.string().nullable().describe('The provider that would charge. Null when checkout would refuse.'),
  /**
   * Why that provider: the buyer is already `bound` to it, the caller `named`
   * it, it lists the buyer's `country`, it is the `only_capable` one for the
   * currency, or it has the best `priority` among those that can charge.
   */
  providerReason: z.enum(ROUTING_PROVIDER_REASONS).nullable().describe('Why that provider: the buyer is already `bound` to it, the caller `named` it, it lists the buyer\'s `country`, it is the `only_capable` one for the currency, or it has the best `priority` among those that can charge.'),
  /** The refusal checkout would answer with, when it would refuse whatever the coupon. */
  refusal: RoutingPreviewRefusalSchema.nullable().describe('The refusal checkout would answer with, when it would refuse whatever the coupon.'),
  /** Null when the request named no coupon, and when `refusal` is set. */
  coupon: RoutingPreviewCouponSchema.nullable().describe('Null when the request named no coupon, and when `refusal` is set.'),
  /** One sentence for a person: who pays what, through whom, and why. */
  summary: z.string().describe('One sentence for a person: who pays what, through whom, and why.'),
});
export type RoutingPreviewItem = z.infer<typeof RoutingPreviewItemSchema>;

export const RoutingPreviewDtoSchema = z.object({
  country: z.string().describe('The country previewed, upper-case ISO 3166-1 alpha-2.'),
  countrySource: z.enum(['declared', 'vouched', 'hint']).describe('How the previewed checkout would learn the country.'),
  /** The Application's rule for local prices, which decides what a `hint` can select. */
  localPrices: z.enum(['trusted', 'any']).describe('The Application\'s rule for local prices, which decides what a `hint` can select.'),
  /** The rule this preview applied to a named `currency` nobody can charge: the request's own, else the Application's default. */
  onUnavailableCurrency: z
    .enum(['fallback', 'refuse'])
    .describe('The rule this preview applied to a named `currency` nobody can charge: the request\'s own, else the Application\'s default.'),
  items: z.array(RoutingPreviewItemSchema).describe('One entry per plan previewed.'),
});
export type RoutingPreviewDto = z.infer<typeof RoutingPreviewDtoSchema>;
