/**
 * Shared OAuth 2.0 helpers used by the static providers (Microsoft, Discord,
 * GitLab, Slack). Each concrete provider declares its endpoint URLs + scopes
 * and how to map the provider's user response to {providerAccountId, email}.
 *
 * For OIDC (`oidc.ts`) we discover endpoints from the issuer's
 * `/.well-known/openid-configuration` instead — see that file.
 */

import type {
  BuildAuthUrlInput,
  ExchangeInput,
  OAuthIdentityResult,
  OAuthProvider,
} from './types.js';

/**
 * Hard ceiling on any outbound provider call. A wedged IdP must surface as a
 * fast failure, not an indefinitely-hung exchange holding the request open
 * (same posture as webhook.service.ts's delivery timeout).
 */
const OUTBOUND_TIMEOUT_MS = 10_000;

export interface TimedJsonResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or `null` when the body wasn't valid JSON. */
  data: unknown;
}

/**
 * `fetch` + JSON parse under one AbortController timeout. The timer covers
 * the body read too — a server that returns headers promptly but trickles
 * the body can't hold us past the deadline.
 */
export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = OUTBOUND_TIMEOUT_MS,
): Promise<TimedJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // Non-JSON / empty body — callers treat `data: null` as missing fields.
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export interface StaticOAuthDef {
  name: string;
  authUrl: string;
  tokenUrl: string;
  /** Optional userinfo endpoint hit after the token exchange. */
  userInfoUrl: string | null;
  defaultScopes: string[];
  /**
   * Map the userinfo / id_token claims to a stable identity result. Receives
   * the parsed userinfo response (or id_token claims when userInfoUrl is null).
   */
  toIdentity: (data: Record<string, unknown>) => OAuthIdentityResult;
  /** Extra params to include on the auth URL (e.g. `prompt=select_account`). */
  extraAuthParams?: Record<string, string>;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const payload = parts[1]!;
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Surface { email, emailVerified } from OIDC-style id_token / userinfo
 * claims. Used by every provider that follows the OIDC convention
 * (Google, Microsoft, Slack, OIDC, etc.).
 *
 * Falls back to `preferred_username` when `email` is missing but the
 * username happens to be an email-shaped string — Microsoft consumer
 * accounts hit this path.
 *
 * **Default is unverified.** `email_verified` must be exactly `true` to
 * count as verified. Absence or any other truthy-looking value is treated
 * as not-verified, which is the safe default for the auto-link gate.
 */
export function emailFromClaims(claims: Record<string, unknown>): {
  email: string | null;
  emailVerified: boolean;
} {
  const emailClaim = typeof claims['email'] === 'string' ? (claims['email'] as string) : '';
  const pufallback =
    typeof claims['preferred_username'] === 'string'
      ? (claims['preferred_username'] as string)
      : '';
  const email =
    emailClaim.length > 0 ? emailClaim : pufallback.includes('@') ? pufallback : null;
  const emailVerified = claims['email_verified'] === true && email !== null;
  return { email, emailVerified };
}

export class StaticOAuth2Provider implements OAuthProvider {
  readonly name: string;
  private readonly def: StaticOAuthDef;

  constructor(def: StaticOAuthDef) {
    this.name = def.name;
    this.def = def;
  }

  buildAuthUrl(input: BuildAuthUrlInput): string {
    const params = new URLSearchParams({
      client_id: input.config.clientId,
      redirect_uri: input.config.redirectUri,
      response_type: 'code',
      scope: (input.scopes ?? this.def.defaultScopes).join(' '),
      state: input.state,
      ...(this.def.extraAuthParams ?? {}),
    });
    return `${this.def.authUrl}?${params.toString()}`;
  }

  async exchange(input: ExchangeInput): Promise<OAuthIdentityResult> {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      redirect_uri: input.config.redirectUri,
    });
    const tokenRes = await fetchJsonWithTimeout(this.def.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(`${this.name} token exchange failed: HTTP ${tokenRes.status}`);
    }
    const tokenData = (tokenRes.data ?? {}) as {
      access_token?: string;
      id_token?: string;
    };

    // Prefer id_token claims when present (no extra round-trip); otherwise
    // hit userinfo with the access token.
    if (tokenData.id_token) {
      const claims = decodeJwtPayload(tokenData.id_token);
      return this.def.toIdentity(claims);
    }

    if (!this.def.userInfoUrl) {
      throw new Error(`${this.name}: token response missing id_token and no userInfoUrl is configured`);
    }
    if (!tokenData.access_token) {
      throw new Error(`${this.name}: token response missing access_token`);
    }
    const userRes = await fetchJsonWithTimeout(this.def.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    if (!userRes.ok) {
      throw new Error(`${this.name} userinfo failed: HTTP ${userRes.status}`);
    }
    const data = (userRes.data ?? {}) as Record<string, unknown>;
    return this.def.toIdentity(data);
  }
}
