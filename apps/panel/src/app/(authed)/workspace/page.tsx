import * as React from 'react';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, PanelApiError, type MeDto } from '@/lib/api';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
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
  revalidatePath('/workspace');
  redirect('/workspace?renamed=1');
}

// Workspace deletion isn't a self-serve API call — applications, billing rows,
// end-users, and licenses have to be unwound in the right order, so it's done
// manually by support. This action is the type-to-confirm gate: it records no
// state, it just routes a deliberate owner to the email step below.
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
    api<MeDto>({ method: 'GET', path: '/api/v1/tenant/auth/me' }),
  ]);
  const canEdit = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  const isOwner = me.activeRole === 'OWNER';

  const supportMailto =
    'mailto:support@relipay.dev?subject=Workspace+deletion+request' +
    `&body=${encodeURIComponent(`Please delete workspace "${workspace.name}" (${workspace.id}).`)}`;

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
            <p
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
            >
              {ERR[error] ?? error}
            </p>
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
                Deletion removes every application, billing record, end-user, and license. These are
                unwound in order, so it's handled manually — confirm and we'll walk you through the
                final email step. This can't be undone.
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
            <div className="border-t border-red-200 px-5 py-4 dark:border-red-900/60">
              <p className="text-sm font-medium text-[var(--color-fg)]">
                One last step to delete {workspace.name}
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
                Email{' '}
                <a href={supportMailto} className="underline hover:text-[var(--color-fg)]">
                  support@relipay.dev
                </a>{' '}
                from the OWNER address — we'll confirm and schedule it within one business day. We
                never delete a workspace without that email.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
