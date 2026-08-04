// @vitest-environment node
//
// NOTE: `pnpm test` in this package builds first (`tsc && vitest run`), because
// these cases bundle the built `dist/`. Turbo's `test` task depends on
// `^build` — dependencies, not this package — so under `turbo run test` the
// dist would be whatever a previous run left behind: green standalone,
// order-dependent in CI. `@rekey.dev/node` and `@rekey.dev/mcp` carry the same
// guard for the same reason.
//
// Node, not the package-wide jsdom: esbuild refuses to run under jsdom's
// TextEncoder (`new TextEncoder().encode("") instanceof Uint8Array` is false
// there). Nothing in this file touches the DOM anyway.

/**
 * Bundle-weight tests. These run a REAL bundler over the REAL `dist/`, because
 * the property under test is not observable from source.
 *
 * ── The bug ──
 *
 * `client.ts` value-imports `RekeyError`. That was imported from the
 * `@rekey.dev/shared-types` barrel, a module that evaluates ~60
 * `z.object(...)` calls at module scope. A bundler keeping the barrel for one
 * live export must keep those call expressions and therefore zod, so any app
 * touching `RekeyBrowserClient` — which is any app that signs a user in —
 * shipped zod it never asked for.
 *
 * ── The two fixes, and what each one actually buys ──
 *
 * Measured here, on this dist, with esbuild:
 *
 *   sideEffects | RekeyError from | `useUser` only | `RekeyBrowserClient` only
 *   ------------|-----------------|----------------|--------------------------
 *   absent      | barrel          | 77,655 (zod)   | 81,797 (zod)
 *   absent      | /error subpath  |    902         |  5,049
 *   false       | barrel          |    346         | 78,098 (zod)
 *   false       | /error subpath  |    346         |  4,397
 *
 * So they fix different things and both are needed. `"sideEffects": false`
 * lets a bundler drop an unused MODULE — that is what collapses the
 * `useUser`-only import, which never needed the client at all. It does nothing
 * for a bundle that genuinely uses the client, because you cannot drop a module
 * you are using: there, only splitting `RekeyError` out of the schema barrel
 * removes zod. (The review that found this reported `sideEffects` as worth
 * "0 bytes"; that holds for the client path, not for the hook path.)
 *
 * The thresholds below are deliberately loose. They are a tripwire for "zod
 * came back", not a byte budget.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, '..', 'dist', 'index.js');

async function bundle(source: string): Promise<{ bytes: number; text: string }> {
  const result = await esbuild.build({
    stdin: {
      contents: source,
      resolveDir: path.dirname(distEntry),
      sourcefile: 'entry.js',
      loader: 'js',
    },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const out = result.outputFiles[0]!;
  return { bytes: out.contents.length, text: out.text };
}

/** zod leaves these identifiers in minified output; its own name does not survive. */
function containsZod(code: string): boolean {
  return /ZodObject|ZodString|ZodType|zod/.test(code);
}

const entry = JSON.stringify(distEntry);

describe('tree-shaking the published bundle', () => {
  beforeAll(() => {
    if (!existsSync(distEntry)) {
      throw new Error(
        'dist/ is missing — run `pnpm --filter @rekey.dev/react build` first. ' +
          'These tests bundle the built output, because the weight of an import ' +
          'is not visible from source.',
      );
    }
  });

  it('ships no zod when only a hook is imported', async () => {
    const { bytes, text } = await bundle(
      `import { useUser } from ${entry};\nconsole.log(useUser);`,
    );
    expect(containsZod(text)).toBe(false);
    expect(bytes).toBeLessThan(5_000);
  });

  it('ships no zod when the browser client is imported — the case that regressed', async () => {
    const { bytes, text } = await bundle(
      `import { RekeyBrowserClient } from ${entry};\nconsole.log(RekeyBrowserClient);`,
    );
    expect(containsZod(text)).toBe(false);
    // Measured 4,397 B. Was 78,098 B with zod.
    expect(bytes).toBeLessThan(20_000);
  });

  it('ships no zod even when the whole barrel is imported', async () => {
    const { bytes, text } = await bundle(`import * as all from ${entry};\nconsole.log(all);`);
    expect(containsZod(text)).toBe(false);
    // Measured 37,248 B — every component and the client. Was 111,028 B.
    expect(bytes).toBeLessThan(60_000);
  });

  it('imports RekeyError from the zod-free subpath, not the schema barrel', async () => {
    // The assertion above is the real contract; this one names the cause, so a
    // failure points at the line to fix rather than at a byte count.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(path.resolve(here, '..', 'src', 'client.ts'), 'utf8');
    const valueImport = src.match(/^import \{ RekeyError \} from '([^']+)';$/m);
    expect(valueImport?.[1]).toBe('@rekey.dev/shared-types/error');
  });
});
