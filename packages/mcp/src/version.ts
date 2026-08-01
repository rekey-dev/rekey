import { createRequire } from 'node:module';

/**
 * The published version of this package, reported in the MCP `initialize`
 * handshake.
 *
 * Read from `package.json` at runtime rather than kept as a literal. The
 * literal it replaces said `0.0.0` for the whole 1.x line, so every client
 * that logged or gated on the server version saw a number that had never been
 * released.
 *
 * `createRequire` rather than an `import ... with { type: 'json' }`: the
 * manifest sits above `rootDir`, so a static import would not compile, and
 * this file resolves it relative to the emitted `dist/` instead. npm always
 * ships `package.json` in the tarball, so it is there in an installed copy.
 */
export const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    // A missing version must not stop the server from serving tools.
    return 'unknown';
  }
})();
