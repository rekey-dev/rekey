/**
 * JSON export proxy for one end-user's data (GDPR/DSAR).
 *
 * Same pattern as the audit-log CSV export: the browser can't call the API
 * directly (the operator session lives in an httpOnly cookie the panel
 * exchanges for a Bearer token), so this Route Handler forwards the request
 * — cookie → Authorization header → API export endpoint — and streams the
 * JSON document back as a download.
 */

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '@/lib/api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; euid: string }> },
): Promise<Response> {
  const { id, euid } = await params;
  const base = process.env.RELIPAY_URL?.replace(/\/$/, '');
  if (!base) {
    return new Response('RELIPAY_URL is not configured on the panel deployment.', { status: 500 });
  }
  const jar = await cookies();
  const access = jar.get(ACCESS_COOKIE)?.value;
  if (!access) {
    // Relative Location — `req.nextUrl` behind a proxy is the internal bind
    // address (0.0.0.0:3031); a relative redirect resolves against the public host.
    return new Response(null, { status: 303, headers: { location: '/login?reason=expired' } });
  }

  const res = await fetch(
    `${base}/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users/${encodeURIComponent(euid)}/export`,
    {
      headers: { authorization: `Bearer ${access}` },
      cache: 'no-store',
    },
  );
  if (res.status === 401) {
    // Access token expired mid-session — bounce through the login flow rather
    // than re-implementing the refresh dance for a download link.
    // Relative Location — `req.nextUrl` behind a proxy is the internal bind
    // address (0.0.0.0:3031); a relative redirect resolves against the public host.
    return new Response(null, { status: 303, headers: { location: '/login?reason=expired' } });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return new Response(body || `Export failed (HTTP ${res.status}).`, { status: res.status });
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="end-user-${euid}-export.json"`,
      'cache-control': 'no-store',
    },
  });
}
