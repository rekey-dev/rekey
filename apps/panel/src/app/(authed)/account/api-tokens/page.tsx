/**
 * Account → API tokens (PATs).
 *
 * Operator personal-access-tokens (PATs, `rp_op_…`): long-lived, revocable,
 * SCOPED credentials an operator (or an AI agent acting as them) uses to call
 * tenant routes without a session — replacing the global SUPER_ADMIN_KEY. Mint
 * is OWNER/ADMIN only; the raw token is shown EXACTLY ONCE (stashed in a
 * short-lived HttpOnly cookie for the post-redirect reveal, never in the URL).
 *
 * Also documents wiring the @rekey.dev/mcp server with a PAT so AI tools can mint
 * Application API keys via the scoped `keys:mint` tool instead of the master key.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { api, PanelApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/Badge';
import { CopyButton } from '@/components/CopyButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { formatDate, formatDateTime } from '@/lib/date';
import { Banner } from '@/components/Banner';

interface OperatorTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const SCOPES: { value: string; label: string; help: string; tone: 'neutral' | 'brand' | 'warning' }[] = [
  { value: 'read', label: 'read', help: 'Read-only tenant introspection (list apps, keys).', tone: 'neutral' },
  { value: 'applications:write', label: 'applications:write', help: 'Create / update Applications.', tone: 'warning' },
  { value: 'keys:mint', label: 'keys:mint', help: 'Mint Application API keys (highest privilege).', tone: 'brand' },
];
function scopeTone(scope: string): 'neutral' | 'brand' | 'warning' {
  return SCOPES.find((s) => s.value === scope)?.tone ?? 'neutral';
}

const REVEAL_COOKIE = 'relipay_pat_reveal';
// Short floor: the reveal is dismissed (cookie deleted) the moment the operator
// clicks "Done" or navigates away, so this max-age is only the fallback window
// if they abandon the tab. Kept tight to limit how long the raw token lingers.
const REVEAL_COOKIE_MAX_AGE = 60 * 2; // 2 min fallback — copy, then it's gone.

const ERR: Record<string, string> = {
  TENANT_ROLE_INSUFFICIENT: 'Only workspace owners and admins can mint or revoke personal-access-tokens.',
  OPERATOR_SCOPE_UNKNOWN: 'Unknown scope. Allowed: read, applications:write, keys:mint.',
  OPERATOR_TOKEN_LIMIT_REACHED: 'You already have the maximum number of active tokens — revoke one first.',
  NAME_REQUIRED: 'Give the token a name.',
  EXPIRES_IN_PAST: 'Expiry must be in the future (or leave it blank for no expiry).',
};

async function mintToken(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const scopes = formData.getAll('scopes').map((s) => String(s));
  const expiresRaw = String(formData.get('expiresAt') ?? '').trim();
  if (!name) redirect('/account/api-tokens?error=NAME_REQUIRED');

  let expiresAt: string | undefined;
  if (expiresRaw) {
    const d = new Date(expiresRaw);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
      redirect('/account/api-tokens?error=EXPIRES_IN_PAST');
    }
    expiresAt = d.toISOString();
  }

  let result: { rawToken: string; apiToken: { tokenPrefix: string } };
  try {
    result = await api<{ rawToken: string; apiToken: { tokenPrefix: string } }>({
      method: 'POST',
      path: '/api/v1/tenant/auth/api-tokens',
      body: { name, scopes, ...(expiresAt ? { expiresAt } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/account/api-tokens?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }

  const jar = await cookies();
  jar.set(REVEAL_COOKIE, JSON.stringify({ rawToken: result.rawToken, prefix: result.apiToken.tokenPrefix }), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/account/api-tokens',
    maxAge: REVEAL_COOKIE_MAX_AGE,
  });
  revalidatePath('/account/api-tokens');
  redirect('/account/api-tokens?minted=1');
}

async function revokeToken(formData: FormData): Promise<void> {
  'use server';
  const id = String(formData.get('id') ?? '');
  try {
    await api({ method: 'DELETE', path: `/api/v1/tenant/auth/api-tokens/${encodeURIComponent(id)}` });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/account/api-tokens?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath('/account/api-tokens');
  redirect('/account/api-tokens?revoked=1');
}

/**
 * Dismiss the one-time reveal: delete the cookie and drop the `?minted=1`
 * query so a refresh can't re-display the raw token. A Server Component render
 * cannot mutate cookies in Next 15 — only a Server Action / Route Handler can —
 * so the delete-on-read has to live here, invoked by the "Done" button (and as
 * a belt-and-braces auto-dismiss) once the operator has had a chance to copy it.
 */
