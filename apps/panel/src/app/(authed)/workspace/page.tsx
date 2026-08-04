import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, PanelApiError, getMe } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { Banner } from '@/components/Banner';
import { PageHeader } from '@/components/PageHeader';
import { Card } from '@/components/Card';
import { CopyButton } from '@/components/CopyButton';
import { Field, fieldInputCls } from '@/components/Field';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';

interface WorkspaceDto {
  id: string;
  name: string;
  createdAt: string;
}

async function renameWorkspace(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  if (!name) {
    redirect('/workspace?error=missing');
  }
  try {
    await api({
      method: 'PATCH',
      path: '/api/v1/tenant/workspace',
      body: { name },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/workspace?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/workspace?renamed=1');
}

/**
 * Who, if anyone, handles workspace deletion for this deployment.
 *
 * Read from `PANEL_SUPPORT_EMAIL` rather than hard-coded. The address used to
 * be a literal `support@rekey.dev` printed unconditionally, which meant a
 * SELF-HOSTED operator — the product's core pitch — was told to email a vendor
 * about rows in a database that vendor has no access to and cannot touch. That
 * instruction is not merely unhelpful, it is impossible to follow.
 *
 * Unset (the default, and therefore what every self-host sees) switches the
 * panel to the truthful answer: deletion is an operation the operator performs
 * against their own database. Rekey Cloud sets the variable and keeps the
 * deliberate manual-via-support path — friction on leaving is intended there,
 * and the operator confirmed that is the product decision.
 */
function supportEmail(): string | null {
  const raw = process.env.PANEL_SUPPORT_EMAIL?.trim();
  if (!raw) return null;
  // Cheap sanity check — a malformed value should degrade to the self-hosted
  // copy rather than render a broken mailto.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
}

// Workspace deletion isn't a self-serve API call — there is no DELETE on
// /api/v1/tenant/workspace, by design. This action is the type-to-confirm
// gate: it records no state, it just routes a deliberate owner to the
// instructions below (which differ for managed vs self-hosted).
async function requestWorkspaceDeletion(): Promise<void> {
  'use server';
  redirect('/workspace?deletionRequested=1');
}

const ERR: Record<string, string> = {
  missing: 'Name is required.',
  WORKSPACE_NAME_INVALID: 'Workspace name must be 2–80 characters.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can rename a workspace.',
};

export default async function WorkspaceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const renamed = typeof sp.renamed === 'string';
  const deletionRequested = typeof sp.deletionRequested === 'string';

  const [workspace, me] = await Promise.all([
    api<WorkspaceDto>({ method: 'GET', path: '/api/v1/tenant/workspace' }),
    getMe(),
  ]);
  const canEdit = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  const isOwner = me.activeRole === 'OWNER';

  const support = supportEmail();
  const supportMailto =
    support === null
      ? null
      : `mailto:${encodeURIComponent(support)}?subject=Workspace+deletion+request` +
        `&body=${encodeURIComponent(`Please delete workspace "${workspace.name}" (${workspace.id}).`)}`;
  const deleteSql = `DELETE FROM tenants WHERE id = '${workspace.id}';`;

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <PageHeader
        title="Workspace settings"
        description={
          <>
            Name and lifecycle for{' '}
            <strong className="text-[var(--color-fg)]">{workspace.name}</strong>.
          </>
        }
      />

      {renamed && <SavedBanner params={['renamed']} message="Workspace renamed." />}

      {/* General — rename */}
      <Card className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">General</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-fg)]">
            The workspace name is shown to your whole team across the panel.
          </p>
        </div>
        <form action={renameWorkspace} className="space-y-4">
          {error && (
            <Banner tone="error">
              {ERR[error] ?? 'Something went wrong. Please try again.'}
            </Banner>
          )}
          <Field
            label="Workspace name"
            required
            hint={canEdit ? '2–80 characters.' : undefined}
          >
            <input
              type="text"
              name="name"
              defaultValue={workspace.name}
              required
              minLength={2}
              maxLength={80}
              disabled={!canEdit}
              className={`${fieldInputCls} disabled:cursor-not-allowed disabled:opacity-60`}
            />
          </Field>
          <Field label="Workspace ID" hint="Stable identifier — share it with support if you hit an issue.">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={workspace.id}
                readOnly
                aria-label="Workspace ID"
                className={`${fieldInputCls} bg-[var(--color-surface-muted)] font-mono opacity-70`}
              />
              <CopyButton value={workspace.id} label="Copy" />
            </div>
          </Field>
          {canEdit ? (
            <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
          ) : (
            <p className="text-xs text-[var(--color-muted-fg)]">
              You're a {me.activeRole.toLowerCase()} — only owners and admins can edit workspace
              settings.
            </p>
          )}
        </form>
      </Card>

      {/* Danger zone — owner-only deletion (handled manually by support) */}
      {isOwner && (
        <div className="rounded-xl border border-red-300 bg-red-50/40 dark:border-red-800 dark:bg-red-950/30">
          <div className="flex items-start justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-red-700 dark:text-red-300">
                Delete workspace
              </div>
              <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
                Deletion removes every application, billing record, end-user, and license.
                {support === null
                  ? " There's no self-serve delete in the panel — on a self-hosted deployment it's an operation you run against your own database. Confirm and we'll show you exactly what to run."
                  : " These are unwound in order, so it's handled manually — confirm and we'll walk you through the final email step."}{' '}
                This can't be undone.
              </p>
            </div>
            {!deletionRequested && (
              <form action={requestWorkspaceDeletion} className="shrink-0">
                <TypedConfirmButton
                  expected={workspace.name}
                  title="Delete this workspace?"
                  description={`This unwinds every application, billing row, end-user, and license for "${workspace.name}". It can't be undone.`}
                  triggerLabel="Delete workspace"
                  confirmLabel="Continue to delete"
                />
              </form>
            )}
          </div>

          {deletionRequested && (
            <div className="space-y-2 border-t border-red-200 px-5 py-4 dark:border-red-900/60">
              <p className="text-sm font-medium text-[var(--color-fg)]">
                {support === null
                  ? `Delete ${workspace.name} on your own deployment`
                  : `One last step to delete ${workspace.name}`}
              </p>
              {support === null ? (
                <>
                  {/* Self-hosted: the data is on the operator's machine. Telling
                      them to email anyone would be telling them to ask a
                      stranger to touch a database the stranger cannot reach. */}
                  <p className="text-xs text-[var(--color-muted-fg)]">
                    This is your Rekey, so this is your database. Every application, end-user,
                    subscription, payment, licence, API key, and webhook under this workspace is
                    removed by foreign-key cascade from the one row below — nothing has to be
                    unwound by hand.
                  </p>
                  <p className="text-xs font-medium text-red-700 dark:text-red-300">
                    Take a backup first (<code className="font-mono">pg_dump</code>): this is not
                    reversible and Rekey keeps no copy.
                  </p>
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 font-mono text-xs text-[var(--color-fg)]">
                      {deleteSql}
                    </code>
                    <CopyButton value={deleteSql} label="Copy" />
                  </div>
                  <p className="text-xs text-[var(--color-muted-fg)]">
                    Run it against the database in <code className="font-mono">DATABASE_URL</code>.
                    Sign every operator out afterwards if any session for this workspace is still
                    live.
                  </p>
                </>
              ) : (
                <p className="text-xs text-[var(--color-muted-fg)]">
                  Email{' '}
                  <a href={supportMailto ?? undefined} className="underline hover:text-[var(--color-fg)]">
                    {support}
                  </a>{' '}
                  from the OWNER address — we'll confirm and schedule it within one business day. We
                  never delete a workspace without that email.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
