/**
 * Account → API tokens (PATs).
 *
 * Operator personal-access-tokens (PATs, `rp_op_…`): long-lived, revocable,
 * SCOPED credentials an operator (or an AI agent acting as them) uses to call
 * tenant routes without a session, replacing the global SUPER_ADMIN_KEY. Mint
 * is OWNER/ADMIN only; the raw token is shown EXACTLY ONCE, in the dialog
 * `RevealActionForm` opens from the mint action's own response (never a URL,
 * never a cookie).
 *
 * Also documents wiring the @rekey.dev/mcp server with a PAT so AI tools can mint
 * Application API keys via the scoped `keys:mint` tool instead of the master key.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { errorQuery, readErrorFlash, api, PanelApiError } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { ApiErrorText } from '@/components/api-error';
import { Badge } from '@/components/Badge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { RevealActionForm, type RevealResult } from '@/components/RevealActionForm';
import { WhileUrlHas } from '@/components/WhileUrlHas';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { formatDate, formatDateTime } from '@/lib/date';
import { Banner } from '@/components/Banner';
import type { Page } from '@/lib/paginate';

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

const ERR: Record<string, string> = {
  TENANT_ROLE_INSUFFICIENT: 'Only workspace owners and admins can mint or revoke personal-access-tokens.',
  OPERATOR_SCOPE_UNKNOWN: 'Unknown scope. Allowed: read, applications:write, keys:mint.',
  OPERATOR_TOKEN_LIMIT_REACHED: 'You already have the maximum number of active tokens. Revoke one first.',
  NAME_REQUIRED: 'Give the token a name.',
  EXPIRES_IN_PAST: 'Expiry must be in the future (or leave it blank for no expiry).',
};

async function mintToken(formData: FormData): Promise<RevealResult> {
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
      redirect(`/account/api-tokens?${await errorQuery(err)}`);
    }
    throw err;
  }

  // Returned to the dialog `RevealActionForm` opens; revalidating puts the new
  // token in the list behind it.
  revalidatePath('/account/api-tokens');
  return {
    secret: {
      title: 'Your new API token',
      value: result.rawToken,
      notes: [
        `Prefix ${result.apiToken.tokenPrefix}. Store it like a database password: only its SHA-256 hash is kept on the server, so it cannot be recovered.`,
      ],
    },
  };
}

async function revokeToken(formData: FormData): Promise<void> {
  'use server';
  const id = String(formData.get('id') ?? '');
  try {
    await api({ method: 'DELETE', path: `/api/v1/tenant/auth/api-tokens/${encodeURIComponent(id)}` });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/account/api-tokens?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect('/account/api-tokens?revoked=1');
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
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const revoked = sp.revoked === '1';

  const { items: tokens } = await api<Page<OperatorTokenRow>>({
    method: 'GET',
    path: '/api/v1/tenant/auth/api-tokens',
  });

  return (
    <section className="mx-auto max-w-7xl space-y-10 px-6 py-8 lg:px-8">
      <PageHeader
        title="API tokens"
        description="Personal-access-tokens (rp_op_…) let you (or an AI agent acting as you) call the Rekey API without a session, scoped to exactly what you grant. Revocable any time. For MCP setup see Account → Operator MCP."
      />

      {error && (
        <WhileUrlHas param="error">
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback="Something went wrong. Please try again." />
          </Banner>
        </WhileUrlHas>
      )}
      {revoked && (
        <Banner tone="success">
          Token revoked.
        </Banner>
      )}

      {/* ─── Mint ─────────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Create a token</h2>
          <p className="text-xs text-[var(--color-muted-fg)] mt-0.5">
            Default-deny: pick only the scopes the token needs. Owners and admins only.
          </p>
        </div>
        <RevealActionForm
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
        </RevealActionForm>
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
                    <ActionForm action={revokeToken} className="inline">
                      <input type="hidden" name="id" value={t.id} />
                      <ConfirmButton confirm={`Revoke "${t.name}"? Any tool using it stops working immediately.`}>
                        Revoke
                      </ConfirmButton>
                    </ActionForm>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      {/* MCP connection guide lives at /account/mcp; this page is PAT lifecycle
          only. The PAT minted here is what the operator pastes into that
          page's PAT-Bearer mcp.json snippet. */}
    </section>
  );
}
