import * as React from 'react';
import { redirect } from 'next/navigation';
import {
  api,
  errorQuery,
  getApplication,
  getMe,
  getWorkspaceLimits,
  PanelApiError,
  readErrorFlash,
} from '@/lib/api';
import { ActionForm } from '@/components/ActionForm';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ApiErrorText } from '@/components/api-error';
import { SavedBanner } from '@/components/SavedBanner';
import { Banner } from '@/components/Banner';
import { PageHeader } from '@/components/PageHeader';
import { hasScope } from '@/lib/operator-scopes';
import { dangerButtonClass } from '@/components/Button';
import { ReportingTimezone } from './reporting-timezone';

const BASE = (id: string): string => `/applications/${encodeURIComponent(id)}/settings`;

async function promote(applicationId: string): Promise<void> {
  'use server';
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/promote`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${BASE(applicationId)}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${BASE(applicationId)}?promoted=1`);
}

async function disable(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const reason = String(formData.get('reason') ?? '').trim();
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/disable`,
      body: reason.length > 0 ? { reason } : {},
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${BASE(applicationId)}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${BASE(applicationId)}?disabled=1`);
}

async function enable(applicationId: string): Promise<void> {
  'use server';
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/disable`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${BASE(applicationId)}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${BASE(applicationId)}?enabled=1`);
}

async function signOutAllEndUsers(applicationId: string): Promise<void> {
  'use server';
  let revoked: number;
  try {
    const r = await api<{ sessionsRevoked: number }>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/rotate-sessions`,
    });
    revoked = r.sessionsRevoked;
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${BASE(applicationId)}?${await errorQuery(err)}&card=signout`);
    }
    throw err;
  }
  redirect(`${BASE(applicationId)}?rotated=${revoked}`);
}

