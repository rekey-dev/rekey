import * as React from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, PanelApiError, type ApplicationRow } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { PageHeader } from '@/components/PageHeader';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';

type ProviderName =
  | 'google'
  | 'github'
  | 'microsoft'
  | 'discord'
  | 'gitlab'
  | 'slack'
  | 'oidc';

interface ProviderInfo {
  name: ProviderName;
  label: string;
  hint: string;
  /** Where to send operators to fetch credentials. */
  consoleUrl: string;
  needsIssuerUrl?: boolean;
}

const PROVIDERS: ProviderInfo[] = [
  {
    name: 'google',
    label: 'Google',
    hint: 'Sign in with Google. Uses OpenID Connect — no userinfo round-trip.',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials',
  },
  {
    name: 'github',
    label: 'GitHub',
    hint: 'Sign in with GitHub. Email is fetched via the /user/emails endpoint.',
    consoleUrl: 'https://github.com/settings/developers',
  },
  {
    name: 'microsoft',
    label: 'Microsoft',
    hint: 'Multi-tenant Azure AD (common endpoint). For single-tenant Azure, use OIDC with your tenant URL.',
    consoleUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  },
  {
    name: 'discord',
    label: 'Discord',
    hint: 'Sign in with Discord. Uses /users/@me with the verified-email guard.',
    consoleUrl: 'https://discord.com/developers/applications',
  },
  {
    name: 'gitlab',
    label: 'GitLab',
    hint: 'Sign in with gitlab.com. For self-hosted GitLab, use OIDC with your instance URL.',
    consoleUrl: 'https://gitlab.com/-/profile/applications',
  },
  {
    name: 'slack',
    label: 'Slack',
    hint: '"Sign in with Slack" — Slack\'s OIDC endpoints. Email + name only, no workspace permissions.',
    consoleUrl: 'https://api.slack.com/apps',
  },
  {
    name: 'oidc',
    label: 'Generic OIDC',
    hint: 'Any OIDC-compliant issuer (Okta, Auth0, Keycloak, Authentik, Cognito, …). We auto-discover endpoints from /.well-known/openid-configuration.',
    consoleUrl: '',
    needsIssuerUrl: true,
  },
];

async function setOauth(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const provider = String(formData.get('provider') ?? '');
  const clientId = String(formData.get('clientId') ?? '').trim();
  const clientSecret = String(formData.get('clientSecret') ?? '').trim();
  const redirectUri = String(formData.get('redirectUri') ?? '').trim();
  const issuerUrl = String(formData.get('issuerUrl') ?? '').trim();

  if (!provider || !clientId || !clientSecret || !redirectUri) {
    redirect(`/applications/${applicationId}/oauth?error=missing&newOauth_${provider}=1`);
  }
  const body: Record<string, unknown> = { clientId, clientSecret, redirectUri };
  if (provider === 'oidc') {
    if (!issuerUrl) {
      redirect(`/applications/${applicationId}/oauth?error=missing_issuer&newOauth_oidc=1`);
    }
    body.issuerUrl = issuerUrl;
  }
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/oauth-config/${encodeURIComponent(provider)}`,
      body,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/oauth?error=${encodeURIComponent(err.code)}&newOauth_${provider}=1`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/oauth`);
  redirect(`/applications/${applicationId}/oauth?saved=${provider}`);
}

async function removeOauth(applicationId: string, provider: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/oauth-config/${encodeURIComponent(provider)}`,
  });
  revalidatePath(`/applications/${applicationId}/oauth`);
  redirect(`/applications/${applicationId}/oauth`);
}

const ERR: Record<string, string> = {
  missing: 'All fields are required.',
  missing_issuer: 'The OIDC provider requires an issuer URL.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can configure OAuth providers.',
};

