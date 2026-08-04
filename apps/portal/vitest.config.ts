import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Copied from the marketing app's vitest config — the whole setup for testing a
// Next app's server-side glue is this file plus test/stubs/server-only.ts.
//
// Node environment, not jsdom: everything under test here is server-side.
//
// `css: false` + no PostCSS: vitest otherwise picks up the app's PostCSS config
// (Tailwind) and tries to load it outside the Next pipeline. Nothing under test
// imports a stylesheet.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    css: false,
  },
  css: { postcss: { plugins: [] } },
  resolve: {
    // `server-only` throws by design when loaded outside a React Server
    // Component, so it is stubbed rather than imported.
    // fileURLToPath, not URL.pathname: the repo path contains spaces and
    // pathname percent-encodes them, which resolves to a file that is not there.
    alias: {
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
