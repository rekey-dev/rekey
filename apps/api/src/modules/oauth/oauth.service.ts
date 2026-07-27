/**
 * OAuth orchestration — manages the per-Application config layer above the
 * provider implementations.
 *
 * Per-Application OAuth config lives in two columns:
 *   - `Application.oauthConfig: Json`           — public bits per provider
 *     ({ google: { clientId, redirectUri, scopes? }, github: { … } })
 *   - `Application.oauthCredentialsCiphertext`  — encrypted secrets
 *     ({ google: { clientSecret }, github: { clientSecret } })
 *
 * The service merges these into a `OAuthProviderConfig` at request time,
 * passes it to the provider implementation, and either signs the user in
 * (existing OAuthIdentity) or creates a new EndUser + OAuthIdentity.
 */

import type { Application, DataMode } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { assertSignupAllowed, type AuthKind } from '../../lib/signup-policy.js';
import { encryptJson, decryptJson } from '../../lib/secrets.js';
import { getOAuthProvider, buildAuthUrl as buildAuthUrlVia } from './providers/index.js';
import type { OAuthProviderConfig } from './providers/index.js';
import {
  issueSessionOrMfaChallenge,
  type DeviceContext,
  type SignInOutcome,
} from '../auth/auth.service.js';
import { webhookService } from '../webhooks/webhook.service.js';

export interface OAuthPublicConfigEntry {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  /** Required for the generic `oidc` provider; ignored by static providers. */
  issuerUrl?: string;
}

/**
 * OAuth callback outcome — same discriminated union as password sign-in so
 * MFA-enrolled users get the challenge-token path uniformly.
 */
export type OAuthSignInResult = SignInOutcome;

function publicConfig(application: Application, providerName: string): OAuthPublicConfigEntry | null {
  const cfg = (application.oauthConfig as unknown as Record<string, OAuthPublicConfigEntry | undefined>)[providerName];
  return cfg ?? null;
}

function decryptedSecrets(application: Application): Record<string, { clientSecret: string }> {
  if (!application.oauthCredentialsCiphertext) return {};
  return decryptJson<Record<string, { clientSecret: string }>>(application.oauthCredentialsCiphertext);
}

function buildProviderConfig(
  application: Application,
  providerName: string,
): OAuthProviderConfig {
  const pub = publicConfig(application, providerName);
  if (!pub) {
    throw new RekeyError({
      statusCode: 400,
      code: 'OAUTH_PROVIDER_NOT_CONFIGURED',
      message: `Application "${application.slug}" has no "${providerName}" OAuth config.`,
      fix: `Configure it via PUT /api/v1/tenant/applications/${application.id}/oauth-config.`,
    });
  }
  const secrets = decryptedSecrets(application);
  const providerSecrets = secrets[providerName];
  if (!providerSecrets) {
    throw new RekeyError({
      statusCode: 400,
      code: 'OAUTH_PROVIDER_NOT_CONFIGURED',
      message: `Application "${application.slug}" has no clientSecret for "${providerName}".`,
      fix: `Set the secret via PUT /api/v1/tenant/applications/${application.id}/oauth-config.`,
    });
  }
  return {
    clientId: pub.clientId,
    redirectUri: pub.redirectUri,
    clientSecret: providerSecrets.clientSecret,
    ...(pub.issuerUrl !== undefined && { issuerUrl: pub.issuerUrl }),
  };
}

