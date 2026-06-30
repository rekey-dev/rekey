/**
 * @relipay/shared-types
 *
 * Zod schemas + TypeScript types shared between the API and the SDKs.
 * Anything serialized over the wire lives here — never duplicate a shape.
 */

import { z } from 'zod';

// ============================================================================
// Errors
// ============================================================================

/**
 * The error envelope every ReliPay API response uses on failure.
 *
 * @example
 * ```ts
 * { code: 'PLAN_NOT_FOUND', message: 'Plan "pro" not found.', fix: 'Run `relipay plans list`.' }
 * ```
 */
export const RelipayErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** Concrete remediation a human or AI agent can act on. */
  fix: z.string().optional(),
  /** Documentation URL for this error code. */
  docs: z.string().url().optional(),
});
/** The error envelope shape (just the data fields). */
export type RelipayErrorShape = z.infer<typeof RelipayErrorSchema>;

/**
 * The canonical SDK error. Both @relipay/node and @relipay/react re-export
 * this class, so `instanceof RelipayError` is consistent across packages.
 * Always carries a stable `code` and, when the server provided one, a concrete
 * `fix` — read `error.fix` first when debugging.
 */
export class RelipayError extends Error implements RelipayErrorShape {
  public readonly code: string;
  public readonly fix: string | undefined;
  public readonly docs: string | undefined;
  /** HTTP status, when the error came from an API response. */
  public readonly statusCode: number | undefined;
  /** Server-assigned request id — share with support to find the log entry. */
  public readonly requestId: string | undefined;

  constructor(error: RelipayErrorShape & { statusCode?: number; requestId?: string }) {
    super(error.message);
    this.name = 'RelipayError';
    this.code = error.code;
    this.fix = error.fix;
    this.docs = error.docs;
    this.statusCode = error.statusCode;
    this.requestId = error.requestId;
  }
}

export const ApiResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data }),
    z.object({ success: z.literal(false), error: RelipayErrorSchema }),
  ]);

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
 *   - `HS256` (default) — per-app derived symmetric key. Only the ReliPay API
 *     can verify; customers round-trip `auth.getCurrentUser()`.
 *   - `RS256` — asymmetric. Tokens carry a `kid` header and verify against the
 *     deployment's public JWKS at `/.well-known/jwks.json`, enabling offline /
 *     edge verification (`verifyAccessToken` in @relipay/node). Refresh tokens,
 *     MFA-challenge tokens, and operator tokens are unaffected.
 */
export const TokenAlgSchema = z.enum(['HS256', 'RS256']);
export type TokenAlg = z.infer<typeof TokenAlgSchema>;

