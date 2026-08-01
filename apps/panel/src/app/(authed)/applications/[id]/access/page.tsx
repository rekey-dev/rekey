import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, PanelApiError, type ApplicationRow } from '@/lib/api';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { SavedBanner } from '@/components/SavedBanner';
import { StickyFormFooter } from '@/components/StickyFormFooter';
import { Banner } from '@/components/Banner';
import { PageHeader } from '@/components/PageHeader';

/** Split a textarea into trimmed non-empty lines (also tolerates commas). */
function parseList(raw: FormDataEntryValue | null): string[] {
  return String(raw ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function saveAccess(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const ipAllowlist = parseList(formData.get('ipAllowlist'));
  const corsOrigins = parseList(formData.get('corsOrigins'));
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/access`,
      body: { ipAllowlist, corsOrigins },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/access?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/access?saved=1`);
}

async function rotateSessions(applicationId: string): Promise<void> {
  'use server';
  try {
    const r = await api<{ sessionsRevoked: number }>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/rotate-sessions`,
    });
    redirect(`/applications/${applicationId}/access?rotated=${r.sessionsRevoked}`);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/access?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
}

const ERR: Record<string, string> = {
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can change access settings.',
  FST_ERR_VALIDATION: 'One or more entries are invalid. IPs must be IP/CIDR; origins like https://app.example.com.',
};

// `placeholder:` is the point of this class list. The example values in these
// two boxes render in the SAME mono face as a real entry, and measured at
// 7.4:1 they were no dimmer than configured text — on a security page, an
// empty IP allowlist looked exactly like one containing 10.0.0.0/8. Faint +
// italic makes the distinction visible without a second glance; the explicit
// state line below each box makes it unambiguous.
const textareaCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] placeholder:italic placeholder:text-[var(--color-faint-fg)] placeholder:opacity-70 focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

/**
 * Affirmative "what is in force right now" line, matching how the API-keys page
 * already states its origin rule ("No origin allowlist set — any website can
 * use this key"). An empty security control has to say what it means, not just
 * be empty.
 */
function StateLine({
  configured,
  emptyLabel,
  setLabel,
}: {
  configured: string[];
  emptyLabel: string;
  setLabel: (n: number) => string;
}): React.JSX.Element {
  const n = configured.length;
  return (
    <p
      className={`text-xs font-medium ${
        n === 0 ? 'text-amber-700 dark:text-amber-400' : 'text-[var(--color-fg)]'
      }`}
    >
      {n === 0 ? emptyLabel : setLabel(n)}
    </p>
  );
}

export default async function AccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const saved = sp.saved === '1';
  const rotated = typeof sp.rotated === 'string' ? sp.rotated : undefined;

  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
  const ipAllowlist = (app.ipAllowlist ?? []).join('\n');
  const corsOrigins = (app.corsOrigins ?? []).join('\n');

  return (
    <div className="space-y-5">
      <PageHeader
        level={2}
        title="Access controls"
        description="Restrict which IPs your server-side secret keys may call from, which browser origins may call the API, and force every end-user to re-authenticate."
      />

      {saved && <SavedBanner message="Access settings saved." />}
      {rotated !== undefined && (
        <SavedBanner
          params={['rotated']}
          message={`Sessions rotated — every end-user access token is now invalid and ${rotated} refresh token(s) were revoked.`}
        />
      )}
      {error && (
        <Banner tone="error">
          {ERR[error] ?? error}
        </Banner>
      )}

      <form
        action={saveAccess.bind(null, id)}
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]"
      >
        <div className="space-y-2 px-5 py-4">
          <label className="block text-sm font-medium text-[var(--color-fg)]" htmlFor="ipAllowlist">
            IP allowlist (secret keys)
          </label>
          <p className="text-xs text-[var(--color-muted-fg)]">
            One CIDR or IP per line (v4 + v6). When set, server-side <code>rp_live_</code>/
            <code>rp_test_</code> calls must originate from an allowed address. Empty = allow all.
            Browser (public-key) calls are never gated.
          </p>
          <StateLine
            configured={app.ipAllowlist ?? []}
            emptyLabel="No IP allowlist set — secret keys may be used from any address."
            setLabel={(n) => `${n} ${n === 1 ? 'entry' : 'entries'} in force — secret keys are refused from anywhere else.`}
          />
          <textarea
            id="ipAllowlist"
            name="ipAllowlist"
            defaultValue={ipAllowlist}
            rows={4}
            placeholder={'e.g. 10.0.0.0/8\ne.g. 203.0.113.4'}
            className={textareaCls}
          />
        </div>
        <div className="space-y-2 px-5 py-4">
          <label className="block text-sm font-medium text-[var(--color-fg)]" htmlFor="corsOrigins">
            CORS origins (browser)
          </label>
          <p className="text-xs text-[var(--color-muted-fg)]">
            One origin per line — scheme + host + optional port, no path (e.g.{' '}
            <code>https://app.example.com</code>). The API allows these origins for browser calls.
          </p>
          <StateLine
            configured={app.corsOrigins ?? []}
            emptyLabel="No origin allowlist set — any website can make browser calls with this app's publishable key."
            setLabel={(n) => `${n} ${n === 1 ? 'origin' : 'origins'} allowed — browser calls from anywhere else are refused.`}
          />
          <textarea
            id="corsOrigins"
            name="corsOrigins"
            defaultValue={corsOrigins}
            rows={4}
            placeholder={'e.g. https://app.example.com\ne.g. https://staging.example.com'}
            className={textareaCls}
          />
        </div>
        {/* Same footer as Auth methods — this page originated the in-card save
            pattern; it now also gets the dirty indicator and the route-change
            guard, so the two security pages behave identically. */}
        <div className="px-5 py-3">
          <StickyFormFooter hint="Applies to new requests immediately." />
        </div>
      </form>

      <div className="rounded-xl border border-red-300 dark:border-red-800 bg-red-50/40 dark:bg-red-950/30">
        <div className="flex items-start justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-red-700 dark:text-red-300">
              Force-logout all end-users
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
              Session kill-switch. Instantly invalidates every live end-user access token for this
              app and revokes all refresh tokens. Use after a leak or incident. Irreversible.
            </p>
          </div>
          <form action={rotateSessions.bind(null, id)} className="shrink-0">
            <TypedConfirmButton
              expected={app.slug}
              title="Force-logout all end-users?"
              description="Every live end-user access token for this application is invalidated and all refresh tokens are revoked — every user must sign in again. This cannot be undone."
              triggerLabel="Rotate sessions"
              confirmLabel="Rotate sessions"
            />
          </form>
        </div>
      </div>
    </div>
  );
}
