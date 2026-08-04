/**
 * Tests that run against the BUILT `dist/` artifact, not the TypeScript source.
 *
 * Every other test in this package imports `../src/index.js`, which vitest
 * transpiles on the fly into an environment where CommonJS interop happens to
 * be available. That is not what consumers get. `verifyWebhookSignature` and
 * the RS256 path of `verifyAccessToken` both called a bare `require('node:crypto')`,
 * which is undefined in the ESM-only package we actually publish — so both threw
 * `ReferenceError: require is not defined` for every npm consumer, in every
 * released version, while the suite stayed green.
 *
 * The failure also does not reproduce under `node -e`, because inline eval
 * defines `globalThis.require`. It only appears in a real `.mjs` file or a
 * `"type": "module"` package — which is to say, only in real use.
 *
 * So these tests spawn a separate Node process and import the built file the
 * way a consumer does. Anything exercised here is a promise made to people who
 * install from npm.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const distEntry = path.resolve(pkgRoot, 'dist', 'index.js');
const distTypes = path.resolve(pkgRoot, 'dist', 'index.d.ts');

/** Run a snippet as real ESM, with the built entry importable by path. */
function runEsm(source: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run a snippet as real CommonJS, from inside the package directory so that
 * `require('@rekey.dev/node')` resolves by NAME through the package's own
 * `exports` map (Node's package self-reference). That matters: the resolver
 * only consults `exports` for bare specifiers, and CJS resolution runs with
 * conditions `["require","node"]` — the exact path that was broken.
 */
function runCjs(source: string): string {
  return execFileSync(process.execPath, ['--input-type=commonjs', '-e', source], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: pkgRoot,
  }).trim();
}

describe('the published ESM artifact', () => {
  beforeAll(() => {
    if (!existsSync(distEntry)) {
      throw new Error(
        `dist/ is missing — run \`pnpm --filter @rekey.dev/node build\` first. ` +
          `These tests deliberately exercise the built output, because the bug they ` +
          `guard against is invisible from source.`,
      );
    }
  });

  it('verifyWebhookSignature works when imported as ESM', () => {
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded' });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');

    const out = runEsm(`
      import { verifyWebhookSignature } from ${JSON.stringify(distEntry)};
      console.log(verifyWebhookSignature({
        header: ${JSON.stringify(`t=${t},v1=${v1}`)},
        payload: ${JSON.stringify(payload)},
        secret: ${JSON.stringify(secret)},
      }));
    `);

    expect(out).toBe('true');
  });

  it('rejects a tampered body from the built artifact', () => {
    const secret = 'whsec_test_secret';
    const payload = JSON.stringify({ amount: 100 });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');

    // A verifier that throws would also fail the assertion above, so this
    // pins that a genuine `false` comes back rather than an absent crypto call
    // silently short-circuiting.
    const out = runEsm(`
      import { verifyWebhookSignature } from ${JSON.stringify(distEntry)};
      console.log(verifyWebhookSignature({
        header: ${JSON.stringify(`t=${t},v1=${v1}`)},
        payload: ${JSON.stringify(JSON.stringify({ amount: 999_999 }))},
        secret: ${JSON.stringify(secret)},
      }));
    `);

    expect(out).toBe('false');
  });

  it('verifyAccessToken reaches its crypto path as ESM rather than throwing ReferenceError', () => {
    // A structurally-valid RS256 JWT with a signature that cannot verify. The
    // point is not the verdict — it is that the RS256 branch executes at all,
    // since that branch is the second place the bare `require` lived.
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString(
      'base64url',
    );
    const body = Buffer.from(JSON.stringify({ sub: 'u_1', exp: 9_999_999_999 })).toString(
      'base64url',
    );
    const token = `${header}.${body}.${Buffer.from('not-a-signature').toString('base64url')}`;

    const out = runEsm(`
      import { verifyAccessToken } from ${JSON.stringify(distEntry)};
      try {
        await verifyAccessToken(${JSON.stringify(token)}, { jwks: { keys: [] } });
        console.log('RESOLVED');
      } catch (e) {
        console.log(e instanceof ReferenceError ? 'REFERENCE_ERROR' : 'REJECTED');
      }
    `);

    expect(out).not.toBe('REFERENCE_ERROR');
  });

  it('exposes no bare `require(` call in the built output', () => {
    const out = runEsm(`
      import { readFileSync } from 'node:fs';
      const src = readFileSync(${JSON.stringify(distEntry)}, 'utf8');
      // createRequire(...)('x') is fine; a bare require('x') is not.
      const bare = src.match(/(^|[^.\\w])require\\s*\\(/g) ?? [];
      console.log(bare.length);
    `);

    expect(out).toBe('0');
  });
  it('has no static node: import at module scope — the edge-runtime contract', () => {
    // The client is documented as usable on edge runtimes for every
    // fetch-based method; only signature verification needs Node crypto, and
    // it loads that lazily. A STATIC `node:*` import at module scope breaks
    // `import` itself there, which is how rc.2 shipped a package that was
    // unimportable on edge: the crypto fix reached for `createRequire` and
    // pulled in `node:module` at the top of the file.
    const out = runEsm(`
      import { readFileSync } from 'node:fs';
      const src = readFileSync(${JSON.stringify(distEntry)}, 'utf8');
      // Strip comments first — the explanation of this very bug names the module.
      const code = src
        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')
        .replace(/^\\s*\\/\\/.*$/gm, '');
      const statics = code.match(/^\\s*import[^;]*from\\s*['"]node:[^'"]+['"]/gm) ?? [];
      console.log(statics.length === 0 ? 'none' : statics.join(' | '));
    `);

    expect(out).toBe('none');
  });
});

