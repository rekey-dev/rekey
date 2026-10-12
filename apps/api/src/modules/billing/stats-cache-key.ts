/**
 * Where an Application's billing stats are cached. On its own so that the
 * setting that changes what the stats lead with can drop the cached value
 * without importing the stats service, which imports that setting.
 *
 * @example
 * forgetDashboard(billingStatsCacheKey(applicationId));
 */
export function billingStatsCacheKey(applicationId: string): string {
  return `rk:billing-stats:app:${applicationId}`;
}
