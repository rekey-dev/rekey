import * as React from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { api, PanelApiError, type ApiKeyRow, type ApplicationRow } from '@/lib/api';

// One-time reveal of a freshly minted secret key. Carried in a short-lived,
// httpOnly, path-scoped cookie instead of the URL query — a raw key in the URL
// leaks into browser history, the referer header, and server access logs.
const REVEAL_COOKIE = 'rekey_reveal_key';
import { CopyButton } from '@/components/CopyButton';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { Modal } from '@/components/Modal';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { EmptyState } from '@/components/EmptyState';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate, formatDateTime } from '@/lib/date';
import { keyPrefixFor } from '@/components/EnvironmentBadge';

const ERR: Record<string, string> = {
  missing: 'A key name is required.',
  API_KEY_LIMIT_REACHED:
    'This application has reached its API key limit. Revoke an unused key first.',
  API_KEY_EXPIRY_IN_PAST: 'The expiry date must be in the future.',
  PUBLIC_KEY_ROTATION_IN_GRACE:
    'A previous publishable key is still in its grace window. Confirm the forced rotation to drop it.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage API keys.',
  APPLICATION_NOT_FOUND: 'Application not found.',
};

interface CreateKeyResp {
  apiKey: ApiKeyRow;
  rawKey: string;
  warning: string;
}

// These actions deliberately redirect without revalidatePath — pairing the two
// is what blanked this page after a key was minted. Reasoning in `(authed)/layout.tsx`.

async function rotatePublicKey(applicationId: string, force: boolean): Promise<void> {
  'use server';
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/rotate-public-key`,
      // force only when the operator confirmed a rotation while a previous key
      // is still in its grace window (the card shows the warning in that case).
      body: { force },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/api-keys?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/api-keys?e=pubkey_rotated`);
}

async function createKey(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  if (!name) redirect(`/applications/${applicationId}/api-keys?error=missing&newKey=1`);
  try {
    const result = await api<CreateKeyResp>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/api-keys`,
      // The prefix follows the application's environment; it is not a choice here.
      body: { name },
    });
    // Hand the raw key to the next render via a short-lived httpOnly cookie,
    // never the URL. Path-scoped so it's only sent to this route; ~2 min TTL.
    const jar = await cookies();
    jar.set(REVEAL_COOKIE, result.rawKey, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: `/applications/${applicationId}/api-keys`,
      maxAge: 120,
    });
    redirect(`/applications/${applicationId}/api-keys?e=apikey_created`);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/api-keys?error=${encodeURIComponent(err.code)}&newKey=1`);
    }
    throw err;
  }
}

