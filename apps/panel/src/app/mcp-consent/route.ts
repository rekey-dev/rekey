/**
 * Operator MCP OAuth consent — entry point.
 *
 * The API's `/api/v1/tenant/mcp/oauth/authorize` redirects the browser here
 * with the OAuth params. This is a Route Handler (not a page) because it must
 * SET a cookie, which Next forbids during a Server Component render.
 *
 * It stashes the OAuth params in a short-lived httpOnly cookie and bounces:
 *   - not signed in → /login (any login factor lands in the authed group,
 *     whose layout sees the cookie and resumes at /mcp-consent/review);
 *   - signed in      → /mcp-consent/review directly.
 *
 * The review page reads the params back out of the cookie, so the operator can
 * complete the full panel login (passkeys, MFA, magic-link) in between without
 * us threading the params through every login flow.
 */

import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/api';
import { CONSENT_COOKIE } from './consent-cookie';

const PARAM_KEYS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'state',
] as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const params: Record<string, string> = {};
  for (const k of PARAM_KEYS) {
    const v = sp.get(k);
    if (v) params[k] = v;
  }
  // Minimal sanity — the API already validated the client/redirect before
  // redirecting here, but never trust that blindly.
  if (!params.client_id || !params.redirect_uri) {
    return new NextResponse('Invalid authorization request.', {
      status: 400,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const jar = await cookies();
  const authed = Boolean(jar.get(ACCESS_COOKIE)?.value);
  // Relative Location — both targets are same-origin (this panel). Do NOT build
  // an absolute URL from `req.nextUrl.origin`: behind a reverse proxy
  // (Dokploy/Traefik) that resolves to the container's internal bind address
  // (e.g. 0.0.0.0:3031), so the browser would be sent to a dead host. A
  // relative Location is resolved by the browser against the public URL.
  const dest = authed ? '/mcp-consent/review' : '/login';
  const res = new NextResponse(null, { status: 303, headers: { Location: dest } });
  res.cookies.set(CONSENT_COOKIE, JSON.stringify(params), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 15 * 60,
  });
  return res;
}
