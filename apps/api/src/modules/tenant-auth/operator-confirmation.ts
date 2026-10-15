import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { panelBaseUrl } from '../../lib/panel-url.js';

/**
 * Whether this deployment gives an operator any way to prove a mailbox: mail
 * it can send, a sign-in provider, the ID Token handoff, or echoed tokens in
 * development.
 *
 * A fresh self-hosted install has none of them. There the takeover cannot
 * happen, because nobody can ever arrive by proving the mailbox, and refusing
 * access tokens to an operator who has no way to confirm would leave the CLI
 * and the MCP server unusable for good. Once one is configured the refusals
 * apply, and whatever was added before is removed by the first claim.
 */
export const operatorConfirmation = {
  ways(): { mail: boolean; provider: boolean; handoff: boolean } {
    const panel = panelBaseUrl() !== null;
    // Tokens echoed in the response stand in for the mail in development and
    // under test: every emailed link can be followed without a transport.
    const echoedTokens =
      env.NODE_ENV === 'test' ||
      (env.NODE_ENV === 'development' && process.env.REKEY_DEV_ECHO_AUTH_TOKENS === 'true');
    return {
      mail: (panel && Boolean(env.RESEND_DEFAULT_API_KEY && env.RESEND_DEFAULT_FROM)) || echoedTokens,
      provider:
        panel &&
        (Boolean(env.PANEL_OAUTH_GOOGLE_CLIENT_ID && env.PANEL_OAUTH_GOOGLE_CLIENT_SECRET) ||
          Boolean(env.PANEL_OAUTH_GITHUB_CLIENT_ID && env.PANEL_OAUTH_GITHUB_CLIENT_SECRET) ||
          Boolean(env.PANEL_OAUTH_REKEY_CLIENT_ID && env.PANEL_OAUTH_REKEY_ISSUER)),
      handoff: Boolean(env.OPERATOR_OIDC_ISSUER && env.OPERATOR_OIDC_CLIENT_ID),
    };
  },
  possible(): boolean {
    const ways = operatorConfirmation.ways();
    return ways.mail || ways.provider || ways.handoff;
  },
};

/**
 * What an unconfirmed operator can do about it on THIS deployment, as the
 * `fix` of every refusal. Only remedies that exist here are named, and each
 * says what it does to the account: the confirmation email changes nothing
 * else; a sign-in link, a provider or a reset replaces what was set before,
 * except that with two-factor on they remove nothing and a reset confirms
 * nothing (it gives no session in which to ask for the code).
 *
 * @example
 *   fix: operatorConfirmationFix({ hasSecondFactor: false })
 */
export function operatorConfirmationFix(account: { hasSecondFactor: boolean }): string {
  const ways = operatorConfirmation.ways();
  const steps: string[] = [];
  if (ways.mail) {
    steps.push(
      'Open the link in the confirmation email for this account while signed in: POST /api/v1/tenant/auth/resend-verification with your session sends a new one, and POST /api/v1/tenant/auth/verify-email with your session and the token from that link confirms the address. That changes nothing else: your password, access tokens and MCP grants stay.',
    );
  }
  const bySignIn = [
    ...(ways.mail ? ['an emailed link (POST /api/v1/tenant/auth/magic-link/request, then /magic-link/verify)'] : []),
    ...(ways.provider ? ['a sign-in provider the panel offers'] : []),
    ...(ways.handoff ? ['the site that sent you here (its sign-in handoff)'] : []),
  ];
  if (bySignIn.length > 0) {
    steps.push(
      account.hasSecondFactor
        ? `Signing in with ${bySignIn.join(', or with ')} also confirms it once you enter your two-factor code, and removes nothing.`
        : `Signing in with ${bySignIn.join(', or with ')} also confirms it, and removes the current password, passkeys, access tokens and MCP grants.`,
    );
  }
  if (ways.mail && !account.hasSecondFactor) {
    steps.push(
      'So does completing a password reset (POST /api/v1/tenant/auth/forgot-password, then /reset-password): it keeps the password you choose there and removes passkeys, access tokens and MCP grants.',
    );
  }
  return steps.join(' ');
}

/**
 * Refuse an unconfirmed operator anything that outlives their session or
 * carries data out of the workspace.
 *
 * A passkey, a second factor, an access token or an MCP grant added before
 * the mailbox is proven would outlive the password as a way in for whoever
 * registered the address first. So would a second owner they invited, an
 * Application key they minted, or a webhook they pointed at their own server.
 * Read from the database, not from the cached session: the answer changes the
 * moment the operator confirms.
 *
 * @example
 *   await assertOperatorVerifiedForCredential(req.tenantUser!.id, 'create an access token');
 */
export async function assertOperatorVerifiedForCredential(
  tenantUserId: string,
  action: string,
): Promise<void> {
  if (!operatorConfirmation.possible()) return;
  const user = await prisma.tenantUser.findUnique({
    where: { id: tenantUserId },
    select: { emailVerified: true, mfaCredential: { select: { enrolledAt: true } } },
  });
  if (user?.emailVerified) return;
  throw new RekeyError({
    statusCode: 403,
    code: 'EMAIL_NOT_VERIFIED',
    message: `Confirm this account's email address before you ${action}.`,
    fix: operatorConfirmationFix({ hasSecondFactor: Boolean(user?.mfaCredential?.enrolledAt) }),
  });
}
