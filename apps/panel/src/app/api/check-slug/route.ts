/**
 * GET /api/check-slug?slug=foo
 *
 * Thin proxy to the API's `/api/v1/tenant/applications/check-slug` endpoint.
 * Lives here (in the panel's own /api/* namespace) so the client component
 * can fetch it without exposing the operator JWT — `api()` reads cookies
 * server-side and adds Authorization, so we keep that pattern intact.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { api, PanelApiError } from '@/lib/api';

export async function GET(req: NextRequest): Promise<Response> {
  const slug = req.nextUrl.searchParams.get('slug') ?? '';
  if (!slug) {
    return NextResponse.json({ available: false, reason: 'missing' });
  }
  try {
    const data = await api<{ slug: string; available: boolean; reason?: string }>({
      method: 'GET',
      path: `/api/v1/tenant/applications/check-slug?slug=${encodeURIComponent(slug)}`,
      redirectOn401: false,
    });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof PanelApiError) {
      return NextResponse.json({ available: false, reason: err.code }, { status: err.statusCode });
    }
    throw err;
  }
}
