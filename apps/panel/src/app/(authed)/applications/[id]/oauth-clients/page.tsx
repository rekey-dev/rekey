/**
 * OAuth clients registered AGAINST this Application.
 *
 * The opposite direction from the "Sign-in providers" tab next door. That one
 * is outbound, which external providers this Application's own users may sign
 * in with, and it asks for a client id and secret issued by Google or GitHub.
 * This one is inbound: other software registering itself with this Application
 * as its authorization server.
 *
 * Confusing the two is easy and was: the provider form asks for a secret, and
 * an Application acting as an IdP never issues one, registration here mints a
 * PUBLIC client that authenticates with PKCE. There is nothing to paste into
 * that form for this purpose, and no way to tell from the old labels.
 *
 * Registration is unauthenticated by design (RFC 7591) and on by default,
 * because MCP clients self-register. Until this page there was no way to see
 * what had registered, no way to remove one, and no way to close registration,
 * so the toggle lives here, next to the consequence.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, getApplication, readErrorFlash } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import Link from '@/components/Link';
import { SectionHeader } from '@/components/Card';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';
import { ApiErrorText } from '@/components/api-error';
import { StickyFormFooter } from '@/components/StickyFormFooter';
import { savedStateKey } from '@/lib/saved-state-key';
import { saveOidcProvider } from './actions';
import { dangerButtonClass } from '@/components/Button';

export const dynamic = 'force-dynamic';

interface RegisteredClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  createdAt: string;
}

async function setRegistrationOpen(
  applicationId: string,
  open: boolean,
  _formData: FormData,
): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/auth-config`,
    body: { dynamicClientRegistration: open },
  });
  redirect(`/applications/${applicationId}/oauth-clients?e=${open ? 'reg_open' : 'reg_closed'}`);
}


async function revokeClient(
  applicationId: string,
  clientId: string,
  _formData: FormData,
): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(
      applicationId,
    )}/oauth-clients/${encodeURIComponent(clientId)}`,
  });
  redirect(`/applications/${applicationId}/oauth-clients?e=revoked`);
}

const FLAGS: Record<string, { tone: 'success' | 'info'; text: string }> = {
  revoked: { tone: 'success', text: 'Client revoked. Its codes and tokens no longer resolve.' },
  reg_closed: {
    tone: 'success',
    text: 'Open registration is off. Existing clients keep working; no new ones can register.',
  },
  reg_open: { tone: 'info', text: 'Open registration is on. Anyone can register a client.' },
  oidc_saved: { tone: 'success', text: 'OpenID Connect provider settings saved.' },
};

const OIDC_ERR: Record<string, string> = {
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can change OpenID Connect settings.',
};

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';

export default async function OAuthClientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const flag = sp.e;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const app = await getApplication(id);
  // Off unless set: an app saved before the field existed is not an identity provider.
  const oidcEnabled = app.authConfig.oidcEnabled === true;
  const hostedAuthorizeUrl =
    (app.authConfig as { hostedAuthorizeUrl?: string }).hostedAuthorizeUrl ?? '';
  const emailVerified =
    (app.authConfig as { requireEmailVerification?: boolean }).requireEmailVerification === true;

  const registrationOpen =
    (app.authConfig as { dynamicClientRegistration?: boolean }).dynamicClientRegistration !== false;

  // A failed read must not take the page down, the toggle is the control an
  // operator reaches for when something has gone wrong, and it does not depend
  // on the list.
  let clients: RegisteredClient[] = [];
  let total = 0;
  let listError: string | null = null;
  try {
    // Paged envelope, not a bare array, registrations accumulate. One page of
    // 100 is plenty to look at; `total` tells us when to say there are more
    // rather than silently showing a truncated list.
    const res = await api<{ items: RegisteredClient[]; page?: { total?: number } }>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/oauth-clients?limit=100`,
    });
    clients = res?.items ?? [];
    total = res?.page?.total ?? clients.length;
  } catch {
    listError = 'Could not load registered clients. The registration setting below still applies.';
  }

  const banner = typeof flag === 'string' ? FLAGS[flag] : undefined;

  return (
    <div className="space-y-6">
      <SectionHeader
        title="OAuth clients"
        description={
          <>
            Software that signs users in <strong>using</strong> this Application: MCP clients,
            and any relying party that treats it as an OpenID Connect provider. This is the
            opposite of <strong>Sign-in providers</strong>, which is where you configure the
            providers your users sign in <em>with</em>.
          </>
        }
      />

      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}

      <section id="oidc-provider" className="scroll-mt-28 md:scroll-mt-20 rounded-lg border border-[var(--color-border)] p-5">
        <h2 className="text-sm font-semibold">OpenID Connect provider</h2>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted-fg)]">
          Lets other products offer &ldquo;Sign in with {app.name}&rdquo;, so your end-users&apos;
          accounts here become their accounts there. Leave it off unless you want to be an
          identity provider.
        </p>
        {error ? (
          <div className="mt-3">
            <Banner tone="error">
              <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={OIDC_ERR} fallback={error} />
            </Banner>
          </div>
        ) : null}
        <ActionForm
          key={savedStateKey({ oidcEnabled, hostedAuthorizeUrl })}
          action={saveOidcProvider.bind(null, id)}
          className="mt-4 space-y-5"
        >
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="oidcEnabled"
              defaultChecked={oidcEnabled}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--color-border)]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-[var(--color-fg)]">
                Act as an OpenID Connect provider
              </span>
              <span className="mt-0.5 block text-xs text-[var(--color-muted-fg)]">
                Turning it on publishes a public discovery document at{' '}
                <code className="text-xs">/.well-known/openid-configuration</code>, issues ID tokens
                for the <code className="text-xs">openid</code> scope and serves{' '}
                <code className="text-xs">/oauth/userinfo</code>. Clients can register themselves
                while open registration (below) is on, so close it once yours are connected. This is
                separate from the MCP switch; either one turns on the shared sign-in endpoints.{' '}
                {emailVerified ? (
                  'Email addresses are shared, because this application requires a verified email.'
                ) : (
                  <>
                    Email addresses are not shared until{' '}
                    <Link href={`/applications/${id}/auth#sessions`} className="underline underline-offset-2">
                      Require a verified email
                    </Link>{' '}
                    is on.
                  </>
                )}
              </span>
            </span>
          </label>

          <label className="block space-y-1.5">
            <span className="block text-sm font-medium text-[var(--color-fg)]">Your own sign-in page</span>
            <input
              type="url"
              name="hostedAuthorizeUrl"
              defaultValue={hostedAuthorizeUrl}
              placeholder="https://app.yourcompany.com/oauth/authorize"
              className={inputCls}
            />
            <span className="block max-w-2xl text-xs text-[var(--color-muted-fg)]">
              Blank, Rekey shows its own sign-in page, which asks for an email and password. If
              your users sign in with Google or GitHub they have no password, so point this at your
              own login page and Rekey forwards the request there unchanged. Your page must still
              ask for consent: show what{' '}
              <code className="font-mono text-xs">POST /api/v1/mcp/{app.slug}/oauth/authorize/preview</code>{' '}
              returns, and only on Allow call{' '}
              <code className="font-mono text-xs">POST /api/v1/mcp/{app.slug}/oauth/authorize/grant</code>{' '}
              with your secret key (it needs <code className="font-mono text-xs">auth:write</code>)
              and the user&apos;s access token, then redirect with the code it returns.
            </span>
          </label>

          <StickyFormFooter hint="Applies to the next sign-in request." />
        </ActionForm>
      </section>

      <section className="rounded-lg border border-[var(--color-border)] p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div>
            <h2 className="text-sm font-semibold">Open registration</h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted-fg)]">
              {registrationOpen ? (
                <>
                  Anyone can register a client with{' '}
                  <code className="text-xs">POST /oauth/register</code>, with no credential needed.
                  MCP clients rely on this to connect themselves. Turn it
                  off once your relying parties are registered: on a public issuer it lets anyone
                  put a sign-in prompt on this Application&apos;s origin.
                </>
              ) : (
                <>
                  Closed. Existing clients below keep working; new ones are refused. Turn it back
                  on temporarily if you need to connect another MCP client.
                </>
              )}
            </p>
          </div>
          <ActionForm action={setRegistrationOpen.bind(null, id, !registrationOpen)} className="shrink-0">
            <SubmitButton
              pendingLabel="Saving…"
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
            >
              {registrationOpen ? 'Close registration' : 'Open registration'}
            </SubmitButton>
          </ActionForm>
        </div>
      </section>

      {listError ? <Banner tone="error">{listError}</Banner> : null}

      {clients.length === 0 && !listError ? (
        <p className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-sm text-[var(--color-muted-fg)]">
          Nothing has registered yet. An MCP client registers itself the first time it connects;
          a relying party you set up by hand will appear here too.
        </p>
      ) : null}

      {total > clients.length ? (
        <p className="text-sm text-[var(--color-muted-fg)]">
          Showing {clients.length} of {total}. Revoke from here, or query the API for the rest.
        </p>
      ) : null}

      {clients.length > 0 ? (
        <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
          {clients.map((c) => (
            <li key={c.clientId} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {c.clientName || <span className="text-[var(--color-muted-fg)]">Unnamed client</span>}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="truncate text-xs text-[var(--color-muted-fg)]">{c.clientId}</code>
                  <CopyButton value={c.clientId} />
                </div>
                {c.redirectUris.length > 0 ? (
                  <ul className="mt-2 space-y-0.5">
                    {c.redirectUris.map((u) => (
                      <li key={u} className="truncate text-xs text-[var(--color-muted-fg)]">
                        {u}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-2 text-xs text-[var(--color-muted-fg)]">
                  Registered {new Date(c.createdAt).toLocaleDateString()}
                </p>
              </div>
              {/* No confirmation step: revoking is recoverable, the client
                  re-registers, or you register it again, and a modal on a
                  reversible action trains people to click through modals. */}
              <ActionForm action={revokeClient.bind(null, id, c.clientId)} className="shrink-0">
                <SubmitButton
                  pendingLabel="Revoking…"
                  className={dangerButtonClass('sm')}
                >
                  Revoke
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
