import { createRequire } from 'node:module';

/**
 * The published version of this package.
 *
 * Read from `package.json` at runtime rather than kept as a literal, because a
 * literal is a second place to remember on every release — and it was already
 * forgotten: `rekey version` reported `0.0.0` for the whole 1.x line.
 *
 * `createRequire` rather than an `import ... with { type: 'json' }`: the
 * manifest sits above `rootDir`, so a static import would not compile, and
 * this file resolves it relative to the emitted `dist/lib/` instead. npm always
 * ships `package.json` in the tarball, so it is there in an installed copy.
 */
export const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    // Printing a version is never worth crashing a CLI over.
    return 'unknown';
  }
})();
