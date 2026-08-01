/**
 * Google OAuth 2.0 provider.
 *
 * Standard authorization-code flow. Returns the user's `sub` claim from the
 * id_token (Google's stable account id) plus the email.
 *
 * This implementation makes real outbound calls to Google. In tests we
 * inject a mock provider via the registry — see `test/phase4.test.ts`,
 * `test/security.test.ts` and `test/tenant-oauth.test.ts`.
 */

import { fetchJsonWithTimeout } from './_oauth2-base.js';
import type {
  BuildAuthUrlInput,
  ExchangeInput,
  OAuthIdentityResult,
  OAuthProvider,
} from './types.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_SCOPES = ['openid', 'email', 'profile'];

interface IdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

function decodeIdTokenPayload(idToken: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const payload = parts[1]!;
  // base64url → utf8. Don't VERIFY here — Google's HTTPS connection is
  // the trust anchor (we got the token from oauth2.googleapis.com).
  // Production-grade: validate signature against Google's JWKS.
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as IdTokenClaims;
}

export class GoogleProvider implements OAuthProvider {
  readonly name = 'google';

  buildAuthUrl(input: BuildAuthUrlInput): string {
    const params = new URLSearchParams({
      client_id: input.config.clientId,
      redirect_uri: input.config.redirectUri,
      response_type: 'code',
      scope: (input.scopes ?? DEFAULT_SCOPES).join(' '),
      state: input.state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchange(input: ExchangeInput): Promise<OAuthIdentityResult> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      redirect_uri: input.config.redirectUri,
    });
    const res = await fetchJsonWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: HTTP ${res.status}`);
    }
    const data = (res.data ?? {}) as { id_token?: string };
    if (!data.id_token) throw new Error('Google token response missing id_token');
    const claims = decodeIdTokenPayload(data.id_token);
    // Google's id_token includes `email_verified`. Treat absence as
    // unverified — never opt-in to "trusted unless told otherwise."
    const verified = claims.email_verified === true;
    return {
      providerAccountId: claims.sub,
      email: claims.email ?? null,
      emailVerified: verified && Boolean(claims.email),
    };
  }
}
