/**
 * Authorization requests waiting for the hosted portal to ask the end-user.
 *
 * When the hosted portal is an Application's authorization page, `/authorize`
 * validates the request, stores it here and sends the browser to the portal
 * with nothing but the id. The portal then reads the request back through
 * `/oauth/authorize/preview` and finishes it through `/grant` or `/deny`.
 *
 * The parameters stay on the server so the portal cannot be handed a client,
 * redirect URI or PKCE challenge the client never asked `/authorize` for: a
 * request the portal can finish is always one that came through the
 * authorization endpoint's own checks.
 *
 * Falls back to process memory without Redis, like `lib/pkce-store.ts`: right
 * for a single replica and for tests, and hosted deployments run Redis.
 */

import { randomBytes } from 'node:crypto';
import { getRedis } from '../../lib/redis.js';

const KEY_PREFIX = 'oauth:authorize-request:';

/** As long as the portal remembers where to return after sign-in, so an emailed link or an email confirmation still finds the request. */
export const AUTHORIZATION_REQUEST_TTL_SECONDS = 15 * 60;

/** 32 random bytes, base64url. The portal matches this exact shape before it stores an id. */
export const AUTHORIZATION_REQUEST_ID = /^[A-Za-z0-9_-]{43}$/;

export interface AuthorizationRequest {
  applicationId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The scope the client asked for, re-granted at each step so a setting changed in between still applies. */
  scope?: string | undefined;
  state?: string | undefined;
  nonce?: string | undefined;
}

const memory = new Map<string, { request: AuthorizationRequest; expiresAt: number }>();

function sweepMemory(now: number): void {
  for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
}

/** Store a validated request and return its id. */
export async function storeAuthorizationRequest(request: AuthorizationRequest): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  const redis = getRedis();
  if (!redis) {
    sweepMemory(Date.now());
    memory.set(KEY_PREFIX + id, { request, expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_SECONDS * 1000 });
    return id;
  }
  await redis.set(KEY_PREFIX + id, JSON.stringify(request), 'EX', AUTHORIZATION_REQUEST_TTL_SECONDS);
  return id;
}

/** Read without spending. Null when unknown, expired or already finished. */
export async function peekAuthorizationRequest(id: string): Promise<AuthorizationRequest | null> {
  if (!AUTHORIZATION_REQUEST_ID.test(id)) return null;
  const redis = getRedis();
  if (!redis) {
    sweepMemory(Date.now());
    return memory.get(KEY_PREFIX + id)?.request ?? null;
  }
  const raw = await redis.get(KEY_PREFIX + id);
  return raw ? (JSON.parse(raw) as AuthorizationRequest) : null;
}

/** Read and delete in one step, so two concurrent answers cannot both finish one request. */
export async function takeAuthorizationRequest(id: string): Promise<AuthorizationRequest | null> {
  if (!AUTHORIZATION_REQUEST_ID.test(id)) return null;
  const redis = getRedis();
  if (!redis) {
    sweepMemory(Date.now());
    const hit = memory.get(KEY_PREFIX + id);
    memory.delete(KEY_PREFIX + id);
    return hit?.request ?? null;
  }
  const raw = await redis.getdel(KEY_PREFIX + id);
  return raw ? (JSON.parse(raw) as AuthorizationRequest) : null;
}

/** The client's redirect URI with the OAuth answer and the client's own `state` on it. */
export function redirectWithAnswer(request: AuthorizationRequest, answer: Record<string, string>): string {
  const url = new URL(request.redirectUri);
  for (const [k, v] of Object.entries(answer)) url.searchParams.set(k, v);
  if (request.state) url.searchParams.set('state', request.state);
  return url.toString();
}