async function dismissReveal(): Promise<void> {
  'use server';
  const jar = await cookies();
  jar.delete(REVEAL_COOKIE);
  revalidatePath('/account/api-tokens');
  redirect('/account/api-tokens');
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

export default async function ApiTokensPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const minted = sp.minted === '1';
  const revoked = sp.revoked === '1';

  const tokens = await api<OperatorTokenRow[]>({
    method: 'GET',
    path: '/api/v1/tenant/auth/api-tokens',
  });

  // One-time raw-token reveal (cookie set by mintToken on the prior request).
  const jar = await cookies();
  let reveal: { rawToken: string; prefix: string } | null = null;
  const revealCookie = jar.get(REVEAL_COOKIE)?.value;
  if (minted && revealCookie) {
    try {
      reveal = JSON.parse(revealCookie) as { rawToken: string; prefix: string };
    } catch {
      /* stale */
    }
  }

  return (
    <section className="mx-auto max-w-7xl space-y-10 px-6 py-8 lg:px-8">
      <PageHeader
        title="API tokens"
        description="Personal-access-tokens (rp_op_…) let you — or an AI agent acting as you — call the Rekey API without a session, scoped to exactly what you grant. Revocable any time. For MCP setup see Account → Operator MCP."
      />

      {error && (
        <Banner tone="error">
          {ERR[error] ?? 'Something went wrong. Please try again.'}
        </Banner>
      )}
      {revoked && (
        <Banner tone="success">
          Token revoked.
        </Banner>
      )}

      {/* One-time reveal */}
      {minted && reveal && (
        <div className="rounded-lg border-2 border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-950 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              New token — copy it now, it&apos;s shown once
            </p>
            <CopyButton value={reveal.rawToken} label="Copy token" />
          </div>
          <code className="block break-all rounded bg-[var(--color-surface)] px-3 py-2 text-xs font-mono">
            {reveal.rawToken}
          </code>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Store it like a database password — only its SHA-256 hash is kept on the server, so it
            cannot be recovered.
          </p>
          <form action={dismissReveal}>
            <SubmitButton
              pendingLabel="Dismissing…"
              className="rounded-md border border-amber-400 dark:border-amber-600 px-3 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900 disabled:opacity-60"
            >
              Done — I&apos;ve copied it
            </SubmitButton>
          </form>
        </div>
      )}

      {/* ─── Mint ─────────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Create a token</h2>
          <p className="text-xs text-[var(--color-muted-fg)] mt-0.5">
            Default-deny: pick only the scopes the token needs. Owners and admins only.
          </p>
        </div>
        <form
          action={mintToken}
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-4"
        >
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-xs font-medium">Name</span>
              <input type="text" name="name" required maxLength={120} placeholder="ci-deploy, agent-worker…" className={inputCls} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Expires <span className="text-[var(--color-faint-fg)]">(optional)</span></span>
              <input type="date" name="expiresAt" className={inputCls} />
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">Scopes</legend>
            {SCOPES.map((s) => (
              <label key={s.value} className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" name="scopes" value={s.value} defaultChecked={s.value === 'read'} className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)]" />
                <span className="space-y-0.5">
                  <Badge tone={s.tone}>{s.label}</Badge>
                  <span className="block text-xs text-[var(--color-muted-fg)]">{s.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <SubmitButton pendingLabel="Creating token…">Create token</SubmitButton>
        </form>
      </section>

      {/* ─── Active tokens ────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-medium">
            Active tokens <span className="text-[var(--color-muted-fg)] text-sm font-normal">({tokens.length})</span>
          </h2>
        </div>
        {tokens.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-8 text-center text-sm text-[var(--color-muted-fg)]">
            No personal-access-tokens yet.
          </div>
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Token</TH>
                <TH>Scopes</TH>
                <TH>Last used</TH>
                <TH>Expires</TH>
                <TH align="right"> </TH>
              </TR>
            </THead>
            <TBody>
              {tokens.map((t) => (
                <TR key={t.id} hover>
                  <TD>{t.name}</TD>
                  <TD mono muted>{t.tokenPrefix}…</TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {t.scopes.length === 0 ? (
                        <span className="text-xs text-[var(--color-faint-fg)]">—</span>
                      ) : (
                        t.scopes.map((s) => <Badge key={s} tone={scopeTone(s)}>{s}</Badge>)
                      )}
                    </div>
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {t.lastUsedAt ? formatDateTime(t.lastUsedAt) : 'never'}
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {t.expiresAt ? formatDate(t.expiresAt) : 'never'}
                  </TD>
                  <TD align="right">
                    <form action={revokeToken} className="inline">
                      <input type="hidden" name="id" value={t.id} />
                      <ConfirmButton confirm={`Revoke "${t.name}"? Any tool using it stops working immediately.`}>
                        Revoke
                      </ConfirmButton>
                    </form>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      {/* MCP connection guide moved to its own page — `/account/mcp` — so this
          page focuses purely on PAT lifecycle (mint / list / revoke). The PAT
          minted here is also what the operator pastes into the MCP page's
          PAT-Bearer mcp.json snippet. */}
    </section>
  );
}
