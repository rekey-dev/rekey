/**
 * Operator (panel) OAuth — social login for Rekey OPERATORS, not end-users.
 *
 * Distinct from `modules/oauth` (end-user social login), which is per-Application
 * (`Application.oauthConfig`, API-key-scoped, bound to `req.application`).
 * Operator login is ONE global relying party, so the client credentials come
 * from server-level env (`PANEL_OAUTH_<PROVIDER>_CLIENT_ID/SECRET`) — there is
 * no per-app config for operators.
 *
 * It reuses the provider implementations in `modules/oauth/providers/*` (token +
 * userinfo exchange) but wires its OWN credentials, redirect URI, and account
 * model (TenantUser, matched/created by verified email — see
 * `tenantAuthService.findOrCreateOAuthOperator` + `completeSignIn`).
 *
 * CSRF: the panel owns the `state` (it sets a one-shot httpOnly cookie on start
 * and compares it on the callback). This module just round-trips `state` and
 * exchanges the code — it is stateless, mirroring the end-user OAuth start.
 */

import { env } from '../../config/env.js';
import { panelBaseUrl } from '../../lib/panel-url.js';
import { RekeyError } from '../../lib/error.js';
import { verifyOperatorAssertionIdToken } from '../../lib/jwt.js';
import { claimAssertionOnce } from '../../lib/assertion-replay.js';
import { rememberVerifier, takeVerifier } from '../../lib/pkce-store.js';
import { randomBytes } from 'node:crypto';
import { getOAuthProvider, buildAuthUrl as buildAuthUrlVia } from '../oauth/providers/index.js';
import type { OAuthProviderConfig } from '../oauth/providers/index.js';
import { tenantAuthService, type TenantSignInOutcome, type TenantDeviceContext } from '../tenant-auth/tenant-auth.service.js';

/**
 * The issuer + audience this deployment trusts for ID Token assertions, or
 * null when it accepts none.
 *
 * Read live from `process.env` rather than the boot-parsed `env`, matching
 * `operatorSignupMode()` next door: both are deployment switches an operator
 * may want to flip without a restart, and reading live is also what lets the
 * tests point the pair at a fixture Application they only just created.
 */
function assertionConfig(): { issuer: string; audience: string } | null {
  const issuer = process.env.OPERATOR_OIDC_ISSUER ?? env.OPERATOR_OIDC_ISSUER;
  const audience = process.env.OPERATOR_OIDC_CLIENT_ID ?? env.OPERATOR_OIDC_CLIENT_ID;
  return issuer && audience ? { issuer, audience } : null;
}

/** Providers we support for operator login. Subset of the registry. */
/**
 * `rekey` is this deployment signing operators in against one of its OWN
 * Applications — the arrangement Rekey Cloud uses, where buyers already have an
 * account on the marketing site and should not need a second password to reach
 * the panel. It has no bespoke implementation: it is the generic `oidc`
 * provider pointed at that Application's issuer, which is a compliant OIDC
 * provider like any other.
 *
 * It grants no authority of its own. A first-time sign-in still lands in the
 * new-operator branch of `findOrCreateOAuthOperator` and still answers to
 * `OPERATOR_SIGNUP_MODE`, so on an invite-only deployment somebody who merely
 * has an account on the issuer is refused. Someone who paid already has an
 * operator (provisioning created it), so they take the existing-operator branch
 * — including after their subscription lapses, which is deliberate: they need
 * to get in to fix the payment, and their entitlements fall to the free ceiling
 * on their own.
 */
const OPERATOR_PROVIDERS = ['google', 'github', 'rekey'] as const;

/**
 * Which registered implementation drives a provider. Only `rekey` differs from
 * its own name — see above.
 */
function implNameFor(provider: OperatorProvider): string {
  return provider === 'rekey' ? 'oidc' : provider;
}
type OperatorProvider = (typeof OPERATOR_PROVIDERS)[number];

function isOperatorProvider(name: string): name is OperatorProvider {
  return (OPERATOR_PROVIDERS as readonly string[]).includes(name);
}

