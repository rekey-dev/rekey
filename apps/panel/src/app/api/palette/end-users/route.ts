/**
 * GET /api/palette/end-users?app=<applicationId>&q=<query>
 *
 * The command palette's end-user lookup, scoped to one application. Same
 * proxy shape as /api/palette/applications: the operator session stays in
 * httpOnly cookies and the API enforces the member's grants, so any refusal
 * comes back as an empty list.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { api, PanelApiError, type EndUserRow } from '@/lib/api';
import type { Page } from '@/lib/paginate';

const RESULT_LIMIT = 5;

export interface PaletteEndUser {
  id: string;
  email: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const app = req.nextUrl.searchParams.get('app')?.trim() ?? '';
  const search = req.nextUrl.searchParams.get('q')?.trim().slice(0, 254) ?? '';
  if (!app || !search) return NextResponse.json([]);
  const qs = new URLSearchParams({ search, limit: String(RESULT_LIMIT), offset: '0' });
  try {
    const { items } = await api<Page<EndUserRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(app)}/end-users?${qs.toString()}`,
      redirectOn401: false,
      interruptOnAccessError: false,
    });
    const slim: PaletteEndUser[] = items.slice(0, RESULT_LIMIT).map((u) => ({ id: u.id, email: u.email }));
    return NextResponse.json(slim, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof PanelApiError) return NextResponse.json([], { status: err.statusCode });
    throw err;
  }
}
