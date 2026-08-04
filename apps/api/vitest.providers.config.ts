import { defineConfig } from 'vitest/config';

/**
 * The provider sandbox harness — a SEPARATE vitest project, deliberately not
 * part of `pnpm test`.
 *
 * Everything under `test-providers/` makes real network calls to a payment
 * provider's sandbox. Folding that into the default suite would trade the one
 * property the default suite has to keep — that it is fast and that a red run
 * means the code is wrong — for coverage that only exists on machines holding
 * credentials. So: its own config, its own setup (no fake providers), its own
 * database, and its own script (`pnpm test:providers`).
 *
 * Nothing here reads `TEST_DATABASE_URL`; see `test-providers/global-setup.ts`
 * for why the two suites must not share a database.
 */
export default defineConfig({
  test: {
    include: ['test-providers/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // One process, one database, truncation between tests — the same reason
    // the default suite is serial, plus a second: a shared provider sandbox
    // has account-wide rate limits and an account-wide event feed that the
    // suites page through.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['./test-providers/setup.ts'],
    globalSetup: ['./test-providers/global-setup.ts'],
    // Generous, and it has to be: a test that advances a Stripe test clock
    // waits on Stripe to re-run a billing cycle, and event publication trails
    // the API call that caused it. These are not units.
    testTimeout: 180_000,
    hookTimeout: 240_000,
    // Sequential within a file too. Tests share one provider account and one
    // truncated database; overlapping them makes the account-wide event feed
    // ambiguous.
    sequence: { concurrent: false },
    // No coverage. The default suite owns the coverage ratchet; measuring it
    // from a run that skips most of itself without credentials would report a
    // number that means nothing.
    coverage: { enabled: false },
  },
});