const ERR: Record<string, string> = {
  ALREADY_PROMOTED: 'This application is already in production. Promotion happens once.',
  APPLICATION_DISABLED: 'Enable the application before promoting it.',
  APP_ACCESS_DENIED: 'Only the workspace owner can do this.',
  TENANT_ROLE_INSUFFICIENT:
    'Only the workspace owner can promote or disable an application. Admins and application ' +
    'grants do not unlock it.',
  // Deliberately NOT mapped: TENANT_QUOTA_EXCEEDED. The API's own message
  // names which applications hold the slots and what the remedy is, and a
  // fixed string here would replace that with something less useful.
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Why the promote control is or is not available.
 *
 * Returned as a discriminated reason rather than a bare boolean because a
 * disabled button with no explanation is the thing operators file tickets
 * about. Every blocked state below renders its own sentence and its own way
 * forward.
 */
type PromoteState =
  | { kind: 'available'; remaining: number | null }
  | { kind: 'not-owner' }
  | { kind: 'already' }
  | { kind: 'app-disabled' }
  | { kind: 'no-slots'; max: number };

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);

  const [app, me] = await Promise.all([getApplication(id), getMe()]);
  // Promote, disable and enable are workspace-OWNER only. The server enforces it
  // regardless; this decides whether to render those controls at all, so an
  // admin is told the rule instead of discovering it by being refused. Signing
  // everyone out needs `auth-config:write` on this Application instead, read
  // from the same grant AppNav uses; without it the card says why.
  const isOwner = me.activeRole === 'OWNER';
  const canSignOutAll = hasScope(app.access?.scopes ?? null, 'auth-config:write');
  const canReadLimits = isOwner || me.activeRole === 'ADMIN';

  // Fetched only when the role can read it, NOT fetched-and-caught.
  // `/workspace/limits` is OWNER/ADMIN, but this whole tab is reachable by any
  // MEMBER holding a grant on the application, and `api()` turns a 403 on a
  // GET into `forbidden()`, which replaces the entire page. Requesting it
  // unconditionally therefore broke the tab outright for exactly the people who
  // never needed the number: a non-owner's promote state is 'not-owner' before
  // any quota branch is consulted.
  const workspace = canReadLimits ? await getWorkspaceLimits() : null;

  const isDisabled = app.disabledAt != null;
  const isProduction = app.environment === 'PRODUCTION';
  const max = workspace?.limits.maxProductionApps;
  // Absent OR null means unlimited. Reading a missing key as 0 here would grey
  // out the button on every workspace that never had a limit set, which is the
  // default state of every self-host deployment.
  const unlimited = max === undefined || max === null;
  const used = workspace?.usage.productionApps ?? 0;

  const promoteState: PromoteState = isProduction
    ? { kind: 'already' }
    : !isOwner
      ? { kind: 'not-owner' }
      : isDisabled
        ? { kind: 'app-disabled' }
        : unlimited || used < max
          ? { kind: 'available', remaining: unlimited ? null : max - used }
          : { kind: 'no-slots', max };

  return (
    <div className="space-y-5">
      <PageHeader
        level={2}
        title="Settings"
        description={`Promote this application to production, sign every end-user out after an incident, or take the application offline without deleting anything.${
          app.reportingTimezone === undefined ? '' : ' Also the timezone its reports count days in.'
        }`}
      />

      {sp.promoted === '1' && (
        <SavedBanner
          params={['promoted']}
          message="Promoted to production. Existing API keys still work but are labelled rp_test_. Mint a live key on the API keys tab when convenient."
        />
      )}
      {sp.disabled === '1' && (
        <SavedBanner
          params={['disabled']}
          message="Application disabled. It is serving no end-user traffic. Nothing was deleted."
        />
      )}
      {sp.timezone === '1' && (
        <SavedBanner params={['timezone']} message="Reporting timezone saved. Days from now on are counted in it." />
      )}
      {sp.enabled === '1' && (
        <SavedBanner params={['enabled']} message="Application enabled. Traffic is flowing again." />
      )}
      {typeof sp.rotated === 'string' && (
        <SavedBanner
          params={['rotated']}
          message={`Every end-user is signed out. Their access tokens stopped working and ${sp.rotated} refresh token(s) were revoked.`}
        />
      )}
      {error && (
        <Banner tone="error">
          <ApiErrorText
            code={error}
            detail={errorDetail}
            fix={errorFix}
            map={sp.card === 'signout' ? {} : ERR}
            fallback={error}
          />
        </Banner>
      )}

      {isDisabled && (
        <Banner tone="warning">
          <strong>This application is disabled.</strong> It refuses every end-user request, serves
          no hosted portal, and sends no email or webhooks. All data is intact and every setting is
          unchanged. Disabled {fmt(app.disabledAt)}
          {app.disabledReason ? `: ${app.disabledReason}` : ''}.
        </Banner>
      )}

      {app.reportingTimezone !== undefined && (
        <ReportingTimezone
          applicationId={id}
          current={app.reportingTimezone}
          canWrite={
            (app.access === undefined || ['workspace-admin', 'APP_ADMIN'].includes(app.access.level)) &&
            hasScope(app.access?.scopes ?? null, 'overview:write')
          }
        />
      )}

      {/* ---------------- Environment / promote ---------------- */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="space-y-1 px-5 py-4">
          <div className="text-sm font-medium text-[var(--color-fg)]">Environment</div>
          <p className="text-xs text-[var(--color-muted-fg)]">
            This application is <strong>{app.environment}</strong>
            {app.promotedAt ? `, promoted ${fmt(app.promotedAt)}` : ''}. Promotion is one-way and
            happens once: there is no way to move an application back out of production.
          </p>
        </div>

        <div className="border-t border-[var(--color-border)] px-5 py-4">
          {/* The workspace's slot position, stated whatever the button does.
              An operator deciding whether to promote needs the number even
              when the answer is yes, and especially when it is no.

              Rendered only when we actually fetched it. A MEMBER cannot read
              workspace limits, and `used` falls back to 0 for them, printing
              this line anyway would tell them the workspace runs zero
              production applications with no limit, which is a fabricated
              number, not a degraded one. Say nothing rather than something
              false. */}
          {workspace !== null && (
            <p className="text-xs text-[var(--color-muted-fg)]">
              {unlimited
                ? `This workspace has no production limit. It is running ${used} production application${used === 1 ? '' : 's'}.`
                : `This workspace is running ${used} of ${max} production application${max === 1 ? '' : 's'}. Disabled production applications do not count.`}
            </p>
          )}

          <div className="mt-3">
            {promoteState.kind === 'not-owner' && (
              <p className="text-xs text-[var(--color-muted-fg)]">
                Only the workspace owner can promote an application to production. Your role is{' '}
                {me.activeRole.toLowerCase()}.
              </p>
            )}

            {promoteState.kind === 'already' && (
              <p className="text-xs text-[var(--color-muted-fg)]">
                Already in production. Nothing further to do here.
              </p>
            )}

            {promoteState.kind === 'app-disabled' && (
              <p className="text-xs text-[var(--color-muted-fg)]">
                Enable this application before promoting it. Promoting it while disabled would
                consume a production slot for something serving no traffic.
              </p>
            )}

            {promoteState.kind === 'no-slots' && (
              // Not a greyed-out button. A control that cannot work is removed
              // and replaced by the reason and the two real remedies, because
              // a disabled button teaches an operator to click and re-click it.
              <Banner tone="warning">
                <strong>No production slots free.</strong> This workspace is already running its
                limit of {promoteState.max} production application
                {promoteState.max === 1 ? '' : 's'}. Disable a production application you are no
                longer running to free its slot, or raise the limit. It cannot be raised from the
                panel: on a self-hosted deployment a super-admin sets it, and on Rekey Cloud it
                comes from the workspace&apos;s plan (see rekey.dev/pricing).
              </Banner>
            )}

            {promoteState.kind === 'available' && (
              <ActionForm action={promote.bind(null, id)}>
                <TypedConfirmButton
                  expected={app.slug}
                  title="Promote to production?"
                  description={
                    'This application moves to the production environment permanently. There is ' +
                    'no way to move it back, and no way to delete an application. New API keys ' +
                    'will be minted with the rp_live_ prefix; existing keys keep working ' +
                    'unchanged.' +
                    (promoteState.remaining === null
                      ? ''
                      : ` This uses one of your workspace's production slots, leaving ${
                          promoteState.remaining - 1
                        }.`)
                  }
                  triggerLabel="Promote to production"
                  confirmLabel="Promote"
                  triggerClassName="inline-flex items-center rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
                />
              </ActionForm>
            )}
          </div>
        </div>
      </div>

      <div
        id="force-logout"
        className="scroll-mt-28 md:scroll-mt-24 rounded-xl border border-red-300 bg-red-50/40 dark:border-red-800 dark:bg-red-950/30"
      >
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-red-700 dark:text-red-300">Sign out all end-users</div>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
              For a leak or an incident. Every end-user access token for this application stops
              working at once and every refresh token is revoked, so everyone signs in again. It
              cannot be undone.
            </p>
          </div>
          {canSignOutAll ? (
            <ActionForm action={signOutAllEndUsers.bind(null, id)} className="shrink-0">
              <TypedConfirmButton
                expected={app.slug}
                title="Sign out all end-users?"
                description="Every live end-user access token for this application is invalidated and all refresh tokens are revoked, so every user must sign in again. This cannot be undone."
                triggerLabel="Sign out all end-users"
                confirmLabel="Sign out all end-users"
                triggerClassName={dangerButtonClass('sm')}
              />
            </ActionForm>
          ) : (
            <p className="max-w-[16rem] shrink-0 text-xs text-[var(--color-muted-fg)] sm:text-right">
              Needs write access to this application&apos;s authentication settings. Ask a workspace
              owner or admin.
            </p>
          )}
        </div>
      </div>

      {/* ---------------- Disable / enable ---------------- */}
      <div className="rounded-xl border border-red-300 bg-red-50/40 dark:border-red-800 dark:bg-red-950/30">
        <div className="px-5 py-4">
          <div className="text-sm font-medium text-red-700 dark:text-red-300">
            {isDisabled ? 'Enable application' : 'Disable application'}
          </div>
          <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
            {isDisabled ? (
              <>
                Restores this application to exactly the state it was frozen in. End-user sessions
                that were valid before the freeze are still valid.
                {isProduction
                  ? ' This is a production application, so enabling it takes a production slot and will be refused if the workspace has none free.'
                  : ''}
              </>
            ) : (
              <>
                Takes this application offline. Every end-user request is refused, the hosted portal
                stops answering, and no email, webhook or dunning escalation is sent. <strong>
                  Nothing is deleted and no session is revoked
                </strong>.{' '}
                Enabling it again restores everything.
                {isProduction
                  ? ' Frees this application’s production slot; taking it back later needs a free slot.'
                  : ''}{' '}
                Rekey has no application delete, so this is the way to retire one.
              </>
            )}
          </p>

          {!isOwner ? (
            <p className="mt-3 text-xs font-medium text-[var(--color-muted-fg)]">
              Only the workspace owner can {isDisabled ? 'enable' : 'disable'} an application. Your
              role is {me.activeRole.toLowerCase()}, so ask an owner to do this.
            </p>
          ) : isDisabled ? (
            <ActionForm action={enable.bind(null, id)} className="mt-3">
              <ConfirmButton
                title="Enable this application?"
                confirm={
                  isProduction
                    ? 'End-user traffic starts flowing again immediately. This takes one of the workspace\u2019s production slots and will be refused if none is free.'
                    : 'End-user traffic starts flowing again immediately.'
                }
                confirmLabel="Enable"
                variant="subtle"
              >
                Enable application
              </ConfirmButton>
            </ActionForm>
          ) : (
            <ActionForm action={disable.bind(null, id)} className="mt-3 space-y-2">
              <label
                className="block text-xs font-medium text-[var(--color-fg)]"
                htmlFor="reason"
              >
                Reason (optional, for your own records)
              </label>
              <input
                id="reason"
                name="reason"
                maxLength={500}
                placeholder="e.g. migrated to the new workspace"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:italic placeholder:text-[var(--color-faint-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]"
              />
              <TypedConfirmButton
                expected={app.slug}
                title="Disable this application?"
                description="Every end-user request will be refused until you enable it again. Sign-in, billing, the hosted portal and all outbound email and webhooks stop. No data is deleted and no session is revoked."
                triggerLabel="Disable application"
                confirmLabel="Disable"
                triggerClassName={dangerButtonClass('sm')}
              />
            </ActionForm>
          )}
        </div>
      </div>
    </div>
  );
}
