/**
 * Per-route rate-limit config for auth endpoints.
 *
 * The global limiter (app.ts) is a loose 100/min backstop for the whole API.
 * Credential- and code-guessing endpoints (sign-in, MFA verify) get a much
 * tighter cap layered on top via each route's `config.rateLimit`.
 *
 * **Disabled under NODE_ENV=test.** The in-process test suite fires many
 * requests from a single IP (127.0.0.1) within one run, so a real per-route cap
 * would trip the suite against itself. We raise the cap to effectively-infinite
 * in test; production keeps the tight limit.
 */
export function authRateLimit(maxPerMinute: number): { max: number; timeWindow: string } {
  const isTest = process.env.NODE_ENV === 'test';
  return { max: isTest ? 1_000_000 : maxPerMinute, timeWindow: '1 minute' };
}
