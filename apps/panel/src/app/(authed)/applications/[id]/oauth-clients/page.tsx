/**
 * OAuth clients registered AGAINST this Application.
 *
 * The opposite direction from the "Sign-in providers" tab next door. That one
 * is outbound — which external providers this Application's own users may sign
 * in with, and it asks for a client id and secret issued by Google or GitHub.
 * This one is inbound: other software registering itself with this Application
 * as its authorization server.
 *
 * Confusing the two is easy and was: the provider form asks for a secret, and
 * an Application acting as an IdP never issues one — registration here mints a
 * PUBLIC client that authenticates with PKCE. There is nothing to paste into
 * that form for this purpose, and no way to tell from the old labels.
 *
 * Registration is unauthenticated by design (RFC 7591) and on by default,
 * because MCP clients self-register. Until this page there was no way to see
 * what had registered, no way to remove one, and no way to close registration —
 * so the toggle lives here, next to the consequence.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, getApplication } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { SectionHeader } from '@/components/Card';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';

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
};

export default async function OAuthClientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const flag = (await searchParams).e;
  const app = await getApplication(id);

  const registrationOpen =
    (app.authConfig as { dynamicClientRegistration?: boolean }).dynamicClientRegistration !== false;

  // A failed read must not take the page down — the toggle is the control an
  // operator reaches for when something has gone wrong, and it does not depend
  // on the list.
  let clients: RegisteredClient[] = [];
  let total = 0;
  let listError: string | null = null;
  try {
    // Paged envelope, not a bare array — registrations accumulate. One page of
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

      <section className="rounded-lg border border-[var(--color-border)] p-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="text-sm font-semibold">Open registration</h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted-fg)]">
              {registrationOpen ? (
                <>
                  Anyone can register a client with{' '}
                  <code className="text-xs">POST /oauth/register</code>, with no credential needed.
                  That is the RFC 7591 behaviour MCP clients rely on to connect themselves. Turn it
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
          <form action={setRegistrationOpen.bind(null, id, !registrationOpen)} className="shrink-0">
            <SubmitButton
              pendingLabel="Saving…"
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
            >
              {registrationOpen ? 'Close registration' : 'Open registration'}
            </SubmitButton>
          </form>
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
              {/* No confirmation step: revoking is recoverable — the client
                  re-registers, or you register it again — and a modal on a
                  reversible action trains people to click through modals. */}
              <form action={revokeClient.bind(null, id, c.clientId)} className="shrink-0">
                <SubmitButton
                  pendingLabel="Revoking…"
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-danger-fg,inherit)] hover:bg-[var(--color-surface-muted)]"
                >
                  Revoke
                </SubmitButton>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
