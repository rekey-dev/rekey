import * as React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ACCESS_COOKIE, api, PanelApiError, type MeDto } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { CONSENT_COOKIE } from '../consent-cookie';

const WRITE_SCOPE = 'mcp:operator:write';
const ADMIN_SCOPE = 'mcp:operator:admin';

interface ConsentParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  state?: string;
}

/** Read + validate the stashed OAuth params from the consent cookie. */
function readParams(raw: string | undefined): ConsentParams | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.client_id !== 'string' || typeof p.redirect_uri !== 'string') return null;
    if (typeof p.code_challenge !== 'string' || typeof p.code_challenge_method !== 'string') {
      return null;
    }
    return {
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      code_challenge_method: p.code_challenge_method,
      scope: typeof p.scope === 'string' ? p.scope : undefined,
      state: typeof p.state === 'string' ? p.state : undefined,
    };
  } catch {
    return null;
  }
}

export default async function McpConsentReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE)?.value) redirect('/login');

  const params = readParams(jar.get(CONSENT_COOKIE)?.value);
  if (!params) redirect('/applications');

  const me = await api<MeDto>({ method: 'GET', path: '/api/v1/tenant/auth/me' });
  const scopeList = (params.scope ?? '').split(/\s+/);
  const wantsAdmin = scopeList.includes(ADMIN_SCOPE);
  const wantsWrite = wantsAdmin || scopeList.includes(WRITE_SCOPE);
  const sp = await searchParams;
  const errored = typeof sp.error === 'string';

  // ── Consent decision ─────────────────────────────────────────────────
  async function decide(formData: FormData): Promise<void> {
    'use server';
    const approve = formData.get('decision') === 'allow';
    const tenantId = String(formData.get('tenant_id') ?? '').trim();

    // The OAuth params are PUBLIC (the client already holds them) and the grant
    // endpoint re-validates every one of them server-side: client_id +
    // redirect_uri against the registered allowlist, PKCE method, and workspace
    // membership for tenant_id. So carry them in the form — relying on the
    // consent cookie surviving the POST proved fragile behind the proxy. Cookie
    // is the fallback if the form somehow lacks them.
    const jar2 = await cookies();
    const cookieParams = readParams(jar2.get(CONSENT_COOKIE)?.value);
    const clientId = String(formData.get('client_id') ?? cookieParams?.client_id ?? '');
    const redirectUri = String(formData.get('redirect_uri') ?? cookieParams?.redirect_uri ?? '');
    const codeChallenge = String(
      formData.get('code_challenge') ?? cookieParams?.code_challenge ?? '',
    );
    const codeChallengeMethod = String(
      formData.get('code_challenge_method') ?? cookieParams?.code_challenge_method ?? '',
    );
    const scope = String(formData.get('scope') ?? cookieParams?.scope ?? '') || undefined;
    const state = String(formData.get('state') ?? cookieParams?.state ?? '') || undefined;

    if (!clientId || !redirectUri) redirect('/applications');
    if (approve && !tenantId) redirect('/mcp-consent/review?error=workspace');

    let result: { redirect: string };
    try {
      result = await api<{ redirect: string }>({
        method: 'POST',
        path: '/api/v1/tenant/mcp/oauth/grant',
        body: {
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          ...(scope !== undefined ? { scope } : {}),
          ...(state !== undefined ? { state } : {}),
          tenant_id: tenantId,
          approve,
        },
      });
    } catch (err) {
      if (err instanceof PanelApiError) redirect('/mcp-consent/review?error=grant');
      throw err;
    }
    // Done — drop the pending cookie and hand the browser back to the client.
    jar2.delete(CONSENT_COOKIE);
    redirect(result.redirect);
  }

  const card =
    'w-full max-w-md space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm';

  if (me.memberships.length === 0) {
    return (
      <main className="min-h-screen grid place-items-center px-6">
        <div className={card}>
          <h1 className="text-xl font-semibold">No workspaces</h1>
          <p className="text-sm text-[var(--color-muted-fg)]">
            Your operator account isn&apos;t a member of any workspace. Ask an owner for an invite,
            then retry the connection.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-neutral-50 to-neutral-100 dark:from-neutral-950 dark:to-neutral-900">
      <div className={card}>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Authorize MCP connection</h1>
          <p className="text-sm text-[var(--color-muted-fg)]">
            Signed in as {me.user.email}. An MCP client is requesting access to one of your
            workspaces.
          </p>
        </div>

        {errored && (
          <p role="alert" className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {sp.error === 'workspace'
              ? 'Pick a workspace to continue.'
              : 'Could not complete authorization. Try again, or restart the connection from your client.'}
          </p>
        )}

        <div
          className={`rounded-md px-3 py-2 text-sm ${
            wantsAdmin
              ? 'border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-300'
              : wantsWrite
                ? 'border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-300'
                : 'border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-muted-fg)]'
          }`}
        >
          {wantsAdmin ? (
            <>
              <strong>Admin</strong> access: in addition to read &amp; write, the client can perform
              destructive / financial actions in the selected workspace — configure billing-provider
              credentials and cancel subscriptions. Only grant this to a client you fully trust;
              secrets you give it travel through that client.
            </>
          ) : wantsWrite ? (
            <>
              <strong>Read &amp; write</strong> access: the client can create and modify
              applications, plans, auth settings, and webhook endpoints in the selected workspace.
              It cannot configure billing credentials or cancel subscriptions.
            </>
          ) : (
            <>
              <strong>Read-only</strong> access: the client can view applications, end-users,
              payments, and webhooks in the selected workspace.
            </>
          )}
        </div>

        <form action={decide} className="space-y-4">
          {/* OAuth params carried through the form (public values; the grant
              endpoint re-validates every one server-side). More robust than
              relying on the consent cookie surviving the POST. */}
          <input type="hidden" name="client_id" value={params.client_id} />
          <input type="hidden" name="redirect_uri" value={params.redirect_uri} />
          <input type="hidden" name="code_challenge" value={params.code_challenge} />
          <input type="hidden" name="code_challenge_method" value={params.code_challenge_method} />
          {params.scope !== undefined && <input type="hidden" name="scope" value={params.scope} />}
          {params.state !== undefined && <input type="hidden" name="state" value={params.state} />}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Workspace</legend>
            <ul className="space-y-1.5">
              {me.memberships.map((m, i) => (
                <li key={m.tenantId}>
                  <label className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm cursor-pointer hover:bg-[var(--color-surface-muted)]">
                    <input
                      type="radio"
                      name="tenant_id"
                      value={m.tenantId}
                      defaultChecked={i === 0}
                      required
                    />
                    <span>{m.tenantName}</span>
                    <span className="ml-auto text-xs uppercase tracking-wide text-[var(--color-muted-fg)]">
                      {m.role}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          <div className="flex gap-2">
            <SubmitButton
              name="decision"
              value="allow"
              pendingLabel="Authorizing…"
              className="flex-1 rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60"
            >
              Allow
            </SubmitButton>
            <SubmitButton
              name="decision"
              value="deny"
              pendingLabel="Cancelling…"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-60"
            >
              Deny
            </SubmitButton>
          </div>
        </form>
      </div>
    </main>
  );
}
