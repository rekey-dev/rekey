import * as React from 'react';
import { redirect } from 'next/navigation';
import { errorQuery, readErrorFlash, api, PanelApiError, getApplication } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { ApiErrorText } from '@/components/api-error';
import { SectionHeader } from '@/components/Card';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { StickyFormFooter } from '@/components/StickyFormFooter';
import { dangerButtonClass } from '@/components/Button';
import { savedStateKey } from '@/lib/saved-state-key';
import { Banner } from '@/components/Banner';
import { portalBase } from '@/lib/portal-base';
import { portalDomainState, type PortalDomainState } from '@/lib/auth-config';
import { formatDate } from '@/lib/date';

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

/** Only absolute http(s) URLs survive, reject javascript:/data:/other schemes. */
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
  const policyLinks: Record<'termsUrl' | 'privacyUrl' | 'refundUrl', string> = { termsUrl: '', privacyUrl: '', refundUrl: '' };
  for (const key of ['termsUrl', 'privacyUrl', 'refundUrl'] as const) {
    policyLinks[key] = httpUrlOrEmpty(str(key));
    if (str(key) && !policyLinks[key]) redirect(`/applications/${applicationId}/portal?error=INVALID_POLICY_URL`);
  }
  const branding = {
    ...policyLinks,
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
      redirect(`/applications/${applicationId}/portal?${await errorQuery(err)}`);
    }
    throw err;
  }
}

async function verifyDomain(applicationId: string): Promise<void> {
  'use server';
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/portal/domain/verify`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/portal?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/portal?e=domain_verified`);
}

function DomainStatus({
  state,
  verifiedAt,
  lapsedAt,
}: {
  state: PortalDomainState;
  verifiedAt: string | null | undefined;
  lapsedAt: string | null | undefined;
}): React.JSX.Element {
  if (state === 'verified' && verifiedAt) {
    return <span className="text-green-600">Verified on {formatDate(verifiedAt)}</span>;
  }
  if (state === 'lapsed' && lapsedAt) {
    return <span className="text-red-600">Verification lapsed on {formatDate(lapsedAt)}</span>;
  }
  if (state === 'not_set') return <span>Not set</span>;
  return <span className="text-amber-600">Pending verification</span>;
}

