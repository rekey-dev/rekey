/**
 * GitHub OAuth provider.
 *
 * GitHub doesn't return id_tokens — we exchange the code for an access
 * token, then call /user and /user/emails to identify the account.
 */

import { fetchJsonWithTimeout } from './_oauth2-base.js';
import type {
  BuildAuthUrlInput,
  ExchangeInput,
  OAuthIdentityResult,
  OAuthProvider,
} from './types.js';

const AUTH_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';
const DEFAULT_SCOPES = ['read:user', 'user:email'];

interface GithubUser {
  id: number;
  email: string | null;
}
interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export class GithubProvider implements OAuthProvider {
  readonly name = 'github';

  buildAuthUrl(input: BuildAuthUrlInput): string {
    const params = new URLSearchParams({
      client_id: input.config.clientId,
      redirect_uri: input.config.redirectUri,
      scope: (input.scopes ?? DEFAULT_SCOPES).join(' '),
      state: input.state,
      allow_signup: 'true',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchange(input: ExchangeInput): Promise<OAuthIdentityResult> {
    const tokenRes = await fetchJsonWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: input.config.clientId,
        client_secret: input.config.clientSecret,
        code: input.code,
        redirect_uri: input.config.redirectUri,
      }),
    });
    if (!tokenRes.ok) throw new Error(`GitHub token exchange failed: HTTP ${tokenRes.status}`);
    const tokenData = (tokenRes.data ?? {}) as { access_token?: string };
    if (!tokenData.access_token) throw new Error('GitHub token response missing access_token');

    const userRes = await fetchJsonWithTimeout(USER_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!userRes.ok) throw new Error(`GitHub /user failed: HTTP ${userRes.status}`);
    const user = (userRes.data ?? {}) as GithubUser;

    // GitHub /user.email is best-effort (only populated when the user's
    // public profile email is set). Always consult /user/emails so we can
    // surface verification status — required by the OAuth auto-link gate.
    let email: string | null = user.email;
    let emailVerified = false;
    const emailsRes = await fetchJsonWithTimeout(EMAILS_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (emailsRes.ok && Array.isArray(emailsRes.data)) {
      const emails = emailsRes.data as GithubEmail[];
      const primaryVerified = emails.find((e) => e.primary && e.verified);
      const anyVerified = emails.find((e) => e.verified);
      if (primaryVerified) {
        email = primaryVerified.email;
        emailVerified = true;
      } else if (anyVerified) {
        email = anyVerified.email;
        emailVerified = true;
      } else {
        email = emails.find((e) => e.primary)?.email ?? user.email ?? null;
        emailVerified = false;
      }
    }

    return {
      providerAccountId: String(user.id),
      email,
      emailVerified,
    };
  }
}
