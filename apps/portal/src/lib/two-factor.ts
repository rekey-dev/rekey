/**
 * Required two-factor enrolment for a signed-in customer.
 *
 * The API issues a session to a customer who has not enrolled yet and then
 * refuses it everything but enrolment. Pages ask `GET /auth/mfa/status` up
 * front so the customer lands on set-up before any refused call; a call
 * refused anyway redirects there too (lib/two-factor-redirect.ts).
 */

import 'server-only';
import { redirect } from 'next/navigation';
import { getPortalConfig, type PortalConfig } from './config';
import { customerCall } from './customer-call';
import { twoFactorSetUpPath } from './two-factor-redirect';

/**
 * True when the application requires two-factor and this customer has not
 * enrolled. A status the API cannot answer reads as not outstanding: the
 * portal's guard is a convenience, and an outage should not lock a customer
 * out of their billing.
 */
export async function twoFactorSetUpOutstanding(config: PortalConfig, accessToken: string): Promise<boolean> {
  if (!config.auth.mfaRequired) return false;
  const status = await customerCall<{ enabled: boolean; policy: string }>(
    config,
    accessToken,
    'GET',
    '/api/v1/auth/mfa/status',
  );
  return status.ok && status.data.policy === 'required' && !status.data.enabled;
}

export async function redirectWhileTwoFactorOutstanding(slug: string, accessToken: string): Promise<void> {
  const config = await getPortalConfig(slug);
  if (config && (await twoFactorSetUpOutstanding(config, accessToken))) redirect(twoFactorSetUpPath(slug));
}
