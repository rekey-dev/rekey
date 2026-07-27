/**
 * Server-only Rekey wiring.
 *
 * This module is the single place the *server* SDK (`@rekey.dev/node`) is
 * constructed. It holds the Application SECRET key — so it must never be
 * imported from a Client Component. (Next will refuse to bundle it to the
 * browser because it touches `process.env.RELIPAY_SECRET`, but keeping all
 * secret-key calls behind server actions / route handlers is the discipline.)
 *
 * The `@rekey.dev/nextjs/server` helpers (`auth`, `signIn`, `signUp`, `signOut`)
 * build their OWN internal client from the same env vars — we reuse those for
 * the auth + cookie-session lifecycle. This `rekey` client is for everything
 * else the Next helpers don't cover: billing, credits, usage, organizations,
 * sessions, password reset, license verify, application config.
 *
 *   RELIPAY_URL     — base URL of the Rekey API (e.g. https://api.relipay.dev)
 *   RELIPAY_SECRET  — Application secret key (rp_live_… / rp_test_…), server-only
 *
 * The env checks are LAZY (inside `getRelipay()`) rather than at module-eval
 * time. `next build` imports server modules during page-data collection even
 * for routes that never actually call the SDK (e.g. `/_not-found`); a
 * module-top-level throw turned that build phase into a hard failure when the
 * envs weren't set. The runtime check still fires the first time anything
 * touches the SDK, just from a request handler instead of from the bundler.
 */

import 'server-only';
import { Rekey, RekeyError } from '@rekey.dev/node';

function requireEnv(name: 'RELIPAY_URL' | 'RELIPAY_SECRET'): string {
  const value = process.env[name];
  if (!value) {
    const hint =
      name === 'RELIPAY_URL'
        ? 'copy .env.local.example to .env.local and set it.'
        : 'put the Application secret key in .env.local (never commit it).';
    throw new Error(`${name} is missing — ${hint}`);
  }
  return value;
}

let cached: Rekey | undefined;

/**
 * Lazily-constructed singleton. First call validates env + builds the client;
 * subsequent calls return the same instance. Throws if env is missing — but
 * only at call time, not at module import.
 */
export function getRelipay(): Rekey {
  if (!cached) {
    cached = new Rekey({
      apiUrl: requireEnv('RELIPAY_URL'),
      secretKey: requireEnv('RELIPAY_SECRET'),
    });
  }
  return cached;
}

/**
 * Compatibility export — `import { rekey } from '@/lib/relipay'` keeps
 * working. Wrapped in a Proxy so the validation still runs lazily; reading
 * any method delegates to the singleton's bound method.
 */
export const rekey = new Proxy({} as Rekey, {
  get(_target, prop, receiver) {
    return Reflect.get(getRelipay(), prop, receiver);
  },
}) as Rekey;

export { RekeyError };

/**
 * API URL — also handed to the browser provider (it's not a secret). Read
 * via a getter so importing this module doesn't require the env to be set
 * during `next build`.
 */
export function getRelipayUrl(): string {
  return requireEnv('RELIPAY_URL');
}

/**
 * @deprecated prefer `getRelipayUrl()` — module-level reads can be undefined
 * during build. Cast preserves the original `string` type contract; the value
 * is guaranteed non-empty at request time (consumers of the SDK throw via
 * `requireEnv()` before any request goes out).
 */
export const RELIPAY_URL = (process.env.RELIPAY_URL ?? '') as string;