function DnsRecord({ type, name, value }: { type: string; name: string; value: string }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 rounded bg-[var(--color-surface)] px-2 py-1.5 font-mono">
      <dt className="text-[var(--color-muted-fg)]">Type</dt>
      <dd className="col-span-2">{type}</dd>
      <dt className="text-[var(--color-muted-fg)]">Name</dt>
      <dd className="break-all">{name}</dd>
      <CopyButton value={name} label="Copy" />
      <dt className="text-[var(--color-muted-fg)]">Value</dt>
      <dd className="break-all">{value}</dd>
      <CopyButton value={value} label="Copy" />
    </dl>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

const STATUS_COPY: Record<'off' | 'live' | 'unserved', { title: string; body: string }> = {
  off: { title: 'Portal is off', body: 'Turn it on to give customers a self-service billing page.' },
  live: { title: 'Portal is live', body: 'Customers can sign in and self-serve at the URL below.' },
  unserved: {
    title: 'Portal is on, but not served',
    body: 'It is enabled for this Application, but this deployment runs no hosted portal.',
  },
};

const ERR: Record<string, string> = {
  PORTAL_DOMAIN_TAKEN: 'Another application has already verified that domain.',
  INVALID_LOGO_URL: 'Logo URL must be a full http(s) link (e.g. https://…/logo.png).',
  INVALID_SUPPORT_URL: 'Support URL must be a full http(s) link.',
  INVALID_POLICY_URL: 'Terms, privacy and refund links must be full http(s) links.',
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
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const app = await getApplication(id);
  const enabled = Boolean(app.hostedPortalEnabled);
  const base = portalBase(app);
  const portalHost = base?.replace(/^https?:\/\//, '') ?? null;
  const portalUrl = base ? `${base}/${app.slug}` : null;
  const status = !enabled ? 'off' : portalUrl ? 'live' : 'unserved';
  const b = (app.portalBranding ?? {}) as {
    displayName?: string;
    tagline?: string;
    primaryColor?: string;
    backgroundColor?: string;
    surfaceColor?: string;
    logoUrl?: string;
    supportEmail?: string;
    supportUrl?: string;
    termsUrl?: string;
    privacyUrl?: string;
    refundUrl?: string;
  };
  const domain = app.portalDomain ?? '';
  const domainState = portalDomainState(app);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Portal"
        description={
          <>
            A Rekey-hosted page where <strong>your end-users</strong> sign in and manage their own
            subscription, plan, and billing, with no UI to build and no backend to deploy. Runs on your
            Application's <strong>publishable key</strong> + each customer's own session; you never
            expose a secret key.
          </>
        }
      />

      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback="Something went wrong. Please try again." />
        </Banner>
      )}

      {/* Enable / URL */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-[var(--color-fg)]">{STATUS_COPY[status].title}</p>
            <p className="text-xs text-[var(--color-muted-fg)]">{STATUS_COPY[status].body}</p>
          </div>
          <ActionForm action={setPortalEnabled.bind(null, id, !enabled)}>
            {enabled ? (
              <ConfirmButton
                title="Disable hosted portal?"
                confirm="Your end users lose the hosted billing portal until you enable it again."
                triggerClassName={dangerButtonClass('sm')}
                pendingLabel="Disabling…"
              >
                Disable portal
              </ConfirmButton>
            ) : (
              <SubmitButton pendingLabel="Enabling…">Enable portal</SubmitButton>
            )}
          </ActionForm>
        </div>
        {status === 'unserved' && (
          <Banner tone="warning">
            This deployment has no hosted portal URL, so customers have no page to open. Set{' '}
            <code>PUBLIC_PORTAL_URL</code> on the API and <code>PORTAL_BASE_URL</code> on the portal to the
            portal&apos;s public origin (both the same value), then restart both.
          </Banner>
        )}
        {portalUrl && enabled && (
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
        <ActionForm
          key={savedStateKey(b)}
          action={saveBranding.bind(null, id)}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
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
          <label className="space-y-1">
            <span className="text-xs font-medium">Terms URL</span>
            <input name="termsUrl" type="url" defaultValue={b.termsUrl ?? ''} placeholder="https://yourapp.com/terms" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Privacy URL</span>
            <input name="privacyUrl" type="url" defaultValue={b.privacyUrl ?? ''} placeholder="https://yourapp.com/privacy" className={inputCls} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Refund policy URL</span>
            <input name="refundUrl" type="url" defaultValue={b.refundUrl ?? ''} placeholder="https://yourapp.com/refunds" className={inputCls} />
          </label>
          <p className="text-xs text-[var(--color-muted-fg)] sm:col-span-2 self-end">
            Linked from the footer of the Rekey checkout page.
          </p>
          <div className="sm:col-span-2">
            <StickyFormFooter label="Save branding" hint="Customers see changes on their next page load." />
          </div>
        </ActionForm>
      </div>

      {/* Custom domain */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Custom domain</h2>
        <p className="mb-3 text-xs text-[var(--color-muted-fg)]">
          Serve the portal on your own domain (e.g. <code>billing.yourapp.com</code>) instead of{' '}
          {portalHost ? <code>{portalHost}/{app.slug}</code> : 'the shared portal host'}.
        </p>
        <ActionForm key={savedStateKey(domain)} action={saveDomain.bind(null, id)} className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium">Domain</span>
            <input name="portalDomain" defaultValue={domain} placeholder="billing.yourapp.com" className={inputCls} />
          </label>
          <p className="text-xs text-[var(--color-faint-fg)]">Clear the field and save to remove the domain.</p>
          <StickyFormFooter label="Save domain" />
        </ActionForm>
        <p className="mt-4 text-xs font-medium text-[var(--color-fg)]">
          Status: <DomainStatus state={domainState} verifiedAt={app.portalDomainVerifiedAt} lapsedAt={app.portalDomainLapsedAt} />
        </p>
        {domain && (
          <div className="mt-2 space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
            {domainState === 'lapsed' && (
              <p className="text-[var(--color-muted-fg)]">
                A regular DNS check stopped finding the TXT record below, so customers are no longer sent to this
                domain. Publish the record again, then verify.
              </p>
            )}
            <div className="space-y-1.5">
              <p className="font-medium text-[var(--color-fg)]">1. Point the domain at the portal</p>
              {portalHost ? (
                <DnsRecord type="CNAME" name={domain} value={portalHost} />
              ) : (
                <p className="text-[var(--color-muted-fg)]">
                  This deployment has no hosted portal URL, so there is no host to point at. Set{' '}
                  <code>PUBLIC_PORTAL_URL</code> on the API to see it.
                </p>
              )}
            </div>
            {app.portalDomainTxtRecord && (
              <div className="space-y-1.5">
                <p className="font-medium text-[var(--color-fg)]">2. Prove you control it</p>
                <p className="text-[var(--color-muted-fg)]">Publish this TXT record at your DNS provider. Keep it in place: it is checked again regularly.</p>
                <DnsRecord type="TXT" name={app.portalDomainTxtRecord.name} value={app.portalDomainTxtRecord.value} />
              </div>
            )}
            <div className="space-y-1.5">
              <p className="font-medium text-[var(--color-fg)]">3. Verify</p>
              <ActionForm action={verifyDomain.bind(null, id)}>
                <SubmitButton pendingLabel="Checking DNS…">{domainState === 'verified' ? 'Check again' : 'Verify domain'}</SubmitButton>
                {domainState !== 'verified' && (
                  <p className="text-[var(--color-faint-fg)]">
                    Verifying switches the links in your emails to this domain right away. Verify only after the domain already reaches your portal over HTTPS.
                  </p>
                )}
              </ActionForm>
              <p className="text-[var(--color-muted-fg)]">
                DNS changes can take a while to reach every resolver. If verification fails right after you add
                the records, wait a few minutes and try again.
              </p>
            </div>
            <p className="text-[var(--color-faint-fg)]">
              Verification proves you control the domain. Serving it also needs HTTPS for that host: on a
              self-hosted deployment, tell your reverse proxy about the host and give it a certificate (see{' '}
              <code>docs/portal.md</code>); on a hosted deployment, it depends on what that deployment supports.
            </p>
          </div>
        )}
      </div>

      {!app.billingConfig.enabled && (
        <p className="text-xs text-[var(--color-muted-fg)]">The portal needs billing enabled on this Application.</p>
      )}
    </div>
  );
}
