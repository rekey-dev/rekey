/**
 * CSV export proxy for the audit log.
 *
 * The browser can't call the API directly (the operator session lives in an
 * httpOnly cookie the panel exchanges for a Bearer token), so this Route
 * Handler forwards the request: cookie → Authorization header → API
 * `?format=csv`, then streams the CSV back as a download. Filters
 * (type/actorType/from/to) pass through from the query string.
 */

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '@/lib/api';

const PASSTHROUGH_PARAMS = ['applicationId', 'type', 'actorType', 'from', 'to'] as const;

export async function GET(req: NextRequest): Promise<Response> {
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

  const qs = new URLSearchParams({ format: 'csv' });
  for (const key of PASSTHROUGH_PARAMS) {
    const value = req.nextUrl.searchParams.get(key);
    if (value) qs.set(key, value);
  }

  const res = await fetch(`${base}/api/v1/tenant/security-events?${qs.toString()}`, {
    headers: { authorization: `Bearer ${access}` },
    cache: 'no-store',
  });
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
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="audit-log.csv"',
      'cache-control': 'no-store',
    },
  });
}
