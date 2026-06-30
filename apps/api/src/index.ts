import { buildApp } from './app.js';
import { env } from './config/env.js';
import { registerGracefulShutdown } from './lib/shutdown.js';
import { primeSigningKeys } from './lib/signing-keys.js';

async function main(): Promise<void> {
  const app = await buildApp();
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
