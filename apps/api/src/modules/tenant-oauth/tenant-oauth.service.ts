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
 * `tenantAuthService.findOrCreateOAuthOperator` + `completeOAuth`).
 *
 * CSRF: the panel owns the `state` (it sets a one-shot httpOnly cookie on start
 * and compares it on the callback). This module just round-trips `state` and
 * exchanges the code — it is stateless, mirroring the end-user OAuth start.
 */

import { env } from '../../config/env.js';
import { panelBaseUrl } from '../../lib/panel-url.js';
import { RekeyError } from '../../lib/error.js';
import { getOAuthProvider, buildAuthUrl as buildAuthUrlVia } from '../oauth/providers/index.js';
import type { OAuthProviderConfig } from '../oauth/providers/index.js';
import { tenantAuthService, type TenantSignInOutcome, type TenantDeviceContext } from '../tenant-auth/tenant-auth.service.js';

/** Providers we support for operator login. Subset of the registry. */
const OPERATOR_PROVIDERS = ['google', 'github'] as const;
type OperatorProvider = (typeof OPERATOR_PROVIDERS)[number];

function isOperatorProvider(name: string): name is OperatorProvider {
  return (OPERATOR_PROVIDERS as readonly string[]).includes(name);
}

/** Server-env client credentials for an operator OAuth provider, or null. */
function providerCreds(provider: OperatorProvider): { clientId: string; clientSecret: string } | null {
  const map: Record<OperatorProvider, { id: string | undefined; secret: string | undefined }> = {
    google: { id: env.PANEL_OAUTH_GOOGLE_CLIENT_ID, secret: env.PANEL_OAUTH_GOOGLE_CLIENT_SECRET },
    github: { id: env.PANEL_OAUTH_GITHUB_CLIENT_ID, secret: env.PANEL_OAUTH_GITHUB_CLIENT_SECRET },
  };
  const e = map[provider];
  return e.id && e.secret ? { clientId: e.id, clientSecret: e.secret } : null;
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
  return { clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: redirectUri(provider) };
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
    const impl = getOAuthProvider(provider);
    if (!impl) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OAUTH_PROVIDER_UNKNOWN',
        message: `OAuth provider "${provider}" is not registered.`,
        fix: `Use one of: ${OPERATOR_PROVIDERS.join(', ')}.`,
      });
    }
    const authorizationUrl = await buildAuthUrlVia(impl, { config: configFor(provider), state: args.state });
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
    device?: TenantDeviceContext;
  }): Promise<TenantSignInOutcome> {
    const provider = requireProvider(args.provider);
    const impl = getOAuthProvider(provider);
    if (!impl) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OAUTH_PROVIDER_UNKNOWN',
        message: `OAuth provider "${provider}" is not registered.`,
        fix: `Use one of: ${OPERATOR_PROVIDERS.join(', ')}.`,
      });
    }
    const identity = await impl.exchange({ config: configFor(provider), code: args.code });
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
};
