'use server';

/** Freeing a licence seat from the customer's account. The API decides who may. */

import { redirect } from 'next/navigation';
import type { LicenseDeactivateResultDto } from '@rekey.dev/shared-types';
import { getPortalConfig } from './config';
import { customerCall } from './customer-call';
import { getAccessToken } from './session';
import { isSessionRefusal } from './devices';
import { licensesPath } from './license-machines';
import { LICENSE_INACTIVE, MACHINE_REMOVED } from './license-machines-copy';

export async function removeLicenseMachineAction(slug: string, licenseId: string, activationId: string): Promise<void> {
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !accessToken) redirect(`/${slug}/login?reason=expired`);
  const result = await customerCall<LicenseDeactivateResultDto>(
    config,
    accessToken,
    'DELETE',
    `/api/v1/users/me/licenses/${encodeURIComponent(licenseId)}/activations/${encodeURIComponent(activationId)}`,
  );
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?reason=expired`);
    redirect(`${licensesPath(slug)}?error=${encodeURIComponent(result.code)}`);
  }
  if (!result.data.ok) redirect(`${licensesPath(slug)}?error=${LICENSE_INACTIVE}`);
  redirect(`${licensesPath(slug)}?done=${MACHINE_REMOVED}`);
}
