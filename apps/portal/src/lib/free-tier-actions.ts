'use server';

/**
 * Starts the application's free plan through `POST /api/v1/billing/subscribe`,
 * which moves no money and needs no payment provider.
 */

import { redirect } from 'next/navigation';
import { RekeyError } from '@rekey.dev/react';
import { getAccessToken, portalClientFor } from './session';
import { FREE_PLAN_STARTED } from './account-usage-copy';

export async function startFreePlanAction(slug: string, organizationId: string | null): Promise<void> {
  const [client, access] = await Promise.all([portalClientFor(slug), getAccessToken()]);
  if (!client || !access) redirect(`/${slug}/login?reason=expired`);
  try {
    await client.subscribe(access, organizationId ? { organizationId } : undefined);
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/${slug}?free_error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect(`/${slug}?free=${FREE_PLAN_STARTED}`);
}
