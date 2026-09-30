/**
 * A per-process cap on concurrent dashboard computations.
 *
 * Dashboard aggregates scan the largest tables. Each one holds a pool
 * connection for up to its statement budget, so without a cap a burst of cold
 * dashboards could take most of the pool and starve sign-ins and webhooks.
 * A caller that cannot start within `waitMs` gets the `busy` error instead of
 * queueing behind the pool.
 */

import { RekeyError } from './error.js';

export interface Semaphore {
  /**
   * Run `work` once a slot is free, or throw the `busy` error after `waitMs`.
   *
   * @example
   *   const stats = await dashboardSlots.run(() => computeStats(id));
   */
  run<T>(work: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly waiting: number;
}

export interface SemaphoreOptions {
  max: number;
  waitMs: number;
  busy: () => RekeyError;
}

interface Waiter {
  start: () => void;
  timer: NodeJS.Timeout;
}

/**
 * @example
 *   const slots = createSemaphore({ max: 2, waitMs: 3000, busy: dashboardBusy });
 *   await slots.run(async () => 1);
 */
export function createSemaphore(options: SemaphoreOptions): Semaphore {
  let active = 0;
  const queue: Waiter[] = [];

  const release = (): void => {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.start();
      return;
    }
    active -= 1;
  };

  const acquire = (): Promise<void> => {
    if (active < options.max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: resolve,
        timer: setTimeout(() => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(options.busy());
        }, options.waitMs),
      };
      queue.push(waiter);
    });
  };

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

/** Seconds a client should wait before retrying a busy dashboard. */
export const DASHBOARD_RETRY_AFTER_SECONDS = 5;

/**
 * The 503 for a dashboard that could not start computing in time.
 *
 * @example
 *   throw dashboardBusy();
 */
export function dashboardBusy(): RekeyError {
  return new RekeyError({
    statusCode: 503,
    code: 'ANALYTICS_BUSY',
    message: 'Dashboard numbers are being computed for other requests and this one could not start in time.',
    fix: `Retry in ${DASHBOARD_RETRY_AFTER_SECONDS} seconds.`,
    retryAfterSeconds: DASHBOARD_RETRY_AFTER_SECONDS,
  });
}

/** At most this many dashboard computations run at once in one API process. */
export const DASHBOARD_MAX_CONCURRENT = 2;

/** The shared slots every dashboard computation runs in. */
export const dashboardSlots: Semaphore = createSemaphore({
  max: DASHBOARD_MAX_CONCURRENT,
  waitMs: 3_000,
  busy: dashboardBusy,
});
