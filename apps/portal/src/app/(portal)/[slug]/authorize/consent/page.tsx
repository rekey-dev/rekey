import * as React from 'react';
import { notFound, redirect } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';
import { getPortalUser } from '@/lib/session';
import { isSessionRefusal } from '@/lib/devices';
import {
  authorizeCall,
  describeScopes,
  redirectDestination,
  shownClientName,
  NEEDS_DEVICE_SESSION,
  type AuthorizationPreview,
} from '@/lib/authorize-request';
import { authorizeRequestId, authorizeSignInPath } from '@/lib/authorize-paths';
import { AUTHORIZE_EXPIRED_COPY, AUTHORIZE_EXPIRED_HEADING, authorizeErrorCopy } from '@/lib/authorize-copy';
import {
  allowAuthorizationAction,
  cancelAuthorizationAction,
  switchAccountAction,
} from '@/lib/authorize-actions';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';

function Expired(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-sm space-y-4 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">{AUTHORIZE_EXPIRED_HEADING}</h1>
      <p role="status" className="text-sm text-[var(--color-muted-fg)]">
        {AUTHORIZE_EXPIRED_COPY}
      </p>
    </div>
  );
}

export default async function AuthorizeConsentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const config = await getPortalConfig(slug);
  if (!config) notFound();
  const appName = config.branding.displayName || config.name;

  const id = authorizeRequestId(sp.request);
  if (!id) return <Expired />;

  const session = await getPortalUser(slug);
  if (!session) redirect(authorizeSignInPath(slug, id));

  const preview = await authorizeCall<AuthorizationPreview>(config, 'preview', { request_id: id }, session.accessToken);
  if (!preview.ok) {
    // Signing out first: the login page sends a signed-in visitor straight
    // back here, so a plain redirect to it would loop.
    if (isSessionRefusal(preview.code)) {
      return (
        <div className="mx-auto max-w-sm space-y-4 pt-10">
          <h1 className="text-lg font-semibold text-[var(--color-fg)]">Sign in again to continue</h1>
          <p className="text-sm text-[var(--color-muted-fg)]">Your session has ended. Sign in again to come back to this request.</p>
          <form action={switchAccountAction.bind(null, slug, id)}>
            <SubmitButton pendingLabel="Signing out…" className="w-full">
              Sign in again
            </SubmitButton>
          </form>
        </div>
      );
    }
    if (preview.code === NEEDS_DEVICE_SESSION) {
      const named = typeof preview.details?.client_name === 'string' ? preview.details.client_name : null;
      const client = shownClientName(named);
      return (
        <div className="mx-auto max-w-sm space-y-4 pt-10">
          <h1 className="text-lg font-semibold text-[var(--color-fg)]">This app cannot be approved here</h1>
          <p role="status" className="text-sm text-[var(--color-muted-fg)]">
            {appName} signs in from the app itself, so it cannot approve {client ?? 'this app'} here.
          </p>
          <form action={cancelAuthorizationAction.bind(null, slug, id, client)}>
            <SubmitButton pendingLabel="Going back…" className="w-full">
              Go back to {client ?? 'the app'}
            </SubmitButton>
          </form>
        </div>
      );
    }
    if (preview.code === 'AUTHORIZATION_REQUEST_UNKNOWN' || preview.code === 'INVALID_GRANT_REQUEST') {
      return <Expired />;
    }
    return (
      <div className="mx-auto max-w-sm space-y-4 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">This request could not be loaded</h1>
        <Banner tone="error">
          The sign-in service did not answer. Reload this page in a moment, or start again from the app that sent you
          here.
        </Banner>
      </div>
    );
  }

  const request = preview.data;
  const client = shownClientName(request.client_name);
  const destination = redirectDestination(request.redirect_uri);
  const scopes = describeScopes(request.scope);
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const clientLabel = client ?? 'An app that gave no name';

  return (
    <div className="mx-auto max-w-md space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Allow access to your {appName} account?</h1>

      {error && <Banner tone="error">{authorizeErrorCopy(error)}</Banner>}

      <dl className="space-y-4 text-sm">
        <div className="space-y-1">
          <dt className="font-medium text-[var(--color-fg)]">App requesting access</dt>
          <dd className="break-words text-[var(--color-fg)]">{clientLabel}</dd>
          <dd className="text-[var(--color-muted-fg)]">
            Apps choose their own names and nobody checks them, so go by where you will be sent.
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="font-medium text-[var(--color-fg)]">You will be sent to</dt>
          <dd className="break-all font-mono text-[var(--color-fg)]">{destination.shown}</dd>
          {destination.kind === 'this-computer' && (
            <dd className="text-[var(--color-muted-fg)]">That is a program on this computer. Desktop apps sign in this way.</dd>
          )}
          {destination.kind === 'app' && (
            <dd className="text-[var(--color-muted-fg)]">That address opens an app installed on this device.</dd>
          )}
        </div>
        <div className="space-y-1">
          <dt className="font-medium text-[var(--color-fg)]">If you allow it, the app can</dt>
          <dd>
            <ul className="list-disc space-y-1 pl-5 text-[var(--color-fg)]">
              {scopes.map((s) => (
                <li key={s.scope}>
                  {s.words ?? (
                    <>
                      Use the permission <code className="font-mono">{s.scope}</code>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="font-medium text-[var(--color-fg)]">Signed in as</dt>
          <dd className="break-all text-[var(--color-fg)]">{request.account.email}</dd>
        </div>
      </dl>

      <form action={switchAccountAction.bind(null, slug, id)}>
        <SubmitButton variant="secondary" pendingLabel="Signing out…" className="w-full">
          Not you? Use a different account
        </SubmitButton>
      </form>

      <p className="text-sm text-[var(--color-muted-fg)]">
        If you did not just start signing in from an app you trust, choose Cancel. Cancel sends you back to the app with
        nothing shared.
      </p>

      <div className="flex gap-3">
        <form action={allowAuthorizationAction.bind(null, slug, id, client)} className="flex-1 space-y-3">
          {request.organizations.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-[var(--color-fg)]">Act for</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="organization" value="personal" defaultChecked /> Your personal account
              </label>
              {request.organizations.map((o) => (
                <label key={o.id} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="organization" value={o.id} /> {o.name}
                  <span className="text-[var(--color-muted-fg)]">({o.role})</span>
                </label>
              ))}
            </fieldset>
          )}
          <SubmitButton pendingLabel="Allowing…" className="w-full">
            Allow
          </SubmitButton>
        </form>
        <form action={cancelAuthorizationAction.bind(null, slug, id, client)} className="flex-1 self-end">
          <SubmitButton variant="secondary" pendingLabel="Cancelling…" className="w-full">
            Cancel
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
