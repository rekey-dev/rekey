/**
 * Server-only Rekey client (same lazy-singleton pattern as
 * examples/nextjs-saas/src/lib/relipay.ts). Holds the Application SECRET key
 * — never import from a Client Component.
 *
 * Env validation is lazy (first call), not module-eval — `next build`
 * imports server modules during page-data collection for routes that never
 * call the SDK, and a top-level throw would fail the build when env isn't
 * set.
 */

import 'server-only';
import { Rekey, RekeyError } from '@rekey.dev/node';
import { requireEnv } from './env';

let cached: Rekey | undefined;

export function getRelipay(): Rekey {
  if (!cached) {
    cached = new Rekey({
      apiUrl: requireEnv('RELIPAY_URL'),
      secretKey: requireEnv('RELIPAY_SECRET_KEY'),
    });
  }
  return cached;
}

/** Lazy proxy so `import { rekey }` works without eager env validation. */
export const rekey = new Proxy({} as Rekey, {
  get(_target, prop, receiver) {
    return Reflect.get(getRelipay(), prop, receiver);
  },
}) as Rekey;

export { RekeyError };
