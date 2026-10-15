/**
 * The Application's billing config has more than one writer: the config
 * patch and the reporting currency. Run together, neither may write back a
 * copy of the config it read before the other committed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { bearer, operatorWorld } from './operator-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const ROUNDS = [
  { reportingCurrency: 'EUR', dunningEnabled: true },
  { reportingCurrency: 'INR', dunningEnabled: false },
  { reportingCurrency: 'GBP', dunningEnabled: true },
  { reportingCurrency: 'JPY', dunningEnabled: false },
  { reportingCurrency: 'CAD', dunningEnabled: true },
];

describe('concurrent writers of the billing config', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('eight racers, four setting the reporting currency and four patching another key: both changes survive', async () => {
    const w = await operatorWorld(app, 'APP_ADMIN');
    const base = `/api/v1/tenant/applications/${w.appId}`;
    const call = (method: string, path: string, payload?: Record<string, unknown>) =>
      w.inject({ method, url: `${base}${path}`, headers: bearer(w.ownerToken), ...(payload !== undefined && { payload }) });

    for (const round of ROUNDS) {
      const racers = Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0
          ? call('PUT', '/billing/reporting-currency', { reportingCurrency: round.reportingCurrency })
          : call('PATCH', '/billing-config', { dunningEnabled: round.dunningEnabled }),
      );
      for (const res of await Promise.all(racers)) expect(res.statusCode, res.body).toBe(200);

      const currency = await call('GET', '/billing/reporting-currency');
      expect((currency.json().data as { reportingCurrency: string }).reportingCurrency, JSON.stringify(round)).toBe(round.reportingCurrency);
      const application = await call('GET', '');
      expect(
        (application.json().data as { billingConfig: { dunningEnabled: boolean; reportingCurrency: string } }).billingConfig,
        JSON.stringify(round),
      ).toMatchObject(round);
    }
  });
});
