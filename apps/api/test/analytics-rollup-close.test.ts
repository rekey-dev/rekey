/**
 * A rollup started by a reporting-timezone change is not awaited by the
 * request. Closing the app waits for it, so it is never abandoned inside its
 * read transaction, where it would hold locks until the transaction timed out
 * and stall whatever touched those tables next.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { __setTriggeredRollupForTests, triggeredRollupsSettled } from '../src/modules/analytics/rollup/trigger.js';
import { bearer, operatorWorld } from './operator-world.js';

describe('closing the app with a triggered rollup in flight', () => {
  afterEach(() => __setTriggeredRollupForTests());

  it('waits for the rollup a timezone change started', async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const w = await operatorWorld(app);
    let finished = 0;
    __setTriggeredRollupForTests(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      finished += 1;
    });

    const res = await w.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${w.appId}/settings`,
      headers: bearer(w.ownerToken),
      payload: { reportingTimezone: 'Asia/Kolkata' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(finished).toBe(0);

    await app.close();
    expect(finished).toBe(1);
  });

  it('resolves at once when nothing is running', async () => {
    await expect(triggeredRollupsSettled()).resolves.toBeUndefined();
  });
});