export const AuthConfigSchema = z.object({
  /** Which primary methods are enabled. Empty array = OAuth-only app. */
  methods: z.array(AuthMethodSchema),
  passwordMinLength: z.number().int().min(8).default(8),
  /** Where to send the user after sign-in / sign-up. */
  redirectUrls: z.array(z.string().url()),
  /** If true, organisations / teams are enabled for this application. */
  organizationsEnabled: z.boolean().default(false),
  /**
   * **Legacy** sign-up switch, retained for back-compat. Derived from
   * `signupMode` after parse — do not set both at once. `false` ⇔
   * `signupMode: 'invite_only'`; `true` ⇔ `'public'`. A value of
   * `'secret_only'` still reports `signupEnabled: true` (signup IS enabled,
   * just restricted to secret keys). Prefer reading `signupMode`.
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
   * If true, this Application exposes a hosted MCP (Model Context Protocol)
   * server at `/api/v1/mcp/<slug>`, fronted by a per-app OAuth 2.1
   * authorization server (dynamic client registration + authorization-code +
   * PKCE). End-users authenticate and connect MCP clients (Claude Code,
   * Claude Desktop, …) to access their own account data. Off by default —
   * while off, the MCP + OAuth endpoints 404.
   */
  mcpEnabled: z.boolean().default(false),
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

export const BillingProviderSchema = z.enum(['stripe', 'paypal', 'razorpay']);
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

export const ApplicationDtoSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  slug: z.string(),
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
  /** Short-lived access JWT. Pass via X-Relipay-User-Token. */
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
   * True iff ReliPay sent the email itself (BYO Resend creds or
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
  /** True iff ReliPay sent the email via its transport. */
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
export type PlanKindType = z.infer<typeof PlanKindSchema>;

/** Shape of a LICENSE-kind plan's key. PERPETUAL = never expires; TIMED = N-day; SEATS = capped activations. */
export const LicenseKindSchema = z.enum(['PERPETUAL', 'TIMED', 'SEATS']);
export type LicenseKindType = z.infer<typeof LicenseKindSchema>;

export const SubscriptionStatusSchema = z.enum(['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED']);
export type SubscriptionStatusType = z.infer<typeof SubscriptionStatusSchema>;

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
export type PlanDto = z.infer<typeof PlanDtoSchema>;

// ── Credits (prepaid balance / lead-pack drawdown) ──
export const CreditReasonSchema = z.enum(['PURCHASE', 'GRANT', 'CONSUME', 'REFUND', 'ADJUST']);
export type CreditReasonType = z.infer<typeof CreditReasonSchema>;

export const CreditBalanceDtoSchema = z.object({
  applicationId: z.string(),
  endUserId: z.string(),
  /** Current spendable balance (whole credits, never negative). */
  balance: z.number().int(),
  updatedAt: z.string().datetime(),
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
export type CreditLedgerEntryDto = z.infer<typeof CreditLedgerEntryDtoSchema>;

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
  /** Credits to add (positive) or remove (negative, for ADJUST). */
  amount: z.number().int(),
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
export type SubscriptionDto = z.infer<typeof SubscriptionDtoSchema>;

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

export const BillingProviderInfoDtoSchema = z.object({
  provider: BillingProviderSchema,
  priority: z.number().int().min(0),
  countries: z.array(z.string().length(2)),
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
  /** PERCENT: basis-points × 10 (1500 = 15.00%). AMOUNT: smallest currency unit. */
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

export const ValidateCouponResultDtoSchema = z.object({
  coupon: CouponDtoSchema,
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

/** RFC 7662 token-introspection response (subset ReliPay emits). */
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

/** RFC 8414 authorization-server metadata (subset ReliPay emits for MCP). */
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
  meterSlug: z.string(),
  quantity: z.number(),
  endUserId: z.string().nullable(),
  occurredAt: z.string().datetime(),
});
export type UsageRecordDto = z.infer<typeof UsageRecordDtoSchema>;

export const UsageAggregateDtoSchema = z.object({
  meterSlug: z.string(),
  total: z.number(),
  from: z.string().datetime().nullable(),
  to: z.string().datetime().nullable(),
});
export type UsageAggregateDto = z.infer<typeof UsageAggregateDtoSchema>;

// ============================================================================
// Outbound webhooks — the events ReliPay POSTs to YOUR app
// ============================================================================
//
// This registry mirrors the API's `KNOWN_WEBHOOK_EVENTS`
// (apps/api/src/modules/webhooks/events.ts) exactly — same names, same order.
// Subscribe an endpoint to specific events (or the `"*"` wildcard) via the
// panel or POST /api/v1/tenant/applications/:id/webhooks. Verify inbound
// deliveries with `verifyWebhookSignature` from `@relipay/node`.

/**
 * Every outbound webhook event ReliPay can emit, with a human/agent-readable
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
  // nothing emits nothing). A provider retry after a 5xx on ReliPay's side may
  // still re-emit; consumers must dedupe on the envelope's `eventId`.
  {
    name: 'subscription.activated',
    description:
      'A provider webhook transitioned a Subscription to ACTIVE. Payload: `data.subscription` with ids, plan slug/name/kind, amount/currency/interval, and period end.',
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

/** Union of every outbound webhook event name (e.g. `'user.created'`). */
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]['name'];

/** Just the event names, in registry order — mirrors the API's KNOWN_WEBHOOK_EVENTS. */
export const KNOWN_WEBHOOK_EVENTS: ReadonlyArray<WebhookEventType> = WEBHOOK_EVENTS.map(
  (e) => e.name,
);

export function isKnownWebhookEvent(s: string): s is WebhookEventType {
  return (KNOWN_WEBHOOK_EVENTS as ReadonlyArray<string>).includes(s);
}

export const WebhookEventTypeSchema = z.enum(
  KNOWN_WEBHOOK_EVENTS as [WebhookEventType, ...WebhookEventType[]],
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
// not an Application secret key — so the end-user SDKs (@relipay/node etc.)
// deliberately do NOT expose them. The shapes live here so the panel, agents,
// and any session-bearing automation share one definition.

export const PaymentStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED']);
export type PaymentStatusType = z.infer<typeof PaymentStatusSchema>;

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
export type TenantPaymentDto = z.infer<typeof TenantPaymentDtoSchema>;

/** Query params of GET /api/v1/tenant/applications/:id/payments. */
export interface TenantPaymentsListQuery {
  status?: PaymentStatusType;
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
  /** Only users holding at least one subscription with this status. */
  subscriptionStatus?: SubscriptionStatusType;
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
// document of everything ReliPay stores about an end-user (OWNER/ADMIN only).
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
  failedSignInAttempts: number;
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
