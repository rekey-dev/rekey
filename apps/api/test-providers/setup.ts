/**
 * Per-file setup for the provider sandbox harness.
 *
 * Deliberately NOT `test/setup.ts`, and the difference is the entire point of
 * this suite: the default setup installs fake billing providers with
 *
 *     vi.mock('../src/modules/billing/providers/index.js', …)
 *
 * so nothing in the ordinary suite ever dials a payment processor. This one
 * installs no such mock. `getProviderForApplication` returns
 * `RealStripeProvider` / `RealPaypalProvider` / `RealRazorpayProvider` built
 * from the Application's stored BYO credentials, and those talk to the
 * provider's sandbox over the network.
 *
 * The truncation and the module-singleton resets are shared with the default
 * suite via `../test/domain-tables.js` — those are properties of the API, not
 * of the fakes, and a second copy of the table list is a second thing to
 * forget when a table is added. What it must NOT do is import `test/setup.ts`
 * itself: that file's module scope registers the fake-provider mock, and
 * pulling it in here would silently turn every real-provider test into a test
 * of the fakes.
 */

import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { resetProcessGlobalState, truncateDomainTables } from '../test/domain-tables.js';
import { installOutputScrubber } from './support/redact.js';
import { closeSandboxApp } from './support/fixture.js';

// First thing, before any credential is read: nothing may reach stdout or
// stderr unredacted, including a failing assertion's diff.
installOutputScrubber();

beforeEach(async () => {
  // Globals first: dropping the request-log buffer removes the in-flight
  // INSERT that the TRUNCATE's deadlock retry exists to survive.
  await resetProcessGlobalState();
  await truncateDomainTables((sql) => prisma.$executeRawUnsafe(sql));
});

afterAll(async () => {
  await closeSandboxApp();
  await prisma.$disconnect();
});
