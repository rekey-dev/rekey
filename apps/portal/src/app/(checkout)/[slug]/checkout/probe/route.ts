/**
 * The portal's half of checkout readiness check 1. The API calls this with a
 * single-use nonce; the portal calls the API back with it and answers 200 only
 * when the API confirms the nonce was minted for this same slug. So a pass
 * proves both directions work and that this portal routes the slug.
 */

import { NextResponse } from 'next/server';
import { confirmProbe } from '@/lib/checkout-api';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const { slug } = await params;
  const nonce = new URL(req.url).searchParams.get('n') ?? '';
  const confirmed = await confirmProbe(nonce);
  const ok = confirmed !== null && confirmed === slug;
  return NextResponse.json(
    { ok, cspReports: ok },
    { status: ok ? 200 : 502, headers: { 'Cache-Control': 'no-store' } },
  );
}
