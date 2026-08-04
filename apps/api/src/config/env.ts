import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3030),
    HOST: z.string().default('0.0.0.0'),

    // Global rate limit (the `@fastify/rate-limit` plugin). Defaults to
    // 100 requests / 60s, keyed by **API key** where one was presented and by
    // source IP only on unauthenticated routes (see `keyGenerator` in app.ts).
    // So a customer's backend gets its own budget rather than sharing an IP
    // bucket. Raise these for high-volume ingestion (e.g. usage events).
    // Auth endpoints keep their own tighter per-route caps regardless.
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    // Higher per-window cap for server-to-server usage ingestion
    // (POST /api/v1/usage/record), keyed per API key. A QR-style product that
    // records one event per scan blows through the default 100 instantly.
    RATE_LIMIT_USAGE_MAX: z.coerce.number().int().positive().default(1000),

    DATABASE_URL: z.string().url(),

    // Prisma connection-pool sizing, applied to DATABASE_URL as
    // `connection_limit` / `pool_timeout` by lib/prisma.ts. Declared here for
    // validation and discoverability only — prisma.ts reads `process.env`
    // directly, because it must build the client before this module's
    // side-effecting parse has necessarily run.
    //
    // Default 20, NOT Prisma's `num_cpus * 2 + 1`: the webhook worker runs at
    // concurrency 10 against this same client, so a CPU-derived default on a
    // small container gave the whole API fewer connections than one background
    // worker could want. See the docblock in lib/prisma.ts before changing it.
    // A `connection_limit` already present in DATABASE_URL wins over this.
    DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(20),
    DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),
    // Required infrastructure (not just rate-limiting): the outbound-webhook
    // delivery queue runs on BullMQ/Redis, and the server refuses to start if
    // Redis is unreachable at boot (no in-process fallback — delivery must go
    // through the shared queue so retries survive a crash and distribute across
    // replicas). The localhost default is a dev convenience; prod sets it
    // explicitly. Only NODE_ENV=test skips the queue (single-process suite).
    REDIS_URL: z.string().url().default('redis://localhost:6379'),

    JWT_SECRET: z.string().min(32),

    // Optional RS256 private key (PKCS#8 or PKCS#1 PEM) for end-user access
    // tokens on Applications that opt in via `authConfig.tokenAlg = "RS256"`.
    // When set, it is THE active signing key and nothing is persisted; when
    // unset, a 2048-bit keypair is generated on first use and stored in the
    // `signing_keys` table (private half encrypted with ENCRYPTION_KEY).
    // Literal `\n` sequences are accepted (common in env-file PEM transport).
    // Public halves are served at GET /.well-known/jwks.json either way.
    JWT_RS256_PRIVATE_KEY: z.string().min(1).optional(),

    // 32 bytes hex = 64 chars. Required in production for token-at-rest encryption.
    ENCRYPTION_KEY: z.string().length(64).optional(),

    API_URL: z.string().url().default('http://localhost:3030'),

    // Public, internet-reachable base URL of THIS API — used to auto-register
    // provider webhook endpoints (Stripe/PayPal call back here). Must be the
    // externally resolvable origin (e.g. https://api.rekey.dev, or an ngrok
    // tunnel in dev), NOT the in-cluster API_URL. Falls back to API_URL when
    // unset; auto-registration refuses on a non-public (localhost) base.
    PUBLIC_WEBHOOK_BASE_URL: z.string().url().optional(),

    // Public base URL of the Rekey-hosted customer portal (Portal V2). Its
    // origin is auto-allowed for publishable-key requests from portal-enabled
    // apps (so operators don't hand-add it to corsOrigins) and folded into the
    // CORS union. Default is the production host.
    // No default: this is the origin end-users are sent to, and defaulting it
    // to Rekey's hosted portal would point a self-hoster's customers at our
    // infrastructure. Unset means portal links are simply not offered.
    PUBLIC_PORTAL_URL: z.string().url().optional(),

    // Public base URL of the operator panel. The operator MCP OAuth authorize
    // endpoint redirects here (`/mcp-consent`) so the operator signs in through
    // the real panel login (session reuse, passkeys, MFA, magic-link) instead
    // of a bespoke password form on the API. Default is the production host.
    // No default, same reasoning: this builds operator-facing links (the MCP
    // consent screen, emailed workspace invites), so a Rekey default would send
    // a self-hoster's operators to our panel.
    PANEL_URL: z.string().url().optional(),

    // Bootstrap admin credential. Required to create the first Tenant and
    // Application via /api/v1/admin/*. Once the panel ships, normal tenant
    // auth replaces this for day-to-day work — but you'll always need this
    // for `rekey tenant create` and similar bootstrap commands.
    // Generate with: openssl rand -hex 32
    SUPER_ADMIN_KEY: z.string().min(32),

    // Optional network gate on /api/v1/admin/* — comma-separated IPs and/or
    // CIDRs (v4 and v6). Unset (the default) means no network restriction, so
    // upgrading changes nothing. When set, requests from anywhere else are
    // refused BEFORE the key is examined, which is the point: SUPER_ADMIN_KEY
    // is a single shared secret over the whole deployment, and a leak of it is
    // otherwise game over. This is defence in depth, not a replacement for it.
    // A malformed entry is a boot failure rather than a silently-open gate.
    ADMIN_IP_ALLOWLIST: z.string().optional(),

    // NOTE: there is deliberately no deployment-wide Stripe configuration —
    // neither an API key nor a STRIPE_WEBHOOK_SECRET. Webhook secrets are
    // per-Application (stored with that app's BYO credentials); a shared one
    // would be a cross-tenant trust boundary. Signature verification is
    // offline HMAC and needs no account key at all.

    // Default transactional email transport (Resend).
    //
    // When set, Applications without BYO email credentials send via this
    // shared account. Rekey hosted production sets it; self-hosters leave
    // it empty and the service returns raw tokens to callers (legacy
    // "Rekey does not send email" mode).
    //
    // Generate from https://resend.com/api-keys. The from address must be
    // on a verified domain Resend has accepted.
    RESEND_DEFAULT_API_KEY: z.string().optional(),
    RESEND_DEFAULT_FROM: z.string().email().optional(),
    RESEND_DEFAULT_FROM_NAME: z.string().optional(),

    // Deployment-wide fallback for the base URL transactional emails link
    // back to (`{{appUrl}}`, and the base for reset/verify/magic-link URLs
    // when the SDK caller doesn't pass one). LAST resort in the resolution
    // chain — see lib/app-url.ts.
    //
    // Unset by default and deliberately so: a single-app self-host can set
    // it once instead of configuring every Application, but leaving it empty
    // changes nothing. When nothing in the chain resolves, emails render
    // WITHOUT the call-to-action button rather than with a broken one.
    DEFAULT_APP_URL: z.string().url().optional(),

    // Global kill-switch for the HIBP Pwned Passwords breach check. When
    // `true`, all per-Application `authConfig.passwordBreachCheckEnabled`
    // flags are ignored and passwords are accepted without an external
    // lookup. Use for offline / restricted-egress deployments.
    HIBP_BREACH_CHECK_DISABLED: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .optional()
      .transform((v) => v === 'true'),

    // Outbound-webhook escape hatch for self-hosters who legitimately need
    // to send webhooks to internal services (private VPC IPs, localhost
    // receivers, etc.). Defaults to `false` — public production deploys
    // should leave it that way to prevent SSRF via attacker-controlled
    // endpoint URLs.
    WEBHOOK_ALLOW_PRIVATE_TARGETS: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .optional()
      .transform((v) => v === 'true'),

    // Operator/tenant MCP HTTP surface (POST /api/v1/tenant/mcp + its OAuth
    // authorization server). Enabled by default; set OPERATOR_MCP_ENABLED=false
    // to not mount it at all (the routes 404) — for deployments that don't want
    // the operator MCP (which exposes the mint_api_key write tool) reachable.
    // Distinct from the per-Application end-user MCP, which is unaffected.
    // Default-true: only the literal "false" disables it.
    OPERATOR_MCP_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.literal('')])
      .optional()
      .transform((v) => v !== 'false'),

    // RFC 7591 dynamic client registration on the OPERATOR MCP authorization
    // server (POST /api/v1/tenant/mcp/oauth/register).
    //
    //   - 'open' (default): anyone may register a public client. This is what
    //     lets Claude Desktop / Claude Code / Cursor connect by discovery
    //     alone, which is the flow docs/mcp.md and the panel's connection
    //     guide document, so it stays the default.
    //   - 'disabled': the endpoint answers 403 CLIENT_REGISTRATION_DISABLED
    //     and `registration_endpoint` disappears from the RFC 8414 metadata.
    //     Clients holding a client_id already are unaffected.
    //
    // Worth knowing before you leave it open. Registration itself hands out no
    // data and no token — the authorization code is only minted after an
    // operator signs into the panel and approves. What it DOES hand out is an
    // allowlisted redirect_uri of the registrant's choosing, and /oauth/authorize
    // refuses any redirect_uri its client did not register. That allowlist entry
    // is the missing ingredient in a consent-phishing link: register
    // `https://evil.example/cb` under a plausible client_name, send an operator
    // an authorize URL on their OWN deployment, and one Allow click delivers a
    // workspace-admin grant to the attacker. The consent screen now names the
    // destination host for exactly this reason; closing registration once your
    // clients are connected removes the ingredient entirely.
    //
    // The per-Application MCP twin has had the same switch since it was written
    // (`authConfig.dynamicClientRegistration`); this is the operator analogue,
    // deployment-wide because the operator AS has no Application to hang it on.
    // Boot-validated so a typo crashes rather than silently reopening.
    OPERATOR_MCP_DYNAMIC_REGISTRATION: z.enum(['open', 'disabled']).default('open'),

    // Deploy-time control of OPERATOR (TenantUser) registration. Gates every
    // path that would CREATE a new operator + workspace (password sign-up and
    // OAuth-first-login). Existing operators always sign in regardless.
    //   - 'open'   (default): self-serve sign-up is open to anyone — today's
    //              behavior, preserved exactly.
    //   - 'invite': a new operator must present a single-use invite key minted
    //              by the super-admin (POST /api/v1/admin/operator-invites).
    //              The key is consumed atomically on sign-up — one key, one
    //              operator.
    //   - 'closed': all new-operator registration is disabled. Existing
    //              operators still sign in; invites cannot be redeemed.
    // Validated here so a typo (e.g. 'closd') fails the boot rather than
    // silently degrading to 'open'. The enforcement layer
    // (modules/tenant-auth/operator-signup-policy.ts) reads the live value.
    OPERATOR_SIGNUP_MODE: z.enum(['open', 'invite', 'closed']).default('open'),

    // Ceilings stamped onto every workspace this deployment creates, as a JSON
    // object matching `TenantLimitsSchema` (@rekey.dev/shared-types) — e.g.
    // '{"maxProductionApps":1}'.
    //
    // Unset or empty (the default) means `Tenant.limits` stays NULL, which
    // means unlimited — exactly what every workspace gets today, so a self-host
    // upgrading past this key notices nothing.
    //
    // It exists because `Tenant.limits` is otherwise only ever written after
    // the fact (PUT /api/v1/admin/tenants/:id/limits), so a workspace nobody
    // ever visits that endpoint for is unbounded. This closes the gap at
    // creation for the deployments that want a floor.
    //
    // This is a mechanism, not a pricing model: the API has no idea what a
    // plan, price or tier is, and nothing here derives a number from a
    // subscription. A deployment supplies the policy; the API applies it.
    // Shape is validated at boot by `assertDefaultTenantLimitsValid`
    // (lib/tenant-limits.ts) — a silently-ignored default would leave an
    // operator believing new workspaces are capped when they are not.
    DEFAULT_TENANT_LIMITS: z.string().optional(),

    // Deploy-time control of WORKSPACE creation by an already-signed-in
    // operator (POST /api/v1/tenant/workspace).
    //   - 'open'     (default): anyone with a session can spin up another
    //                workspace — today's behavior, preserved exactly.
    //   - 'disabled': that endpoint refuses with WORKSPACE_CREATION_DISABLED.
    //
    // The pair to DEFAULT_TENANT_LIMITS: a per-workspace ceiling means nothing
    // if any operator — including an invited team member — can mint themselves
    // a fresh workspace with a fresh ceiling. Gates CREATION only; switching
    // between, listing, renaming and leaving workspaces are untouched, so an
    // operator already in several keeps working normally.
    // Validated here so a typo fails the boot rather than silently degrading
    // to 'open'; the enforcement layer (modules/tenant-workspaces) reads the
    // live value.
    WORKSPACE_CREATION: z.enum(['open', 'disabled']).default('open'),

    // Panel-side WebAuthn (operator passkeys) relying-party config.
    //
    // The panel is one RP across all tenants — operators log into the same
    // domain regardless of which workspace they manage. `rpId` must match
    // the panel hostname (no scheme, no port). `rpOrigins` is the
    // allowlist of full origins (scheme + host + port) the panel runs on.
    //
    // When `PANEL_WEBAUTHN_RP_ID` is unset, operator passkey endpoints
    // refuse with `WEBAUTHN_NOT_CONFIGURED` — deliberate, since binding
    // credentials to a guessable RP id is security-relevant.
    PANEL_WEBAUTHN_RP_ID: z.string().optional(),
    PANEL_WEBAUTHN_RP_ORIGINS: z.string().optional(),
    PANEL_WEBAUTHN_RP_NAME: z.string().optional(),

    // Panel-side operator OAuth (social login for the PANEL, not end-users).
    // Operator login is one global relying party, so credentials are
    // server-level env here — NOT per-Application (end-user OAuth config lives
    // on `Application.oauthConfig`). A provider activates only when BOTH its id
    // and secret are set; otherwise its button is hidden and its endpoints
    // return `OAUTH_PROVIDER_NOT_CONFIGURED`.
    PANEL_OAUTH_GOOGLE_CLIENT_ID: z.string().optional(),
    PANEL_OAUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),
    PANEL_OAUTH_GITHUB_CLIENT_ID: z.string().optional(),
    PANEL_OAUTH_GITHUB_CLIENT_SECRET: z.string().optional(),
    // Base origin the panel runs on, used to build the operator OAuth redirect
    // URI `<base>/login/oauth/<provider>/callback` (must be registered on each
    // provider console). Falls back to the first CORS_ALLOWED_ORIGINS entry
    // (preferring a `panel.` host) when unset.
    PANEL_OAUTH_REDIRECT_BASE: z.string().optional(),

    // Operator sign-in by OIDC ID Token assertion
    // (POST /api/v1/tenant/auth/oidc/assert).
    //
    // Lets an operator session be established from an ID Token this deployment
    // ITSELF issued, for one of its own Applications acting as an OpenID
    // Provider. That is how Rekey Cloud signs a buyer into the panel with the
    // account they already have on the marketing site: one identity, no invite
    // key, no second password.
    //
    // Both must be set or the endpoint 404s — a deployment that has not opted
    // in has no assertion surface at all. The pair is the entire trust
    // statement: `ISSUER` names the Application whose ID Tokens are believed
    // (its `sub`/`email` become an operator identity), and `CLIENT_ID` is the
    // audience they must carry, so a token minted for any OTHER client of the
    // same Application is refused rather than replayed into an operator login.
    //
    // Deliberately limited to issuers this deployment hosts: the token is
    // verified against the local JWKS, not fetched from a remote well-known.
    // A third-party operator IdP is a different feature with a different threat
    // model (see docs/operator-oidc-assertion.md).
    OPERATOR_OIDC_ISSUER: z.string().optional(),
    OPERATOR_OIDC_CLIENT_ID: z.string().optional(),

    // Comma-separated list of origins allowed to call the API with credentials.
    // Reflective CORS (`origin: true`) is unsafe when combined with cookies —
    // an allowlist is the only correct posture.
    //
    // Dev default permits localhost development. In production this MUST be
    // set explicitly; an empty production value falls back to a deny-all
    // policy (no Origin header passes).
    //
    // Format: comma-separated origins, no trailing slash. Examples:
    //   CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
    CORS_ALLOWED_ORIGINS: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

