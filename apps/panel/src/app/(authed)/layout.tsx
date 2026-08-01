import * as React from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  api,
  clearSessionCookies,
  setSessionCookies,
  publicPost,
  type MeDto,
  type AuthResponse,
} from '@/lib/api';
import { Sidebar } from '@/components/Sidebar';
import { MobileSidebar } from '@/components/MobileSidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { DependencyBanner } from '@/components/DependencyBanner';
import { TrackView } from '@/components/analytics/track-view';
import { AnalyticsEvent } from '@/lib/analytics';

// ─── Why no server action in the panel calls revalidatePath ──────────────
//
// Every mutating action here ends in `redirect()`, and pairing the two is
// what made the panel go blank after "create API key" and "create webhook":
// the operator's row was written, but the page rendered nothing until they
// hit refresh by hand.
//
// The mechanism is a guard in Next's client router. While a redirect from a
// server action is in flight, RedirectBoundary renders `null` for the whole
// subtree — not loading.tsx, not error.tsx, literally an empty page. Normally
// nobody sees that window, because the router seeds its prefetch cache with
// the RSC payload the action just rendered and the transition commits on the
// spot. But it only seeds when the action didn't revalidate; calling
// revalidatePath flips that flag off, so the redirect has to go back over the
// network for a fresh payload, and the page is blank for the whole round-trip
// (vercel/next.js#73317).
//
// Dropping revalidatePath costs us nothing, because there was never a cache
// for it to clear. This layout awaits cookies(), which makes every authed
// route dynamic — no Full Route Cache entry exists. `src/lib/api.ts` fetches
// with `cache: 'no-store'` — no Data Cache entries either. And the router
// wipes its client-side prefetch cache after *any* server action that returns
// flight data, revalidated or not. The one genuine cache in the panel is the
// 15-second dependency-banner probe in `api.ts`, which nothing here was
// invalidating on purpose anyway.
//
// So: in this app, `revalidatePath` + `redirect` in the same action is all
// cost and no benefit. If you need an action to refresh data *without*
// navigating, keep revalidatePath and return a result instead of redirecting
// — see `apps/admin/src/app/(authed)/operator-invites/actions.ts` for that
// shape.

async function signOut(): Promise<void> {
  'use server';
  const jar = await cookies();
  const refresh = jar.get(REFRESH_COOKIE)?.value;
  if (refresh) {
    await publicPost('/api/v1/tenant/auth/sign-out', { refreshToken: refresh }).catch(() => undefined);
  }
  await clearSessionCookies();
  redirect('/login?e=logout');
}

async function switchWorkspace(formData: FormData): Promise<void> {
  'use server';
  const tenantId = String(formData.get('tenantId') ?? '');
  if (!tenantId) return;
  const result = await api<AuthResponse>({
    method: 'POST',
    path: '/api/v1/tenant/auth/switch-workspace',
    body: { tenantId },
  });
  await setSessionCookies({ accessToken: result.accessToken, refreshToken: result.refreshToken });
  redirect('/applications?e=ws_switched');
}

async function createWorkspace(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const created = await api<{ id: string; name: string }>({
    method: 'POST',
    path: '/api/v1/tenant/workspace/',
    body: { name },
  });
  // Switch into the new workspace immediately so the operator lands inside it.
  const switched = await api<AuthResponse>({
    method: 'POST',
    path: '/api/v1/tenant/auth/switch-workspace',
    body: { tenantId: created.id },
  });
  await setSessionCookies({ accessToken: switched.accessToken, refreshToken: switched.refreshToken });
  redirect('/applications?e=ws_created');
}

export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE)?.value) redirect('/login');

  // Operator MCP consent resumes here. The /mcp-consent page (outside this
  // group) bounces an unauthenticated operator to /login after stashing the
  // OAuth params in `mcp_consent_pending`. Every login factor lands in this
  // authed group, so this single check resumes the consent flow regardless of
  // how they signed in. /mcp-consent reads the params back out of the cookie.
  if (jar.get('mcp_consent_pending')?.value) redirect('/mcp-consent/review');

  const me = await api<MeDto>({ method: 'GET', path: '/api/v1/tenant/auth/me' });
  const active = me.memberships.find((m) => m.tenantId === me.activeTenantId);

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-neutral-50 dark:bg-neutral-950">
      {/* Fires once when the operator enters the authed area (panel session). */}
      <TrackView event={AnalyticsEvent.PanelAccess} />
      {/* Keyboard users skip straight past the sidebar nav (WP6). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-[var(--color-primary)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to main content
      </a>
      <MobileSidebar
        sidebar={
          <Sidebar
            memberships={me.memberships}
            activeTenantId={me.activeTenantId}
            activeRole={active?.role ?? 'MEMBER'}
            userEmail={me.user.email}
            switchAction={switchWorkspace}
            createWorkspaceAction={createWorkspace}
            signOutAction={signOut}
          />
        }
      />
      <main id="main" tabIndex={-1} className="flex-1 min-w-0 overflow-x-hidden outline-none">
        {/* Renders nothing unless a backing service is actually unreachable. */}
        <DependencyBanner />
        {children}
      </main>
      {/* Cmd+K palette — a client island; available on every authed page. */}
      <CommandPalette />
    </div>
  );
}
