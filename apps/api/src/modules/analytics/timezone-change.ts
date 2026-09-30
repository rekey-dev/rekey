import { bumpCacheVersion } from '../../lib/swr-cache.js';

/**
 * The version key every cached Users-overview section of one Application sits
 * under. Bumping it drops all of them at once.
 *
 * @example
 *   bumpCacheVersion(analyticsVersionKey(applicationId));
 */
export function analyticsVersionKey(applicationId: string): string {
  return `rk:an:users:${applicationId}:v`;
}

/**
 * Drop the cached sections of an Application whose reporting timezone
 * changed, so the next read resolves "today" and the range in the new zone.
 *
 * @example
 *   onReportingTimezoneChanged(applicationId);
 */
export function onReportingTimezoneChanged(applicationId: string): void {
  bumpCacheVersion(analyticsVersionKey(applicationId));
}
