/**
 * Vitest setup for the @rekey.dev/react component suite.
 *
 * jsdom is the DOM, @testing-library/react drives rendering. We auto-clean the
 * DOM (and the once-per-document injected <style id="rekey-react-styles">)
 * between tests so every case starts from a blank document.
 */

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  // setupFiles run for EVERY test file, including the few that opt out of jsdom
  // with `// @vitest-environment node` (bundle-size.test.ts has to: esbuild
  // will not run under jsdom's TextEncoder). There is nothing to clean there.
  if (typeof document === 'undefined') return;

  cleanup();
  // The theme module injects its stylesheet exactly once per document (guarded
  // by id). Remove it so the "injects styles" assertions are independent.
  document.getElementById('rekey-react-styles')?.remove();
});