export default async function OAuthPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;

  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
  const configured = (app.oauthConfig ?? {}) as Record<string, { clientId: string; redirectUri: string; issuerUrl?: string }>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="OAuth providers"
        description="Optional — let end-users sign in with their existing accounts. Each provider needs a client ID + secret from the provider's developer console plus a matching redirect URI. Secrets are AES-256-GCM encrypted at rest; never returned in any API response."
      />

      {saved && <SavedBanner message={`${saved} configuration saved.`} />}

      {Object.keys(configured).length === 0 && (
        <p className="text-sm text-[var(--color-muted-fg)]">
          No social logins yet — add Google, GitHub, and others below so users can sign in with one
          click. Optional; password sign-in works on its own.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {PROVIDERS.map((p) => {
          const cfg = configured[p.name];
          const isConfigured = !!cfg;
          const reopenError = sp[`newOauth_${p.name}`] === '1' ? error : undefined;
          return (
            <Card key={p.name} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-[var(--color-fg)]">{p.label}</p>
                    {isConfigured ? (
                      <Badge tone="success" dot>configured</Badge>
                    ) : (
                      <Badge tone="neutral">not configured</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted-fg)]">{p.hint}</p>
                  {isConfigured && (
                    <div className="mt-2 space-y-0.5 break-all font-mono text-xs text-[var(--color-muted-fg)]">
                      <p>clientId: {cfg.clientId}</p>
                      <p>redirect: {cfg.redirectUri}</p>
                      {cfg.issuerUrl && <p>issuer: {cfg.issuerUrl}</p>}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-auto flex items-center gap-3">
                <Modal
                  trigger={isConfigured ? 'Rotate / edit' : 'Configure'}
                  triggerClassName="inline-block rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"
                  modalKey={`newOauth_${p.name}`}
                  title={`${isConfigured ? 'Rotate' : 'Configure'} ${p.label}`}
                  description={p.hint}
                >
                  <ConfigForm
                    applicationId={id}
                    provider={p}
                    existing={cfg ?? null}
                    error={reopenError}
                  />
                </Modal>
                {p.consoleUrl && (
                  <a
                    href={p.consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"
                  >
                    Provider console ↗
                  </a>
                )}
                {isConfigured && (
                  <form action={removeOauth.bind(null, id, p.name)} className="ml-auto">
                    <TypedConfirmButton
                      expected={p.name}
                      title={`Remove ${p.label}?`}
                      description={`New sign-ins through ${p.label} will immediately fail for every end-user (existing linked accounts keep working). You'll need to re-paste the client ID + secret to restore.`}
                      triggerLabel="Remove"
                      confirmLabel={`Remove ${p.label}`}
                    />
                  </form>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ConfigForm({
  applicationId,
  provider,
  existing,
  error,
}: {
  applicationId: string;
  provider: ProviderInfo;
  existing: { clientId: string; redirectUri: string; issuerUrl?: string } | null;
  error?: string;
}): React.JSX.Element {
  return (
    <form action={setOauth.bind(null, applicationId)} className="space-y-3">
      <input type="hidden" name="provider" value={provider.name} />

      {error && (
        <p role="alert" className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {ERR[error] ?? error}
        </p>
      )}

      <Field label="Client ID" hint="From the provider's developer console.">
        <input
          type="text"
          name="clientId"
          required
          autoFocus
          defaultValue={existing?.clientId ?? ''}
          className={inputCls}
        />
      </Field>

      <Field label="Client secret" hint="Encrypted at rest. Re-enter on every rotation — we don't show old secrets.">
        <input
          type="password"
          name="clientSecret"
          required
          autoComplete="off"
          placeholder={existing ? '(unchanged unless you enter a new one)' : ''}
          className={inputCls}
        />
      </Field>

      <Field label="Redirect URI" hint="Must match what's registered upstream exactly. Usually your app's /oauth/callback route.">
        <input
          type="url"
          name="redirectUri"
          required
          defaultValue={existing?.redirectUri ?? ''}
          placeholder="https://yourapp.com/oauth/callback"
          className={inputCls}
        />
      </Field>

      {provider.needsIssuerUrl && (
        <Field
          label="Issuer URL"
          hint="The base URL of your OIDC issuer. We fetch /.well-known/openid-configuration from here to discover the auth + token endpoints."
        >
          <input
            type="url"
            name="issuerUrl"
            required
            defaultValue={existing?.issuerUrl ?? ''}
            placeholder="https://login.example.com"
            className={inputCls}
          />
        </Field>
      )}

      <div className="flex items-center gap-2 pt-2">
        <SubmitButton pendingLabel="Saving…">{existing ? 'Save changes' : 'Add provider'}</SubmitButton>
      </div>
    </form>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
