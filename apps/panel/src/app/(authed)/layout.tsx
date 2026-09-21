import * as React from 'react';
import { Suspense } from 'react';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { landedFromServerAction } from '@/lib/action-landing';
import { RefreshAfterAction } from '@/components/RefreshAfterAction';
import { ACCESS_COOKIE, REFRESH_COOKIE, api, clearSessionCookies, setSessionCookies, publicPost, PanelApiError, type AuthResponse, getMe, getWorkspaceCreationOpen } from '@/lib/api';
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
// subtree, not loading.tsx, not error.tsx, literally an empty page. Normally
// nobody sees that window, because the router seeds its prefetch cache with
// the RSC payload the action just rendered and the transition commits on the
// spot. But it only seeds when the action didn't revalidate; calling
// revalidatePath flips that flag off, so the redirect has to go back over the
// network for a fresh payload, and the page is blank for the whole round-trip
// (vercel/next.js#73317).
//
// There is no server cache for it to clear anyway. This layout awaits
// cookies(), which makes every authed route dynamic, so no Full Route Cache
// entry exists, and `src/lib/api.ts` fetches with `cache: 'no-store'`, so no
// Data Cache entries either.
//
// What CAN be stale after a write is the client router's prefetch cache, and
// an earlier version of this comment was wrong about it. In Next 15.5.18
// (`client/components/router-reducer/reducers/server-action-reducer.js`):
//
//   1. The action response already contains the redirect destination, rendered
//      by Next after the action ran (`createRedirectRenderResult` in
//      `server/app-render/action-handler.js`). That payload replaces the
//      router's segment cache. The page you land on is fresh either way.
//   2. With no revalidation, that payload is seeded into the EXISTING prefetch
//      cache (`createSeededPrefetchCacheEntry({ prefetchCache:
//      state.prefetchCache })`) and the existing cache is kept. With
//      `staleTimes.dynamic: 30` every page visited in the last 30 seconds is
//      still in there, holding its pre-write render. (Nothing is prefetched
//      any more, see `components/Link.tsx`, but visits are cached the same
//      way.) Go back to the Overview tab after a save on Subscriptions and you
//      see the old one.
//   3. With revalidation the seed is skipped and the prefetch cache is emptied,
//      which is fresh but blank (the bug above).
//
// So neither setting of revalidatePath gives both. The panel takes 2 and closes
// its gap on the client: when this render is the destination of an action
// redirect (`landedFromServerAction`), it mounts `<RefreshAfterAction>` with a
// fresh id, which calls `router.refresh()` once. A refresh keeps the current UI
// on screen while it refetches, never goes through RedirectBoundary, and empties
// the prefetch cache (`reducers/refresh-reducer.js`).
//
// The cost is one extra render of the WHOLE tree (every layout plus the page,
// five or six API calls on an end-user tab) per action, so `lib/refresh-once.ts`
// makes sure it is one per action: retried only when Next discarded it (a
// committed refresh unmounts the component), at most three tries, and not
// until the landing page has finished streaming and no form is submitting.
// It still fires when the operator has already moved to another tab, because
// that tab may be served from the router cache with its pre-write render. The version before that
// re-ran on every URL change while mounted, and on a production build it was
// sometimes discarded outright by a navigation or the flag-stripping
// `history.replaceState` racing it, leaving the stale cache in place.
// `test/action-landing.test.ts` pins every runtime fact above against the
// installed Next, and `test/refresh-once.test.ts` pins the scheduling rules.
//
// If you need an action to refresh data *without* navigating, call
// revalidatePath and return a result instead of redirecting; the super-admin
// dashboard's operator-invites actions use that shape.

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
  await setSessionCookies(result);
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
    // so an uncaught refusal here renders the segment error boundary, a
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
  await setSessionCookies(switched);
  redirect('/applications?e=ws_created');
}

export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE)?.value) redirect('/login');
  const actionId = landedFromServerAction(await headers()) ? randomUUID() : null;

  // Operator MCP consent resumes here. The /mcp-consent page (outside this
  // group) bounces an unauthenticated operator to /login after stashing the
  // OAuth params in `mcp_consent_pending`. Every login factor lands in this
  // authed group, so this single check resumes the consent flow regardless of
  // how they signed in. /mcp-consent reads the params back out of the cookie.
  if (jar.get('mcp_consent_pending')?.value) redirect('/mcp-consent/review');

  // In parallel: they were awaited one after the other, which put two API
  // round-trips in series in front of every authed page's first byte. The
  // creation mode is also cached across requests (see
  // `getWorkspaceCreationOpen`), so on most renders it costs nothing at all.
  //
  // Don't offer a door that will not open. A deployment can switch additional
  // workspace creation off (`WORKSPACE_CREATION=disabled`), Rekey Cloud does,
  // because there provisioning is brokered by billing against the plan's paid
  // allowance rather than being self-serve. The probe fails OPEN; see
  // `getWorkspaceCreationOpen` for why.
  const [me, canCreateWorkspace] = await Promise.all([getMe(), getWorkspaceCreationOpen()]);
  const active = me.memberships.find((m) => m.tenantId === me.activeTenantId);

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
          scroll, which silently breaks `position: sticky` for everything
          inside it, since sticky resolves against the nearest scrolling
          ancestor. `clip` gives the same "don't let wide content widen the
          page" behaviour without creating that box, so the sticky save footer
          on Auth methods / Access actually sticks. */}
      <main id="main" tabIndex={-1} className="flex-1 min-w-0 overflow-x-clip outline-none">
        {/* Renders nothing unless a backing service is actually unreachable.
            Suspended on its own: it is an async component rendered directly in
            the layout, so without a boundary the layout cannot flush until the
            probe resolves, and `loading.tsx` only wraps {children}, so a slow
            probe meant a blank page instead of the skeleton on every Data Cache
            miss. Losing the banner is an acceptable failure; holding every
            authed page behind it is not. */}
        <Suspense fallback={null}>
          <DependencyBanner />
        </Suspense>
        {children}
      </main>
      {/* Cmd+K palette, a client island; available on every authed page. */}
      <CommandPalette />
      {/* Only on the render a server action redirected to; see the comment at
          the top of this file. Last in the tree so its effect runs after the
          page's own. The id is per action: the component refreshes at most
          once per id, and the key remounts it even when two actions land on
          the same URL back to back. */}
      {actionId !== null && (
        <Suspense key={actionId} fallback={null}>
          <RefreshAfterAction actionId={actionId} />
        </Suspense>
      )}
    </div>
  );
}
