/**
 * The customer's sign-in security, read with their own token: two-factor
 * status, live sessions and linked sign-in providers.
 */

import 'server-only';
import type { PortalConfig } from './config';
import { customerCall } from './customer-call';

export type TwoFactorPolicy = 'off' | 'optional' | 'required';
export type TwoFactorStatus = { enabled: boolean; remainingBackupCodes: number | null; policy: TwoFactorPolicy };
export type CustomerSession = { id: string; createdAt: string; userAgent: string | null; ip: string | null; current: boolean };
export type LinkedIdentity = { provider: string; email: string | null; createdAt: string };

/** One page at the API's maximum. */
const SESSION_PAGE = 'limit=100';

export function securityPath(slug: string): string {
  return `/${slug}/security`;
}

export async function twoFactorStatus(config: PortalConfig, accessToken: string): Promise<TwoFactorStatus | null> {
  const result = await customerCall<TwoFactorStatus>(config, accessToken, 'GET', '/api/v1/auth/mfa/status');
  return result.ok ? result.data : null;
}

export async function listSessions(config: PortalConfig, accessToken: string): Promise<CustomerSession[] | null> {
  const result = await customerCall<{ items: CustomerSession[] }>(
    config,
    accessToken,
    'GET',
    `/api/v1/auth/sessions?${SESSION_PAGE}`,
  );
  return result.ok ? result.data.items : null;
}

export async function listIdentities(config: PortalConfig, accessToken: string): Promise<LinkedIdentity[] | null> {
  const result = await customerCall<LinkedIdentity[]>(config, accessToken, 'GET', '/api/v1/auth/oauth/identities');
  return result.ok ? result.data : null;
}
