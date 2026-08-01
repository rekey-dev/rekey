import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, PanelApiError, type ApplicationRow } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { SectionHeader } from '@/components/Card';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';

// No fallback to Rekey's own hosted portal: on a self-hosted deployment that
// would show the operator a URL pointing at someone else's infrastructure for
// THEIR customers. Unset is surfaced to the operator instead.
const PORTAL_BASE = (process.env.NEXT_PUBLIC_PORTAL_URL || '<set NEXT_PUBLIC_PORTAL_URL>').replace(/\/$/, '');
const PORTAL_HOST = PORTAL_BASE.replace(/^https?:\/\//, '');

async function patchPortal(applicationId: string, body: Record<string, unknown>, flag: string): Promise<void> {
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/portal`,
    body,
  });
  redirect(`/applications/${applicationId}/portal?e=${flag}`);
}

async function setPortalEnabled(applicationId: string, enabled: boolean): Promise<void> {
  'use server';
  await patchPortal(applicationId, { enabled }, `portal_${enabled ? 'enabled' : 'disabled'}`);
}

/** Only absolute http(s) URLs survive — reject javascript:/data:/other schemes. */
function httpUrlOrEmpty(value: string): string {
  if (!value) return '';
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

async function saveBranding(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const str = (k: string): string => String(formData.get(k) ?? '').trim();
  const logoUrl = httpUrlOrEmpty(str('logoUrl'));
  if (str('logoUrl') && !logoUrl) {
    redirect(`/applications/${applicationId}/portal?error=INVALID_LOGO_URL`);
  }
  const supportUrl = httpUrlOrEmpty(str('supportUrl'));
  if (str('supportUrl') && !supportUrl) {
    redirect(`/applications/${applicationId}/portal?error=INVALID_SUPPORT_URL`);
  }
  const branding = {
    displayName: str('displayName'),
    tagline: str('tagline'),
    primaryColor: str('primaryColor'),
    backgroundColor: str('backgroundColor'),
    surfaceColor: str('surfaceColor'),
    logoUrl,
    supportEmail: str('supportEmail'),
    supportUrl,
  };
  await patchPortal(applicationId, { branding }, 'branding_saved');
}

async function saveDomain(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const portalDomain = String(formData.get('portalDomain') ?? '').trim().toLowerCase();
  try {
    await patchPortal(applicationId, { portalDomain }, portalDomain ? 'domain_saved' : 'domain_cleared');
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/portal?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

const ERR: Record<string, string> = {
  PORTAL_DOMAIN_TAKEN: 'That domain is already used by another application.',
  INVALID_LOGO_URL: 'Logo URL must be a full http(s) link (e.g. https://…/logo.png).',
  INVALID_SUPPORT_URL: 'Support URL must be a full http(s) link.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can configure the hosted portal.',
  APPLICATION_NOT_FOUND: 'Application not found.',
};

export default async function PortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
  const enabled = Boolean(app.hostedPortalEnabled);
  const portalUrl = `${PORTAL_BASE}/${app.slug}`;
  const b = (app.portalBranding ?? {}) as {
    displayName?: string;
    tagline?: string;
    primaryColor?: string;
    backgroundColor?: string;
    surfaceColor?: string;
    logoUrl?: string;
    supportEmail?: string;
    supportUrl?: string;
  };
  const domain = app.portalDomain ?? '';
  const domainVerified = Boolean(app.portalDomainVerifiedAt);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Hosted customer portal"
        description={
          <>
            A Rekey-hosted page where <strong>your end-users</strong> sign in and manage their own
            subscription, plan, and billing — no UI to build, no backend to deploy. Runs on your
            Application's <strong>publishable key</strong> + each customer's own session; you never
            expose a secret key.
          </>
        }
      />

      {error && (
        <Banner tone="error">
          {ERR[error] ?? 'Something went wrong. Please try again.'}
        </Banner>
      )}

      {/* Enable / URL */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-[var(--color-fg)]">{enabled ? 'Portal is live' : 'Portal is off'}</p>
            <p className="text-xs text-[var(--color-muted-fg)]">
              {enabled ? 'Customers can sign in and self-serve at the URL below.' : 'Turn it on to give customers a self-service billing page.'}
            </p>
          </div>
          <form action={setPortalEnabled.bind(null, id, !enabled)}>
            <SubmitButton pendingLabel={enabled ? 'Disabling…' : 'Enabling…'}>
              {enabled ? 'Disable portal' : 'Enable portal'}
            </SubmitButton>
          </form>
        </div>
        {enabled && (
          <div className="flex items-center gap-3 border-t border-[var(--color-border)] pt-4">
            <span className="text-xs font-medium text-[var(--color-muted-fg)]">Portal URL</span>
            <code className="flex-1 break-all rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs font-mono">{portalUrl}</code>
            <CopyButton value={portalUrl} label="Copy" />
            <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="rounded-md border border-[var(--color-border)] px-3 py-2 text-xs hover:bg-[var(--color-bg)]">Open ↗</a>
          </div>
        )}
      </div>

      {/* Branding */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Branding</h2>
        <p className="mb-3 text-xs text-[var(--color-muted-fg)]">How the portal looks to your customers. Leave blank to use defaults.</p>
        <form action={saveBranding.bind(null, id)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs font-medium">Display name</span>
            <input name="displayName" defaultValue={b.displayName ?? ''} placeholder={app.name} className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Tagline</span>
            <input name="tagline" defaultValue={b.tagline ?? ''} placeholder="Manage your subscription" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Logo URL</span>
            <input name="logoUrl" type="url" defaultValue={b.logoUrl ?? ''} placeholder="https://…/logo.png" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Primary color</span>
            <input name="primaryColor" type="text" defaultValue={b.primaryColor ?? ''} placeholder="#4f46e5" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Background color</span>
            <input name="backgroundColor" type="text" defaultValue={b.backgroundColor ?? ''} placeholder="#fafafa" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Surface color</span>
            <input name="surfaceColor" type="text" defaultValue={b.surfaceColor ?? ''} placeholder="#ffffff" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Support email</span>
            <input name="supportEmail" type="email" defaultValue={b.supportEmail ?? ''} placeholder="support@yourapp.com" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Support URL</span>
            <input name="supportUrl" type="url" defaultValue={b.supportUrl ?? ''} placeholder="https://yourapp.com/help" className={inputCls} />
          </label>
          <p className="text-xs text-[var(--color-muted-fg)] sm:col-span-2">
            When set, the portal shows a &ldquo;Contact support&rdquo; link (URL wins over email).
          </p>
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Saving…">Save branding</SubmitButton>
          </div>
        </form>
      </div>

      {/* Custom domain */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Custom domain</h2>
        <p className="mb-3 text-xs text-[var(--color-muted-fg)]">
          Serve the portal on your own domain (e.g. <code>billing.yourapp.com</code>) instead of{' '}
          <code>{PORTAL_HOST}/{app.slug}</code>.
        </p>
        <form action={saveDomain.bind(null, id)} className="space-y-3">
          <div className="flex items-center gap-2">
            <input name="portalDomain" defaultValue={domain} placeholder="billing.yourapp.com" className={inputCls} />
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </div>
          {domain && (
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs space-y-1.5">
              <p className="font-medium text-[var(--color-fg)]">
                Status:{' '}
                {domainVerified ? (
                  <span className="text-green-600">Verified — live</span>
                ) : (
                  <span className="text-amber-600">Pending DNS verification</span>
                )}
              </p>
              <p className="text-[var(--color-muted-fg)]">Add this DNS record at your domain provider, then verification completes automatically:</p>
              <code className="block rounded bg-[var(--color-surface)] px-2 py-1 font-mono">
                CNAME&nbsp;&nbsp;{domain}&nbsp;&nbsp;→&nbsp;&nbsp;{PORTAL_HOST}
              </code>
              <p className="text-[var(--color-faint-fg)]">TLS is provisioned automatically once the record resolves. Clear the field and save to remove the domain.</p>
            </div>
          )}
        </form>
      </div>

      <p className="text-xs text-[var(--color-muted-fg)]">The portal needs billing enabled on this Application.</p>
    </div>
  );
}
