import * as React from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE, REFRESH_COOKIE, api, clearSessionCookies, setSessionCookies, publicPost, PanelApiError, type AuthResponse, getMe } from '@/lib/api';
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
// — the super-admin dashboard's operator-invites actions use that shape.

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
  let created: { id: string; name: string };
  try {
    created = await api<{ id: string; name: string }>({
      method: 'POST',
      path: '/api/v1/tenant/workspace/',
      body: { name },
    });
  } catch (err) {
    // A POST does not trigger the `forbidden()` interrupt (that is GET-only),
    // so an uncaught refusal here renders the segment error boundary — a
    // generic "something went wrong" with a Try again button that can never
    // succeed. The deployment switch is a legitimate, permanent answer, so it
    // has to read as one. The affordance is normally hidden (see
    // `canCreateWorkspace` below); this catches the race where it was
    // rendered from a stale probe, or turned off mid-session.
    if (err instanceof PanelApiError && err.code === 'WORKSPACE_CREATION_DISABLED') {
      redirect('/applications?e=ws_create_disabled');
    }
    throw err;
  }
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

  const me = await getMe();
  const active = me.memberships.find((m) => m.tenantId === me.activeTenantId);

  // Don't offer a door that will not open. A deployment can switch additional
  // workspace creation off (`WORKSPACE_CREATION=disabled`) — Rekey Cloud does,
  // because there provisioning is brokered by billing against the plan's paid
  // allowance rather than being self-serve.
  //
  // Fails OPEN, matching `fetchSignupMode` on the sign-up page and
  // `canManageApps` on the applications page: if the probe itself fails we
  // still render the affordance and let the server refuse, because hiding a
  // capability the operator actually has is the worse error. The refusal is
  // handled properly in `createWorkspace` above either way.
  const canCreateWorkspace = await api<{ mode: 'open' | 'disabled' }>({
    method: 'GET',
    path: '/api/v1/tenant/workspace/creation-mode',
  })
    .then((d) => d.mode !== 'disabled')
    .catch(() => true);

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-neutral-50 dark:bg-neutral-950">
      {/* Fires once when the operator enters the authed area (panel session). */}
      <TrackView event={AnalyticsEvent.PanelAccess} />
      {/* Keyboard users skip straight past the sidebar nav (WP6). */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:bg-[var(--color-primary)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--color-primary-fg)]"
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
            {...(canCreateWorkspace && { createWorkspaceAction: createWorkspace })}
            signOutAction={signOut}
          />
        }
      />
      {/* `overflow-x-clip`, not `overflow-x-hidden`. `hidden` makes this a
          scroll container (the y axis is forced to `auto`), and because <main>
          is never height-constrained it is a scroll container that can never
          scroll — which silently breaks `position: sticky` for everything
          inside it, since sticky resolves against the nearest scrolling
          ancestor. `clip` gives the same "don't let wide content widen the
          page" behaviour without creating that box, so the sticky save footer
          on Auth methods / Access actually sticks. */}
      <main id="main" tabIndex={-1} className="flex-1 min-w-0 overflow-x-clip outline-none">
        {/* Renders nothing unless a backing service is actually unreachable. */}
        <DependencyBanner />
        {children}
      </main>
      {/* Cmd+K palette — a client island; available on every authed page. */}
      <CommandPalette />
    </div>
  );
}
