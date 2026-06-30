/**
 * Server-only ReliPay client (same lazy-singleton pattern as
 * examples/nextjs-saas/src/lib/relipay.ts). Holds the Application SECRET key
 * — never import from a Client Component.
 *
 * Env validation is lazy (first call), not module-eval — `next build`
 * imports server modules during page-data collection for routes that never
 * call the SDK, and a top-level throw would fail the build when env isn't
 * set.
 */

import 'server-only';
import { ReliPay, RelipayError } from '@relipay/node';
import { requireEnv } from './env';

let cached: ReliPay | undefined;

export function getRelipay(): ReliPay {
  if (!cached) {
    cached = new ReliPay({
      apiUrl: requireEnv('RELIPAY_URL'),
      secretKey: requireEnv('RELIPAY_SECRET_KEY'),
    });
  }
  return cached;
}

/** Lazy proxy so `import { relipay }` works without eager env validation. */
export const relipay = new Proxy({} as ReliPay, {
  get(_target, prop, receiver) {
    return Reflect.get(getRelipay(), prop, receiver);
  },
}) as ReliPay;

export { RelipayError };