/** Server-env client credentials for an operator OAuth provider, or null. */
function providerCreds(provider: OperatorProvider): { clientId: string; clientSecret: string } | null {
  const map: Record<OperatorProvider, { id: string | undefined; secret: string | undefined }> = {
    google: { id: env.PANEL_OAUTH_GOOGLE_CLIENT_ID, secret: env.PANEL_OAUTH_GOOGLE_CLIENT_SECRET },
    github: { id: env.PANEL_OAUTH_GITHUB_CLIENT_ID, secret: env.PANEL_OAUTH_GITHUB_CLIENT_SECRET },
    rekey: { id: env.PANEL_OAUTH_REKEY_CLIENT_ID, secret: env.PANEL_OAUTH_REKEY_CLIENT_SECRET },
  };
  const e = map[provider];
  if (!e.id) return null;
  if (provider === 'rekey') {
    // Without an issuer it is not half-configured, it is unusable.
    if (!env.PANEL_OAUTH_REKEY_ISSUER) return null;
    // The secret is OPTIONAL here and required for the others. An Application
    // acting as an identity provider issues PUBLIC clients — PKCE, no secret,
    // `token_endpoint_auth_methods_supported: ["none"]` — so requiring one
    // would mean asking the operator to invent a value nothing checks. The
    // provider omits it at the token endpoint when the issuer says `none`.
    return { clientId: e.id, clientSecret: e.secret ?? '' };
  }
  if (!e.secret) return null;
  return { clientId: e.id, clientSecret: e.secret };
}

/** Where the provider redirects after consent — the panel callback route. */
function redirectUri(provider: OperatorProvider): string {
  const base = panelBaseUrl();
  if (!base) {
    throw new RekeyError({
      statusCode: 503,
      code: 'OAUTH_NOT_CONFIGURED',
      message: 'Operator OAuth redirect base is not configured.',
      fix: 'Set PANEL_OAUTH_REDIRECT_BASE (e.g. https://panel.example.com) or CORS_ALLOWED_ORIGINS.',
    });
  }
  return `${base}/login/oauth/${provider}/callback`;
}

function configFor(provider: OperatorProvider): OAuthProviderConfig {
  const creds = providerCreds(provider);
  if (!creds) {
    throw new RekeyError({
      statusCode: 400,
      code: 'OAUTH_PROVIDER_NOT_CONFIGURED',
      message: `Operator OAuth provider "${provider}" is not configured on this deployment.`,
      fix: `Set PANEL_OAUTH_${provider.toUpperCase()}_CLIENT_ID and _CLIENT_SECRET.`,
    });
  }
  return {
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: redirectUri(provider),
    // Ignored by the static providers; required by `oidc`, which discovers the
    // endpoints from `${issuerUrl}/.well-known/openid-configuration`.
    //
    // `providerCreds` already refuses to report `rekey` as configured without
    // an issuer, so reaching here with one unset is impossible — but the
    // compiler cannot see that across the two functions, and narrowing it here
    // is better than asserting it away.
    ...(provider === 'rekey' && env.PANEL_OAUTH_REKEY_ISSUER
      ? { issuerUrl: env.PANEL_OAUTH_REKEY_ISSUER }
      : {}),
  };
}

function requireProvider(name: string): OperatorProvider {
  if (!isOperatorProvider(name)) {
    throw new RekeyError({
      statusCode: 404,
      code: 'OAUTH_PROVIDER_UNKNOWN',
      message: `"${name}" is not an operator OAuth provider.`,
      fix: `Use one of: ${OPERATOR_PROVIDERS.join(', ')}.`,
    });
  }
  return name;
}

