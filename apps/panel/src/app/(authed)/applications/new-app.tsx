import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError, type ApplicationRow } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { ApiErrorText } from '@/components/api-error';
import { SlugAvailabilityField } from '@/components/SlugAvailabilityField';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';

/**
 * `environment` is chosen at create and afterwards moves in ONE direction only,
 * once, via `POST /:id/promote` (#475), no config route accepts the field.
 * Anything we don't recognise falls back to the API's own default rather than
 * being forwarded, so a tampered form can't 400 the create.
 */
function parseEnvironment(raw: FormDataEntryValue | null): ApplicationRow['environment'] {
  return raw === 'PRODUCTION' || raw === 'STAGING' ? raw : 'DEVELOPMENT';
}

// No revalidatePath before the redirect, see `(authed)/layout.tsx` for why.
// Worth noting this one revalidated the *destination* (`/applications/<newId>`)
// rather than the list it was submitted from, so it was invalidating a route
// that was about to be rendered fresh anyway.
async function createApp(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  const environment = parseEnvironment(formData.get('environment'));
  if (!name || !slug) redirect('/applications?error=missing&newApp=1');
  try {
    const app = await api<ApplicationRow>({
      method: 'POST',
      path: '/api/v1/tenant/applications/',
      body: { name, slug, environment },
    });
    redirect(`/applications/${app.id}?saved=created&e=app_created`);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications?${await errorQuery(err, { newApp: '1' })}`);
    }
    throw err;
  }
}

const ERR: Record<string, string> = {
  missing: 'Name and slug are required.',
  APPLICATION_SLUG_INVALID: 'Slug must be lowercase letters, digits, and hyphens (max 40 chars).',
  APPLICATION_SLUG_TAKEN: 'That slug is already taken (slugs are globally unique).',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can create applications.',
};

export function NewAppModal({
  error,
  errorDetail,
  errorFix,
  triggerLabel = '+ New application',
  triggerSize = 'sm',
  modalKey,
}: {
  error?: string;
  /** The API's own message + fix, shown when `ERR` has no entry for `error`. */
  errorDetail?: string;
  errorFix?: string;
  triggerLabel?: string;
  triggerSize?: 'sm' | 'md';
  modalKey: string;
}): React.JSX.Element {
  const triggerCls =
    triggerSize === 'md'
      ? 'inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] cursor-pointer'
      : 'inline-block rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] cursor-pointer whitespace-nowrap';
  return (
    <Modal
      modalKey={modalKey}
      title="Create application"
      description="An application is a self-contained set of end-users, auth, and (optional) billing. The slug is baked into API keys and webhook URLs, and the environment sets their prefix. Neither can be changed later."
      trigger={triggerLabel}
      triggerClassName={triggerCls}
    >
      <ActionForm action={createApp} className="space-y-3">
        {error && (
          <Banner tone="error">
            {/* The local map first, a page often has better words than the
                API. Then the API's own message, which for a quota refusal
                names the limit and the current count. "Something went wrong"
                only when there is genuinely nothing to say. */}
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} />
          </Banner>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">Application name</span>
          <input
            type="text"
            name="name"
            required
            autoFocus
            placeholder="Acme Production"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">Shown to your team in the panel.</span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Slug</span>
          <SlugAvailabilityField
            placeholder="acme-prod"
            inputClassName="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Environment</span>
          <select
            name="environment"
            defaultValue="DEVELOPMENT"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          >
            <option value="DEVELOPMENT">Development</option>
            <option value="STAGING">Staging</option>
            <option value="PRODUCTION">Production</option>
          </select>
          <span className="block text-xs text-[var(--color-muted-fg)]">
            What this application is. <strong>Cannot be changed later</strong>: to go live you
            create a new production application, so pick it now.
          </span>
        </label>
        <div className="rounded-md bg-[var(--color-surface-muted)] border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-fg)] space-y-1">
          <p className="font-medium text-[var(--color-fg)]">What you get</p>
          <ul className="list-disc pl-5 space-y-0.5">
            <li>Email + password sign-up / sign-in</li>
            <li>Empty OAuth slot (add Google / Microsoft / OIDC / … later)</li>
            <li>Mintable API keys: <code className="font-mono">rp_live_…</code> for production, <code className="font-mono">rp_test_…</code> otherwise</li>
            <li><strong>No billing</strong>: opt in on the Billing tab when you're ready</li>
          </ul>
          <p>
            The environment sets that key prefix and nothing else. It does not restrict which
            provider credentials the application may hold, so a development application can point
            at a live processor if that is deliberately what you want to test against.
          </p>
        </div>
        <SubmitButton pendingLabel="Creating application…">Create application</SubmitButton>
      </ActionForm>
    </Modal>
  );
}
