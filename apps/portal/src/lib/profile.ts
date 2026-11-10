/**
 * The customer's own record and the profile questions they may answer, read
 * with their own token.
 */

import 'server-only';
import type { EndUserProfile, ProfileField } from '@rekey.dev/shared-types';
import type { PortalConfig } from './config';
import { customerCall } from './customer-call';

export type CustomerRecord = { email: string; emailVerified: boolean; profile: EndUserProfile };

export function profilePath(slug: string): string {
  return `/${slug}/profile`;
}

export async function customerRecord(config: PortalConfig, accessToken: string): Promise<CustomerRecord | null> {
  const result = await customerCall<CustomerRecord>(config, accessToken, 'GET', '/api/v1/users/me');
  return result.ok ? { ...result.data, profile: result.data.profile ?? {} } : null;
}

/** The fields this customer may answer. A publishable key is already given only those; the filter keeps it so. */
export async function profileFields(config: PortalConfig, accessToken: string): Promise<ProfileField[] | null> {
  const result = await customerCall<{ fields: ProfileField[] }>(config, accessToken, 'GET', '/api/v1/profile-schema');
  return result.ok ? result.data.fields.filter((f) => f.writableBy === 'user') : null;
}
