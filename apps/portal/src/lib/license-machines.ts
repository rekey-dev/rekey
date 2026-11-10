/**
 * The machines holding seats on a customer's licence, read with their own
 * token, and the words the licenses page uses about them.
 */

import 'server-only';
import type { EndUserLicenseActivationDto } from '@rekey.dev/shared-types';
import type { PortalConfig } from './config';
import { customerCall } from './customer-call';

export function licensesPath(slug: string): string {
  return `/${slug}/licenses`;
}

/** The machines holding a seat on the licence, or null when they cannot be read. */
export async function activeMachines(
  config: PortalConfig,
  accessToken: string,
  licenseId: string,
): Promise<EndUserLicenseActivationDto[] | null> {
  const result = await customerCall<{ items: EndUserLicenseActivationDto[] }>(
    config,
    accessToken,
    'GET',
    `/api/v1/users/me/licenses/${encodeURIComponent(licenseId)}/activations?limit=100`,
  );
  return result.ok ? result.data.items.filter((m) => m.status === 'ACTIVE') : null;
}
