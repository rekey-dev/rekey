/**
 * CSV export proxy for one list's members, the same pattern as the audit-log
 * and DSAR exports: cookie to Authorization header, then the API's CSV
 * streamed back as a download. The API refuses anyone below OWNER or ADMIN.
 */

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE, apiCallerHeaders } from '@/lib/api';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; listId: string }> },
): Promise<Response> {
  const { id, listId } = await params;
  const base = process.env.REKEY_URL?.replace(/\/$/, '');
  if (!base) {
    return new Response('REKEY_URL is not configured on the panel deployment.', { status: 500 });
  }
  const access = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!access) {
    return new Response(null, { status: 303, headers: { location: '/login?reason=expired' } });
  }

  const res = await fetch(
    `${base}/api/v1/tenant/applications/${encodeURIComponent(id)}/lists/${encodeURIComponent(listId)}/export.csv`,
    {
      headers: { ...(await apiCallerHeaders()), authorization: `Bearer ${access}` },
      cache: 'no-store',
    },
  );
  if (res.status === 401) {
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
      'content-disposition': res.headers.get('content-disposition') ?? 'attachment; filename="members.csv"',
      'cache-control': 'no-store',
    },
  });
}
