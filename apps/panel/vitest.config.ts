import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Copied from the marketing app's vitest config — see the notes there. Node
// environment, no CSS pipeline, `server-only` stubbed, `@/` mapped to src/.
//
// `.tsx` is included in the glob's sibling resolution because two of the units
// under test (`StatusPill`'s tone/label maps) live in a component file; the
// tests themselves stay `.ts` and never render.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    css: false,
  },
  // The app builds with the automatic JSX runtime (no `import React` in
  // components). esbuild defaults to the classic transform, which would need
  // React in scope — so a component imported by a test throws
  // "React is not defined" from its first JSX line.
  esbuild: { jsx: 'automatic' },
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./test/stubs/server-only.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
