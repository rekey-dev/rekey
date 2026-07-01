import { buildApp } from './app.js';
import { env } from './config/env.js';
import { registerGracefulShutdown } from './lib/shutdown.js';
import { primeSigningKeys } from './lib/signing-keys.js';

async function main(): Promise<void> {
  // buildApp fails closed on missing infrastructure — notably it starts the
  // BullMQ webhook worker, which throws if Redis is unreachable (Redis is
  // required; there is no in-process scheduling fallback). Catch here so the
  // operator sees a clear reason and a non-zero exit, not an unhandled rejection.
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp();
  } catch (err) {
    // No app logger yet (failure during construction) — write to stderr.
    console.error('[relipay-api] failed to start:', (err as Error).message);
    process.exit(1);
  }
  // Warm (or first-generate) the RS256 signing key + JWKS snapshot so the
  // first RS256 sign-in / jwks.json request doesn't pay keygen or DB latency.
  // Best-effort: a failure here must not stop HS256-only deployments — the
  // lazy path in lib/signing-keys.ts retries on first use.
  try {
    await primeSigningKeys();
  } catch (err) {
    app.log.warn({ err }, 'RS256 signing-key warm-up failed (will retry lazily on first use)');
  }
  // Wire SIGTERM/SIGINT → app.close() (which runs the onClose hooks: final
  // request-log flush, Redis quit, interval clears) → prisma disconnect. Without
  // this, a deploy/restart signal kills the process before those hooks fire and
  // the last buffered request-log batch is lost.
  registerGracefulShutdown(app);
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`relipay-api listening on http://${env.HOST}:${env.PORT} — docs at /docs`);
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();
