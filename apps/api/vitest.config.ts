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
  },
});