/**
 * Parsed CORS allowlist. Empty in production = deny-all; in development
 * the helper in `app.ts` permits localhost.
 */
export const corsAllowedOrigins: string[] = (env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

if (env.NODE_ENV === 'production' && !env.ENCRYPTION_KEY) {
  // Fail closed. Booting without ENCRYPTION_KEY would persist provider/OAuth
  // secrets as plaintext (`plain.` prefix) at rest — a silent, hard-to-spot
  // data-at-rest exposure. Better to refuse to start than to quietly store
  // credentials in the clear; operators see the error immediately and fix it.
  throw new Error(
    '[SECURITY] ENCRYPTION_KEY is required in production — refusing to boot. ' +
      'Without it, provider credentials and tokens are stored in plaintext at rest. ' +
      'Generate one with: openssl rand -hex 32',
  );
}

/**
 * Keys that are public knowledge and must never protect real data.
 *
 * `docker-compose.yml` shipped the first of these as a DEFAULT until 2.0.0-rc.1.
 * It is a valid 64-hex string, so it passed both the schema and the
 * presence check above, and — because `JWT_SECRET` and `SUPER_ADMIN_KEY` had
 * deliberately-invalid 17-character defaults that crash the boot — an operator
 * following the errors generated exactly those two and never discovered that a
 * third key existed at all. Anyone with the public repo could then decrypt a
 * stolen dump.
 *
 * Presence is not the property that matters here; secrecy is. A deployment that
 * copied the old compose file keeps booting happily after upgrading unless we
 * say something, so this refuses rather than warns.
 */
const PUBLICLY_KNOWN_ENCRYPTION_KEYS = new Set([
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
]);

if (
  env.NODE_ENV === 'production' &&
  env.ENCRYPTION_KEY &&
  (PUBLICLY_KNOWN_ENCRYPTION_KEYS.has(env.ENCRYPTION_KEY.toLowerCase()) ||
    /^(.)\1{63}$/.test(env.ENCRYPTION_KEY))
) {
  throw new Error(
    '[SECURITY] ENCRYPTION_KEY is a publicly known value — refusing to boot. ' +
      'This key was published as a docker-compose default before 2.0.0-rc.1, so it ' +
      'protects nothing. Generate a real one with: openssl rand -hex 32 — and note ' +
      'that anything already encrypted with the old key must be re-encrypted, since ' +
      'rotating the key alone leaves stored credentials unreadable. ' +
      'Treat any provider credentials stored under it as compromised and rotate them ' +
      'at the provider.',
  );
}

if (
  env.NODE_ENV === 'production' &&
  process.env.REKEY_DEV_ECHO_AUTH_TOKENS === 'true'
) {
  // Echoing raw password-reset / magic-link tokens back in API responses is a
  // local-development convenience (it lets the panel show a working link with
  // no mail transport). In production it is an account-takeover handout: the
  // operator endpoints that return them are unauthenticated by necessity.
  throw new Error(
    '[SECURITY] REKEY_DEV_ECHO_AUTH_TOKENS=true is not allowed in production — refusing to boot. ' +
      'It returns raw password-reset and magic-link tokens in API responses. Unset it and configure email transport.',
  );
}

/**
 * Warn — loudly, once, at boot — when a production deployment is running with
 * self-serve operator registration open.
 *
 * `OPERATOR_SIGNUP_MODE=open` means anyone who can reach this API can create an
 * operator account and a workspace on it. That is correct and necessary on
 * first boot: somebody has to make the first account, and every documented
 * first-boot path is self-serve sign-up in the panel. It stops being correct
 * the moment the deployment is reachable by anyone who isn't you, and nothing
 * in the product said so — `docker-compose.yml` shipped `open` alongside an
 * API published on 0.0.0.0, and the combination is "the first stranger to
 * portscan the host owns a workspace here".
 *
 * The port binding is fixed in compose (loopback by default now). This warning
 * covers every OTHER way to deploy — Kubernetes, systemd, a hand-rolled
 * compose, a PaaS — where we cannot see the network at all.
 *
 * A warning and not a refusal, deliberately: an operator running an invite-only
 * private deployment behind a VPN may legitimately want `open`, and a product
 * that will not boot in a valid configuration teaches people to ignore it. This
 * is the one case where the right answer genuinely depends on a network we
 * cannot observe.
 */
export function openSignupWarning(
  nodeEnv: string | undefined,
  mode: string | undefined,
): string | null {
  if (nodeEnv !== 'production' || mode !== 'open') return null;
  return (
    '[SECURITY] OPERATOR_SIGNUP_MODE=open in production: anyone who can reach this API ' +
    'can create an operator account and a workspace on it. That is intended for first ' +
    'boot only. Once your own account exists, set OPERATOR_SIGNUP_MODE=invite (super-admin ' +
    'mints keys at POST /api/v1/admin/operator-invites) or =closed. If this deployment is ' +
    'not reachable from the internet, you can ignore this.'
  );
}

{
  const warning = openSignupWarning(env.NODE_ENV, env.OPERATOR_SIGNUP_MODE);
  // eslint-disable-next-line no-console
  if (warning) console.warn(warning);
}

export type Env = typeof env;
