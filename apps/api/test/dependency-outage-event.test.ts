/**
 * A dependency outage must leave a durable, operator-visible trail.
 *
 * With credential paths failing closed, a Redis outage now surfaces to end users
 * as 503s on sign-in. The log line alone is not enough: an operator looking at the
 * panel needs to see WHEN it started. So the error handler records one
 * `system.dependency_unavailable` event per (subsystem, tenant) per window.
 *
 * The throttle is the load-bearing part. An outage hits every request, so an
 * unthrottled write would flood the very log the operator opens to explain it.
 */

import { describe, expect, it } from 'vitest';
import { shouldRecordOutageEvent } from '../src/lib/dependency-outage.js';

describe('outage-event throttle', () => {
  it('records the first occurrence for a (subsystem, tenant) pair', () => {
    expect(shouldRecordOutageEvent('redis', 'tenant-a')).toBe(true);
  });

  it('suppresses repeats inside the window — an outage hits every request', () => {
    shouldRecordOutageEvent('redis', 'tenant-throttle');
    expect(shouldRecordOutageEvent('redis', 'tenant-throttle')).toBe(false);
    expect(shouldRecordOutageEvent('redis', 'tenant-throttle')).toBe(false);
  });

  it('keys on the tenant, so one workspace does not mask another', () => {
    shouldRecordOutageEvent('redis', 'tenant-one');
    expect(shouldRecordOutageEvent('redis', 'tenant-two')).toBe(true);
  });

  it('keys on the subsystem, so Postgres is not masked by Redis', () => {
    shouldRecordOutageEvent('redis', 'tenant-both');
    expect(shouldRecordOutageEvent('postgres', 'tenant-both')).toBe(true);
  });

  it('handles an unauthenticated request, where there is no tenant', () => {
    expect(shouldRecordOutageEvent('postgres', null)).toBe(true);
    expect(shouldRecordOutageEvent('postgres', null)).toBe(false);
  });
});
