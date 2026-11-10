/**
 * The customer's own devices, for an application that binds sign-in to one.
 * The portal session holds no device slot, so nothing here is "this device".
 */

import { DEVICE_LIMIT_FEATURE_KEY } from '@rekey.dev/shared-types';
import type { PortalConfig } from './config';
import { customerCall } from './customer-call';

export type CustomerDevice = { id: string; label: string | null; lastSeenAt: string };

export const SELF_RELEASE_DISABLED = 'DEVICE_SELF_RELEASE_DISABLED';
const SESSION_REFUSALS = new Set(['USER_TOKEN_MISSING', 'USER_TOKEN_INVALID', 'USER_TOKEN_WRONG_APPLICATION', 'SESSION_EXPIRED']);
/** One page at the API's maximum; nobody holds a hundred active devices. */
const DEVICE_PAGE = 'limit=100';

export function devicesPath(slug: string): string {
  return `/${slug}/devices`;
}

export function devicesSignInPath(slug: string): string {
  return `/${slug}/login?return=devices`;
}

export function isSessionRefusal(code: string): boolean {
  return SESSION_REFUSALS.has(code);
}

export function deviceName(device: CustomerDevice): string {
  return device.label?.trim() || 'Unnamed device';
}

/** Devices in one status, or null when the API could not answer. */
export async function listDevices(
  config: PortalConfig,
  accessToken: string,
  status: 'ACTIVE' | 'RELEASED',
): Promise<CustomerDevice[] | null> {
  const result = await customerCall<{ items: CustomerDevice[] }>(
    config,
    accessToken,
    'GET',
    `/api/v1/users/me/devices?status=${status}&${DEVICE_PAGE}`,
  );
  return result.ok ? result.data.items : null;
}

/**
 * The customer's `max_devices` entitlement, read the way the API enforces it:
 * a number, or a string that spells one. Null when uncapped or unreadable,
 * including when the application has billing off, since entitlements are a
 * billing read.
 */
export async function deviceLimit(config: PortalConfig, accessToken: string): Promise<number | null> {
  if (!config.billingEnabled) return null;
  const result = await customerCall<{ features: Record<string, unknown> }>(
    config,
    accessToken,
    'GET',
    '/api/v1/billing/entitlements',
  );
  if (!result.ok) return null;
  const value = result.data.features[DEVICE_LIMIT_FEATURE_KEY];
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/**
 * @example
 * removeDeviceErrorCopy('DEVICE_NOT_FOUND', 'Acme'); // 'That device is no longer on your account. ...'
 */
export function removeDeviceErrorCopy(code: string, appName: string): string {
  if (code === 'DEVICE_NOT_FOUND') return 'That device is no longer on your account. It may have been removed already.';
  if (code === 'DEVICE_BLOCKED') {
    return `That device is blocked, so it cannot be removed here. Contact ${appName} support for help with it.`;
  }
  return `The device could not be removed. Try again, and if it keeps happening, contact ${appName} support.`;
}
