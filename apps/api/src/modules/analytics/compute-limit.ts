/**
 * The Users overview's rate limit counts computations, not requests.
 *
 * A cached section costs a Redis read, so reloading the page should not use
 * up an operator's allowance; a cache miss scans the Application's rows, and
 * walking filter combinations with a script is exactly a stream of misses.
 * The route itself allows `ANALYTICS_REQUESTS_PER_MINUTE`; each section that
 * has to be computed draws on `ANALYTICS_COMPUTES_PER_MINUTE` per operator
 * per Application. Without Redis (tests, a Redis outage) nothing is counted.
 */

import { RekeyError } from '../../lib/error.js';
import { dashboardRedis } from '../../lib/dashboard-cache.js';

export const ANALYTICS_REQUESTS_PER_MINUTE = 120;
export const ANALYTICS_COMPUTES_PER_MINUTE = 30;

function tooManyComputes(retryAfterSeconds: number): RekeyError {
  return new RekeyError({
    statusCode: 429,
    code: 'RATE_LIMITED',
    message: `More than ${ANALYTICS_COMPUTES_PER_MINUTE} uncached Users-overview sections were computed for this Application in the last minute.`,
    fix: `Retry in ${retryAfterSeconds} seconds. Repeating a query already computed is served from cache and does not count.`,
    retryAfterSeconds,
  });
}

/**
 * A charge function for one operator on one Application, called before each
 * section computation.
 *
 * @example
 *   const charge = computeCharger(operatorId, applicationId);
 *   await charge();
 */
export function computeCharger(operatorId: string, applicationId: string, now: () => number = Date.now): () => Promise<void> {
  return async () => {
    const redis = dashboardRedis();
    if (!redis) return;
    const minute = Math.floor(now() / 60_000);
    const key = `rk:an:computes:${operatorId}:${applicationId}:${minute}`;
    let count: number;
    try {
      const [[, n]] = (await redis.multi().incr(key).expire(key, 120).exec()) as [[unknown, number]];
      count = n;
    } catch {
      return;
    }
    if (count > ANALYTICS_COMPUTES_PER_MINUTE) {
      throw tooManyComputes(Math.max(1, 60 - Math.floor((now() % 60_000) / 1000)));
    }
  };
}
