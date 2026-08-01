import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Tests share one Postgres database. Truncating in beforeEach is fine
    // for our scale; running serially keeps that truncation predictable.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['./test/setup.ts'],
    // Operator OAuth credentials for the tenant-oauth tests. Set here so they
    // land in process.env before config/env.ts is first imported (t3-env parses
    // once). Fake values — the tests inject a mock provider via the registry.
    env: {
      PANEL_OAUTH_GOOGLE_CLIENT_ID: 'test-google-client-id',
      PANEL_OAUTH_GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      PANEL_OAUTH_GITHUB_CLIENT_ID: 'test-github-client-id',
      PANEL_OAUTH_GITHUB_CLIENT_SECRET: 'test-github-client-secret',
      PANEL_OAUTH_REDIRECT_BASE: 'https://panel.test.local',
    },
    // Migrations run once before any test file. Slow on cold start; cheap
    // afterwards because globalSetup is one-shot per worker.
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,

    // Coverage is opt-in (`pnpm test:coverage`), never on by default: the v8
    // provider adds ~15% to a run that is already the slowest job in CI, and
    // the number is only interesting when someone is looking at it.
    //
    // The thresholds are a RATCHET, not a target. They sit a couple of points
    // under whatever the suite currently reaches, so they catch a PR that
    // deletes coverage without failing on the day they land — a threshold that
    // is red on arrival is a threshold that gets deleted. Raise them when the
    // real number moves up; never lower them to make a build pass.
    coverage: {
      provider: 'v8',
      // text-summary for the CI log, json-summary for the step summary, lcov
      // for anything that wants to render annotations later.
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // Boot/wiring with no branches worth asserting: index.ts starts the
        // server (never imported by a test), config/env.ts is a schema parsed
        // once at import, and the generated OpenAPI dump is documentation.
        'src/index.ts',
        'src/config/env.ts',
        'src/lib/swagger.ts',
      ],
      // Measured 2026-08-01 at 105 files / 1116 tests:
      //   statements 83.07%  branches 78.94%  functions 90.05%  lines 83.07%
      // Each floor sits ~3-5 points under that.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 85,
        branches: 75,
      },
    },
  },
});