export const tenantOAuthService = {
  /** Providers with both credentials set + a resolvable redirect base. */
  configuredProviders(): OperatorProvider[] {
    if (!panelBaseUrl()) return [];
    return OPERATOR_PROVIDERS.filter((p) => providerCreds(p) !== null);
  },

  /** Build the provider authorization URL. `state` is the panel's CSRF token. */
  async buildAuthUrl(args: { provider: string; state: string }): Promise<{ authorizationUrl: string }> {
    const provider = requireProvider(args.provider);
    const impl = getOAuthProvider(implNameFor(provider));
    if (!impl) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OAUTH_PROVIDER_UNKNOWN',
        message: `OAuth provider "${provider}" is not registered.`,
        fix: `Use one of: ${OPERATOR_PROVIDERS.join(', ')}.`,
      });
    }
    // Minted for every provider, used only by those whose issuer advertises
    // S256 — the provider decides from its discovery document. Generating it
    // unconditionally keeps this layer from having to know which providers
    // speak PKCE, and an unused verifier costs one Redis key that expires.
    const codeVerifier = randomBytes(32).toString('base64url');
    const authorizationUrl = await buildAuthUrlVia(impl, {
      config: configFor(provider),
      state: args.state,
      codeVerifier,
    });
    await rememberVerifier(args.state, codeVerifier);
    return { authorizationUrl };
  },

  /**
   * Exchange the callback code → resolve/create the operator → mint a session
   * (or an MFA challenge). Refuses providers that don't return a VERIFIED email
   * — an unverified address can't prove mailbox ownership and would let an
   * attacker hijack an operator account by claiming its email (same gate as the
   * end-user OAuth path).
   */
  async handleCallback(args: {
    provider: string;
    code: string;
    /** Single-use invite key — only used if this login creates a new operator. */
    inviteKey?: string;
    /**
     * The CSRF state this flow started with. Also the key the PKCE verifier was
     * stored under, which is why the callback needs it — the panel has already
     * verified it against its own cookie by the time we see it.
     */
    state?: string;
    device?: TenantDeviceContext;
  }): Promise<TenantSignInOutcome> {
    const provider = requireProvider(args.provider);
    const impl = getOAuthProvider(implNameFor(provider));
    if (!impl) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OAUTH_PROVIDER_UNKNOWN',
        message: `OAuth provider "${provider}" is not registered.`,
        fix: `Use one of: ${OPERATOR_PROVIDERS.join(', ')}.`,
      });
    }
    // Absent for a flow that never stored one (a provider without PKCE), and
    // absent for a replayed or expired callback. The provider tells those apart
    // — it only sends `code_verifier` when the issuer wants one, so a missing
    // verifier fails the exchange exactly where it should.
    const codeVerifier = args.state ? await takeVerifier(args.state) : null;
    const identity = await impl.exchange({
      config: configFor(provider),
      code: args.code,
      ...(codeVerifier ? { codeVerifier } : {}),
    });
    if (!identity.email) {
      throw new RekeyError({
        statusCode: 400,
        code: 'OAUTH_NO_EMAIL',
        message: `${provider} did not return an email — cannot sign in an operator.`,
        fix: 'Grant the email scope to the OAuth client, or use password sign-in.',
      });
    }
    if (!identity.emailVerified) {
      throw new RekeyError({
        statusCode: 401,
        code: 'OAUTH_EMAIL_NOT_VERIFIED',
        message: `${provider} did not verify the email — operator sign-in is refused.`,
        fix: 'Verify the email at the provider, then retry, or use password sign-in.',
      });
    }
    const user = await tenantAuthService.findOrCreateOAuthOperator({
      email: identity.email,
      emailVerified: identity.emailVerified,
      ...(args.inviteKey !== undefined && { inviteKey: args.inviteKey }),
      ...(args.device !== undefined && { device: args.device }),
    });
    return tenantAuthService.completeSignIn(user, args.device);
  },

  /** Is this deployment configured to accept ID Token assertions? */
  assertionConfigured(): boolean {
    return assertionConfig() !== null;
  },

  /**
   * Sign an operator in from an ID Token this deployment issued.
   *
   * The identity model: the upstream Application's end-user is AUTHORITATIVE,
   * and the operator is a projection of it linked by verified email. That is
   * why this lands on the same `findOrCreateOAuthOperator` the social buttons
   * use rather than a path of its own — an operator who already exists keeps
   * their workspaces, their MFA and their passkeys, and a first-time assertion
   * is gated by `OPERATOR_SIGNUP_MODE` like any other new operator. Nothing
   * about federation is allowed to become a way around either.
   *
   * One refusal for every failure mode (`OIDC_ASSERTION_INVALID`). Which of
   * "wrong issuer", "wrong audience", "expired", "unverified email" and
   * "already redeemed" applies is not something an unauthenticated caller
   * should be able to probe for.
   */
  async handleIdTokenAssertion(args: {
    idToken: string;
    device?: TenantDeviceContext;
  }): Promise<TenantSignInOutcome> {
    const configured = assertionConfig();
    if (!configured) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OIDC_ASSERTION_NOT_CONFIGURED',
        message: 'This deployment does not accept ID Token assertions.',
        fix: 'Set OPERATOR_OIDC_ISSUER and OPERATOR_OIDC_CLIENT_ID to opt in.',
      });
    }

    const invalid = (): never => {
      throw new RekeyError({
        statusCode: 401,
        code: 'OIDC_ASSERTION_INVALID',
        message: 'That sign-in link is not valid.',
        fix: 'Start the sign-in again from the site that sent you here — these links are single-use and short-lived.',
      });
    };

    const claims = await verifyOperatorAssertionIdToken(args.idToken, configured);
    if (!claims) invalid();

    // Single-use, claimed BEFORE the operator is resolved so a replay cannot
    // race a slow first redemption. Fails closed: an unreachable store throws
    // out of here rather than waving the token through.
    if (!(await claimAssertionOnce(args.idToken, claims!.exp))) invalid();

    const user = await tenantAuthService.findOrCreateOAuthOperator({
      email: claims!.email,
      // Guaranteed true by the verifier — an unverified email never returns.
      emailVerified: true,
      ...(args.device !== undefined && { device: args.device }),
    });
    return tenantAuthService.completeSignIn(user, args.device);
  },
};