export const oauthService = {
  async buildAuthUrl(args: {
    application: Application;
    providerName: string;
    state: string;
  }): Promise<string> {
    const provider = getOAuthProvider(args.providerName);
    if (!provider) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OAUTH_PROVIDER_UNKNOWN',
        message: `OAuth provider "${args.providerName}" is not registered.`,
        fix: 'Use one of: google, github.',
      });
    }
    const cfg = buildProviderConfig(args.application, args.providerName);
    const scopes = publicConfig(args.application, args.providerName)?.scopes;
    return buildAuthUrlVia(provider, {
      config: cfg,
      state: args.state,
      ...(scopes !== undefined && { scopes }),
    });
  },

  /**
   * Handle the provider callback. Exchanges the code, then either:
   *   - finds an existing OAuthIdentity → signs that EndUser in
   *   - finds an EndUser with the same email in this Application → links + signs in
   *   - creates a new EndUser + OAuthIdentity → signs in
   *
   * Always issues a fresh {access, refresh} pair on success.
   */
  async handleCallback(args: {
    application: Application;
    providerName: string;
    code: string;
    device?: DeviceContext;
    /** Calling key's mode — stamped onto a user created by this callback. */
    mode?: DataMode;
    /** Calling key kind — a `secret_only` app refuses creation via pub key. */
    authKind?: AuthKind;
  }): Promise<OAuthSignInResult> {
    const provider = getOAuthProvider(args.providerName);
    if (!provider) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OAUTH_PROVIDER_UNKNOWN',
        message: `OAuth provider "${args.providerName}" is not registered.`,
        fix: 'Use one of: google, github.',
      });
    }
    const cfg = buildProviderConfig(args.application, args.providerName);
    const identity = await provider.exchange({ config: cfg, code: args.code });

    // 1. Existing identity? Sign that user in.
    const existing = await prisma.oAuthIdentity.findUnique({
      where: {
        provider_providerAccountId: {
          provider: args.providerName,
          providerAccountId: identity.providerAccountId,
        },
      },
      include: { endUser: true },
    });
    if (existing) {
      // Cross-application guard — refuse to sign in if the link belongs to a
      // different Application. Should never happen via normal flows but
      // guards against config errors.
      if (existing.applicationId !== args.application.id) {
        throw new RekeyError({
          statusCode: 401,
          code: 'OAUTH_IDENTITY_WRONG_APPLICATION',
          message: 'This provider account is already linked to a different Application.',
          fix: 'Sign in to the Application this account belongs to, or use a different provider account.',
        });
      }
      return issueSessionOrMfaChallenge(args.application, existing.endUser, args.device);
    }

    // 2. Match by email within this Application → link + sign in.
    //
    // **Auto-link is gated on `identity.emailVerified`.** A provider that
    // returns an unverified email cannot prove the OAuth-side caller
    // actually owns that mailbox — auto-linking on an unverified address
    // would let an attacker with an unverified provider account (Microsoft
    // consumer aliases, self-hosted IdPs, etc.) hijack a pre-existing
    // password account by claiming the same email.
    if (identity.email && identity.emailVerified) {
      const matchedByEmail = await prisma.endUser.findUnique({
        where: {
          applicationId_email: {
            applicationId: args.application.id,
            email: identity.email.toLowerCase(),
          },
        },
      });
      if (matchedByEmail) {
        await prisma.oAuthIdentity.create({
          data: {
            applicationId: args.application.id,
            endUserId: matchedByEmail.id,
            provider: args.providerName,
            providerAccountId: identity.providerAccountId,
            email: identity.email,
          },
        });
        return issueSessionOrMfaChallenge(args.application, matchedByEmail, args.device);
      }
    }

    // 3. Email exists locally but the OAuth side didn't verify it. Refuse
    //    to silently create a new user (would hit the unique constraint)
    //    AND refuse to auto-link. Customer's app should prompt the user
    //    to sign in with their existing credential and link explicitly
    //    from /me/oauth/:provider/link (Phase 2 endpoint).
    if (identity.email && !identity.emailVerified) {
      const existingByEmail = await prisma.endUser.findUnique({
        where: {
          applicationId_email: {
            applicationId: args.application.id,
            email: identity.email.toLowerCase(),
          },
        },
        select: { id: true },
      });
      if (existingByEmail) {
        throw new RekeyError({
          statusCode: 401,
          code: 'OAUTH_EMAIL_NOT_VERIFIED',
          message:
            `${args.providerName} did not verify the email — auto-linking to your existing account is refused.`,
          fix: 'Sign in with your existing credentials, then explicitly link this OAuth provider from your account settings.',
        });
      }
    }

    // 4. New user. Gate creation on the signup policy first — an OAuth-first
    //    login is a sign-up, so `secret_only` (pub key) and `invite_only` must
    //    refuse it just like password / magic-link sign-up.
    assertSignupAllowed(
      AuthConfigSchema.parse(args.application.authConfig),
      args.authKind,
    );
    if (!identity.email) {
      throw new RekeyError({
        statusCode: 400,
        code: 'OAUTH_NO_EMAIL',
        message: `${args.providerName} did not return an email — cannot create a new user.`,
        fix: 'Either link this provider to an existing account first, or grant the email scope to this OAuth client.',
      });
    }
    const created = await prisma.endUser.create({
      data: {
        applicationId: args.application.id,
        email: identity.email.toLowerCase(),
        // Reflect the provider's verification claim faithfully — the
        // EndUser.emailVerified column was previously hardcoded `true`
        // which silently laundered unverified emails into trusted state.
        emailVerified: identity.emailVerified,
        mode: args.mode ?? 'LIVE',
      },
    });
    await prisma.oAuthIdentity.create({
      data: {
        applicationId: args.application.id,
        endUserId: created.id,
        provider: args.providerName,
        providerAccountId: identity.providerAccountId,
        email: identity.email,
      },
    });
    // Outbound webhook for new-via-OAuth users — mirrors password sign-up.
    void webhookService
      .emit({
        applicationId: args.application.id,
        type: 'user.created',
        data: {
          user: {
            id: created.id,
            email: created.email,
            emailVerified: created.emailVerified,
            role: created.role,
            mode: created.mode,
            createdAt: created.createdAt.toISOString(),
            metadata: created.metadata ?? null,
          },
          via: 'oauth',
          provider: args.providerName,
        },
      })
      .catch(() => undefined);
    return issueSessionOrMfaChallenge(args.application, created, args.device);
  },

  /**
   * Begin an OAuth link flow for an *already authenticated* end-user.
   * Returns the provider authorization URL the customer's app must
   * redirect the browser to. `state` is caller-supplied and round-tripped
   * (CSRF guard is the customer's responsibility, same model as
   * unauthenticated OAuth start).
   *
   * Sharing this code path with the unauthenticated `buildAuthUrl` would
   * conflate trust models — keep them parallel.
   */
  async buildLinkAuthUrl(args: {
    application: Application;
    providerName: string;
    state: string;
  }): Promise<string> {
    return this.buildAuthUrl(args);
  },

  /**
   * Complete an OAuth link by attaching the provider identity to the
   * currently-authenticated end-user.
   *
   * Refuses if:
   *   - The provider's email is unverified (same gate as sign-in auto-link).
   *   - The provider account is already linked to ANOTHER user in this
   *     Application — that would be a silent merge.
   *   - The provider is already linked to THIS user — idempotency
   *     guarantees no duplicate rows but the response signals what happened.
   */
  async linkIdentity(args: {
    application: Application;
    providerName: string;
    code: string;
    endUserId: string;
  }): Promise<{ provider: string; providerAccountId: string; alreadyLinked: boolean }> {
    const provider = getOAuthProvider(args.providerName);
    if (!provider) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OAUTH_PROVIDER_UNKNOWN',
        message: `OAuth provider "${args.providerName}" is not registered.`,
        fix: 'Use one of: google, github, microsoft, discord, gitlab, slack, oidc.',
      });
    }
    const cfg = buildProviderConfig(args.application, args.providerName);
    const identity = await provider.exchange({ config: cfg, code: args.code });

    if (!identity.emailVerified) {
      // Same gate as the sign-in path. An unverified email cannot prove
      // the OAuth caller actually owns the mailbox — refuse to link.
      throw new RekeyError({
        statusCode: 401,
        code: 'OAUTH_EMAIL_NOT_VERIFIED',
        message: `${args.providerName} did not verify the email — refusing to link to your account.`,
        fix: 'Verify the email at the provider, then retry. Some providers (Microsoft consumer accounts, generic OIDC) may not assert email_verified by default.',
      });
    }

    // Already linked anywhere? Decide.
    const existing = await prisma.oAuthIdentity.findUnique({
      where: {
        provider_providerAccountId: {
          provider: args.providerName,
          providerAccountId: identity.providerAccountId,
        },
      },
    });
    if (existing) {
      if (existing.endUserId === args.endUserId && existing.applicationId === args.application.id) {
        // Idempotent: already linked to this same user.
        return {
          provider: args.providerName,
          providerAccountId: identity.providerAccountId,
          alreadyLinked: true,
        };
      }
      throw new RekeyError({
        statusCode: 409,
        code: 'OAUTH_IDENTITY_TAKEN',
        message: 'This provider account is already linked to a different user.',
        fix: 'Sign in with that account instead, or unlink it from the other user first.',
      });
    }

    await prisma.oAuthIdentity.create({
      data: {
        applicationId: args.application.id,
        endUserId: args.endUserId,
        provider: args.providerName,
        providerAccountId: identity.providerAccountId,
        email: identity.email,
      },
    });
    return {
      provider: args.providerName,
      providerAccountId: identity.providerAccountId,
      alreadyLinked: false,
    };
  },

  /**
   * Unlink an OAuth provider from the current user.
   *
   * Lockout guard: refuses if removing the provider would leave the user
   * with no sign-in method (no password set + no other linked OAuth).
   * Operators can override by enrolling MFA + setting a password first.
   */
  async unlinkIdentity(args: {
    application: Application;
    providerName: string;
    endUserId: string;
  }): Promise<{ unlinked: boolean }> {
    const endUser = await prisma.endUser.findUnique({ where: { id: args.endUserId } });
    if (!endUser || endUser.applicationId !== args.application.id) {
      throw new RekeyError({
        statusCode: 404,
        code: 'END_USER_NOT_FOUND',
        message: 'End-user not found in this application.',
        fix: 'Verify the user id and that the calling secret key belongs to the right Application.',
      });
    }
    const identities = await prisma.oAuthIdentity.findMany({
      where: { endUserId: args.endUserId },
    });
    const remainingProviders = identities.filter((i) => i.provider !== args.providerName);
    const hasPassword = endUser.passwordHash !== null;
    if (!hasPassword && remainingProviders.length === 0) {
      throw new RekeyError({
        statusCode: 409,
        code: 'OAUTH_UNLINK_WOULD_LOCK_OUT',
        message: 'Unlinking this provider would leave the account with no way to sign in.',
        fix: 'Set a password first, or link a different OAuth provider, then retry.',
      });
    }
    const target = identities.find((i) => i.provider === args.providerName);
    if (!target) return { unlinked: false };
    await prisma.oAuthIdentity.delete({ where: { id: target.id } });
    return { unlinked: true };
  },

  /** List the OAuth providers linked to a user. Read-only. */
  async listIdentities(endUserId: string): Promise<
    Array<{ provider: string; providerAccountId: string; email: string | null; createdAt: Date }>
  > {
    const rows = await prisma.oAuthIdentity.findMany({
      where: { endUserId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      provider: r.provider,
      providerAccountId: r.providerAccountId,
      email: r.email,
      createdAt: r.createdAt,
    }));
  },

  /** Configure (or rotate) an OAuth provider's public config + secret for an Application. */
  async setProviderConfig(args: {
    applicationId: string;
    providerName: string;
    public: OAuthPublicConfigEntry;
    clientSecret: string;
  }): Promise<void> {
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: args.applicationId },
    });
    const newOauthConfig: Record<string, OAuthPublicConfigEntry> = {
      ...((application.oauthConfig as unknown as Record<string, OAuthPublicConfigEntry>) ?? {}),
      [args.providerName]: args.public,
    };
    const oldSecrets = decryptedSecrets(application);
    const newSecrets: Record<string, { clientSecret: string }> = {
      ...oldSecrets,
      [args.providerName]: { clientSecret: args.clientSecret },
    };
    await prisma.application.update({
      where: { id: application.id },
      data: {
        oauthConfig: newOauthConfig as never,
        oauthCredentialsCiphertext: encryptJson(newSecrets),
      },
    });
  },

  async removeProviderConfig(args: {
    applicationId: string;
    providerName: string;
  }): Promise<void> {
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: args.applicationId },
    });
    const newOauthConfig = {
      ...((application.oauthConfig as unknown as Record<string, OAuthPublicConfigEntry>) ?? {}),
    };
    delete newOauthConfig[args.providerName];
    const newSecrets = { ...decryptedSecrets(application) };
    delete newSecrets[args.providerName];
    await prisma.application.update({
      where: { id: application.id },
      data: {
        oauthConfig: newOauthConfig as never,
        oauthCredentialsCiphertext:
          Object.keys(newSecrets).length === 0 ? null : encryptJson(newSecrets),
      },
    });
  },
};

