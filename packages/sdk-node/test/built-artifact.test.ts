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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(here, '..', 'dist', 'index.js');

/** Run a snippet as real ESM, with the built entry importable by path. */
function runEsm(source: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
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
});