async function revokeKey(applicationId: string, keyId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/api-keys/${encodeURIComponent(keyId)}`,
  });
  redirect(`/applications/${applicationId}/api-keys?e=apikey_revoked`);
}

export default async function ApiKeysPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  // Read the one-time key from the httpOnly cookie set by createKey (auto-expires
  // ~2 min later, so a refresh stops showing it without us mutating cookies here).
  const reveal = (await cookies()).get(REVEAL_COOKIE)?.value;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The mint modal reopens itself only when the redirect carries `newKey=1`
  // (createKey failures). Errors without it — e.g. rotatePublicKey — would
  // otherwise render invisibly inside the closed modal, so show those at page
  // level instead (never both).
  const mintModalOpen = sp.newKey === '1';
  const [keys, app] = await Promise.all([
    api<ApiKeyRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/api-keys`,
    }),
    api<ApplicationRow>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
    }),
  ]);
  const graceUntil =
    app.previousPublicKeyValidUntil && new Date(app.previousPublicKeyValidUntil) > new Date()
      ? app.previousPublicKeyValidUntil
      : null;
  const hasCors = (app.corsOrigins?.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      {error && !mintModalOpen && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {ERR[error] ?? 'Something went wrong. Please try again.'}
        </p>
      )}
      <SectionHeader
        title="Publishable key"
        description={
          <>
            Browser-safe credential (<code className="font-mono text-xs">rp_pub_…</code>) for
            your frontend, mobile, or desktop app — pass it to <code>@rekey.dev/react</code> for
            sign-in, sign-up, magic links, passkeys, license checks, and plan listing with{' '}
            <strong>no backend required</strong>. It only identifies this application and carries no
            privileges of its own, so it's safe to ship in client code. Charging customers and
            changing accounts still need your secret key.
          </>
        }
      />
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <code className="flex-1 break-all rounded-md bg-[var(--color-bg)] px-3 py-2 text-xs font-mono">
            {app.publicKey}
          </code>
          <CopyButton value={app.publicKey} label="Copy" />
          <form action={rotatePublicKey.bind(null, id, Boolean(graceUntil))}>
            <TypedConfirmButton
              expected={app.slug}
              title="Rotate the publishable key?"
              description={
                graceUntil
                  ? `A previous key is still active until ${formatDateTime(graceUntil)}. Rotating again will drop that key immediately — any client still on it stops working at once. Only do this if the previous key leaked. Type the app slug to confirm.`
                  : 'Mints a new publishable key and keeps the current one valid for a 30-day grace window, so already-shipped clients keep working while you roll out the new key. After the window the old key stops working. Type the app slug to confirm.'
              }
              triggerLabel="Rotate"
              confirmLabel={graceUntil ? 'Drop previous + rotate' : 'Rotate key'}
            />
          </form>
        </div>
        {graceUntil && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/60 dark:bg-amber-950/60 dark:text-amber-300">
            Rotation in progress — the <strong>previous</strong> key keeps working until{' '}
            <strong>{formatDateTime(graceUntil)}</strong>. Deploy the new key to all clients before
            then, after which the old key stops verifying.
          </p>
        )}
        {!hasCors && (
          <p className="text-xs text-[var(--color-muted-fg)]">
            No origin allowlist set — any website can use this key. Add allowed browser origins
            under <strong>Access</strong> to restrict where it works.
          </p>
        )}
      </div>

      {reveal && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/60 dark:bg-amber-950/60 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              New API key (shown once — copy now)
            </p>
            <CopyButton value={reveal} label="Copy key" />
          </div>
          <code className="block break-all rounded-md bg-[var(--color-surface)] px-3 py-2 text-xs font-mono">
            {reveal}
          </code>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Pass as <code>Authorization: Bearer &lt;key&gt;</code> from your server-side code via <code>@rekey.dev/node</code>.
          </p>
        </div>
      )}

      <SectionHeader
        title="API keys"
        description={
          <>
            Server-side credentials for your backend + SDKs. Pass as
            <code className="mx-1 font-mono text-xs">Authorization: Bearer &lt;key&gt;</code>.
            Hashed at rest; the raw key is shown <strong>exactly once</strong> when minted.
          </>
        }
        action={
          <Modal
            modalKey="newKey"
            title="Mint a new API key"
            description={`Server-side key for your backend + SDKs (${keyPrefixFor(app.environment)}…, from this application's environment). Shown once at creation.`}
            trigger="+ New API key"
          >
            <form action={createKey.bind(null, id)} className="space-y-3">
              {error && mintModalOpen && (
                <p role="alert" className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  {ERR[error] ?? 'Something went wrong. Please try again.'}
                </p>
              )}
              <label className="block space-y-1">
                <span className="text-xs font-medium">Name</span>
                <input type="text" name="name" required autoFocus placeholder="Production server"
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]" />
                <span className="block text-xs text-[var(--color-muted-fg)]">Internal label — helps you identify the key in this list later.</span>
              </label>
              <SubmitButton pendingLabel="Minting key…">Mint key</SubmitButton>
              <p className="text-xs text-[var(--color-muted-fg)]">
                You'll see the raw key once after creation — copy it then. Only the SHA-256 hash is stored.
              </p>
            </form>
          </Modal>
        }
      />

      {keys.length === 0 ? (
        <EmptyState title="No active keys yet" description="Mint your first one with the button above." />
      ) : (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Prefix</TH>
              <TH>Last used</TH>
              <TH>Expires</TH>
              <TH align="right">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {keys.map((k) => (
              <TR key={k.id} hover>
                <TD>{k.name}</TD>
                <TD mono>{k.keyPrefix}…</TD>
                <TD muted className="text-xs">
                  {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : 'never'}
                </TD>
                <TD muted className="text-xs">
                  {k.expiresAt ? formatDate(k.expiresAt) : 'never'}
                </TD>
                <TD align="right">
                  <form action={revokeKey.bind(null, id, k.id)}>
                    <TypedConfirmButton
                      expected={k.name}
                      title={`Revoke API key "${k.name}"?`}
                      description="Any code using this key will immediately stop working. Re-issue is a 30-second flow but the new key has to be deployed everywhere it's used. This cannot be undone."
                      triggerLabel="Revoke"
                      confirmLabel="Revoke key"
                    />
                  </form>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
