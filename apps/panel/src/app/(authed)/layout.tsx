import * as React from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
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
import { TrackView } from '@/components/analytics/track-view';
import { AnalyticsEvent } from '@/lib/analytics';

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
  revalidatePath('/applications');
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
  revalidatePath('/applications');
  redirect('/applications?e=ws_created');
}

export default async function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE)?.value) redirect('/login');

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
        {children}
      </main>
      {/* Cmd+K palette — a client island; available on every authed page. */}
      <CommandPalette />
    </div>
  );
}