describe('the published CommonJS contract', () => {
  beforeAll(() => {
    if (!existsSync(distEntry)) {
      throw new Error('dist/ is missing — run `pnpm --filter @rekey.dev/node build` first.');
    }
  });

  // Node ≥22.12 can `require()` a synchronous ESM module, but only if the
  // resolver finds a target. CJS resolution walks the `exports` map with
  // conditions ["require","node"]; a map containing only `types` + `import`
  // matches neither, so every `require('@rekey.dev/node')` failed with
  // ERR_PACKAGE_PATH_NOT_EXPORTED — Jest-CJS, ts-node, and any CommonJS
  // consumer, on a package that otherwise works fine. The fix is a `default`
  // condition; no CJS build is involved, which is why this must be verified by
  // actually requiring rather than by reading the manifest.
  it('can be require()d by name', () => {
    const out = runCjs(`
      const m = require('@rekey.dev/node');
      console.log([typeof m.Rekey, typeof m.RekeyError, typeof m.verifyWebhookSignature].join(','));
    `);
    expect(out).toBe('function,function,function');
  });

  it('gives require() and import() the same RekeyError class', () => {
    // Two copies of the class would make `instanceof` silently false across
    // the boundary — the exact failure mode this package's error contract
    // depends on not having.
    const out = runCjs(`
      const cjs = require('@rekey.dev/node');
      import('@rekey.dev/node').then((esm) => {
        console.log(cjs.RekeyError === esm.RekeyError);
      });
    `);
    expect(out).toBe('true');
  });

  // The same defect shipped in all six published packages, so this checks all
  // six rather than only the one this suite lives in. A package whose exports
  // map omits `default` is unreachable from `require()` no matter what its
  // build produced, and that is invisible until a CJS consumer complains.
  it.each([
    'shared-types',
    'sdk-node',
    'sdk-react',
    'sdk-nextjs',
    'cli',
    'mcp',
  ])('packages/%s declares a `default` condition on every exports subpath', (dir) => {
    const manifest = path.resolve(pkgRoot, '..', dir, 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string;
      exports: Record<string, unknown>;
    };
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (typeof target === 'string') continue; // e.g. "./package.json"
      expect(
        target,
        `${pkg.name} exports["${subpath}"] has no "default" condition — CJS ` +
          `resolution runs with ["require","node"] and will not match "import".`,
      ).toHaveProperty('default');
    }
  });
});

describe('the published type surface', () => {
  // `stripInternal` is what keeps `@internal`-marked members out of the .d.ts.
  // Without it, a test hook and two positional transport methods were part of
  // the public API — and 2.0.0 would have frozen them there.
  it('does not publish the JWKS test hook', () => {
    expect(readFileSync(distTypes, 'utf8')).not.toContain('_clearJwksCacheForTests');
  });

  it('does not publish the internal positional transport methods', () => {
    const types = readFileSync(distTypes, 'utf8');
    expect(types).not.toMatch(/^\s*send<T>/m);
    expect(types).not.toMatch(/^\s*requestRaw<T>/m);
  });

  it('publishes `request` as a supported options-object escape hatch', () => {
    // Deliberately kept, deliberately NOT positional: this is the shape a
    // consumer reaches for when an endpoint is not wrapped yet, and adding a
    // knob to it later must not need a new overload.
    const types = readFileSync(distTypes, 'utf8');
    expect(types).toContain('request<T>(method: string, path: string, options?: RekeyRequestOptions)');
    expect(types).toContain('interface RekeyRequestOptions');
  });
});
