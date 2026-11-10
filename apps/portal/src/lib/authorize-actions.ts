'use server';

/**
 * Allow, Cancel and "Not you?" on the consent screen. Each is bound to the
 * slug and the request id by the page, and the id is checked again here.
 */

import { redirect } from 'next/navigation';
import { getPortalConfig } from './config';
import {
  clearMfaChallenge,
  clearSession,
  clearSignInReturn,
  getAccessToken,
  getRefreshToken,
  portalClientFor,
  rememberSignInReturn,
} from './session';
import {
  authorizeCall,
  clearAuthorizeDone,
  redirectDestination,
  setAuthorizeDone,
  type AuthorizeDone,
} from './authorize-request';
import { authorizeConsentPath, authorizeDonePath, authorizeRequestId, authorizeSignInPath } from './authorize-paths';

/** Send the browser on: straight there for a web address, through the done page for this computer or an app. */
async function finish(slug: string, done: AuthorizeDone): Promise<never> {
  await clearSignInReturn(slug);
  if (redirectDestination(done.target).opensInPage) redirect(done.target);
  await setAuthorizeDone(slug, done);
  redirect(authorizeDonePath(slug));
}

export async function allowAuthorizationAction(
  slug: string,
  requestId: string,
  clientName: string | null,
  formData: FormData,
): Promise<void> {
  const id = authorizeRequestId(requestId);
  if (!id) redirect(authorizeConsentPath(slug, null));
  const [config, access] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !access) {
    await rememberSignInReturn(slug, `authorize:${id}`);
    redirect(authorizeSignInPath(slug, id));
  }
  const organization = formData.get('organization');
  const result = await authorizeCall<{ redirect_to: string }>(
    config,
    'grant',
    {
      request_id: id,
      ...(typeof organization === 'string' && organization !== 'personal' && { organization_id: organization }),
    },
    access,
  );
  if (!result.ok) redirect(`${authorizeConsentPath(slug, id)}&error=${encodeURIComponent(result.code)}`);
  await finish(slug, { target: result.data.redirect_to, client: clientName, outcome: 'allowed' });
}

export async function cancelAuthorizationAction(slug: string, requestId: string, clientName: string | null): Promise<void> {
  const id = authorizeRequestId(requestId);
  if (!id) redirect(authorizeConsentPath(slug, null));
  const config = await getPortalConfig(slug);
  if (!config) redirect(`/${slug}`);
  const result = await authorizeCall<{ redirect_to: string }>(config, 'deny', { request_id: id });
  if (!result.ok) redirect(`${authorizeConsentPath(slug, id)}&error=${encodeURIComponent(result.code)}`);
  await finish(slug, { target: result.data.redirect_to, client: clientName, outcome: 'cancelled' });
}

/** Signs out and comes back to the same request once someone signs in. */
export async function switchAccountAction(slug: string, requestId: string): Promise<void> {
  const id = authorizeRequestId(requestId);
  const [client, refresh] = await Promise.all([portalClientFor(slug), getRefreshToken()]);
  if (client && refresh) await client.signOut(refresh).catch(() => undefined);
  await clearSession(slug);
  await clearMfaChallenge(slug);
  if (!id) redirect(`/${slug}/login`);
  await rememberSignInReturn(slug, `authorize:${id}`);
  redirect(authorizeSignInPath(slug, id));
}

/** Called by the done page once it has the target in hand. */
export async function forgetAuthorizeDoneAction(slug: string): Promise<void> {
  await clearAuthorizeDone(slug);
}
