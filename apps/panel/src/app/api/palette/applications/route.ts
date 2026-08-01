/**
 * GET /api/palette/applications
 *
 * Thin proxy used by the command palette (a client island — it can't call
 * the operator API directly because the session lives in httpOnly cookies
 * that only the panel server can exchange for a Bearer token). Mirrors the
 * check-slug proxy pattern: `api()` reads cookies, attaches Authorization,
 * and handles the refresh dance.
 *
 * Returns a deliberately slim payload — just what the palette needs to
 * render "jump to application" entries and gate billing section jumps.
 */

import { NextResponse } from 'next/server';
import { api, PanelApiError, type ApplicationRow } from '@/lib/api';

export interface PaletteApplication {
  id: string;
  name: string;
  slug: string;
  billingEnabled: boolean;
}

export async function GET(): Promise<Response> {
  try {
    const apps = await api<ApplicationRow[]>({
      method: 'GET',
      path: '/api/v1/tenant/applications/?limit=100&offset=0',
      redirectOn401: false,
      // JSON proxy — degrade to an empty list rather than rendering a 404 page
      // into the command palette's fetch.
      interruptOnAccessError: false,
    });
    const slim: PaletteApplication[] = apps.map((a) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      billingEnabled: a.billingConfig.enabled,
    }));
    return NextResponse.json(slim, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof PanelApiError) {
      // Palette degrades gracefully — an empty list, never a crash.
      return NextResponse.json([], { status: err.statusCode });
    }
    throw err;
  }
}
