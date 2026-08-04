/**
 * Per-file test setup.
 *
 * Truncates the domain tables before each test so individual cases stay
 * isolated. We use `TRUNCATE ... RESTART IDENTITY CASCADE` to also reset
 * sequences and follow FK chains — slightly heavier than per-table DELETE
 * but a lot less code than carefully ordering deletes.
 *
 * Postgres is not the only store holding per-test state, and the second one is
 * NOT Redis. Under `NODE_ENV=test` `getRedis()` returns null by design, so
 * brute-force counters, OIDC discovery documents, signing keys, the
 * request-log buffer and the outage-event window all live in plain
 * module-level variables that no TRUNCATE reaches. Nothing reset them, so each
 * one leaked into every later test that shared its module instance. Each now
 * exports a `__resetForTests`, and `resetProcessGlobalState` below calls all of
 * them from `beforeEach`.
 *
 * This replaced a `clearRedisTestState()` that SCANned Redis for `bf:*` keys.
 * It could never have worked: it opened with `const redis = getRedis(); if
 * (!redis) return;`, and in test that is always null. It deleted zero keys on
 * all 950 invocations while its docblock described fixing exactly the leak
 * that was in fact still happening, in memory, one module over.
 *
 * It also installs the FAKE billing providers. The shipped factory only ever
 * returns real, network-talking providers and throws when an Application has
 * no credentials — deliberately, see `providers/index.ts`. Tests must not
 * reach api.stripe.com, so the seam is here in test-land rather than a
 * `NODE_ENV === 'test'` branch in the product. `pickProvider` and
 * `countryFromRequest` keep their real implementations: routing logic is
 * under test, the network call is not.
 */

import { afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { fakeProviderFor } from './fakes/billing-providers.js';
// The table list, the module-singleton resets and the deadlock-retrying
// TRUNCATE live in their own module: `test-providers/setup.ts` needs the same
// three and MUST NOT import this file, whose module scope installs the fake
// providers above. See the header of `domain-tables.ts`.
import { resetProcessGlobalState, truncateDomainTables } from './domain-tables.js';

vi.mock('../src/modules/billing/providers/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/billing/providers/index.js')>();
  return {
    ...actual,
    // A `vi.fn`, not a bare arrow: tests need to assert on the call log —
    // "plan creation did not ask for a provider" is only checkable that way,
    // and a mock that silently answers is exactly how the Stripe-required
    // regression stayed invisible.
    getProviderForApplication: vi.fn(async (_application: unknown, provider: string) =>
      fakeProviderFor(provider),
    ),
  };
});

beforeEach(async () => {
  // Globals first: dropping the request-log buffer removes the in-flight
  // INSERT that the TRUNCATE's deadlock retry exists to survive.
  await resetProcessGlobalState();
  await truncateDomainTables((sql) => prisma.$executeRawUnsafe(sql));
});

afterAll(async () => {
  await prisma.$disconnect();
});
