/**
 * Graceful shutdown wiring for the standalone server.
 *
 * `buildApp()` registers `onClose` hooks that are load-bearing for a clean
 * stop — most importantly a final `flushApiRequestLogs()` so the last buffered
 * batch of request logs isn't lost on deploy/restart, plus the Redis `quit()`
 * and the flush/prune interval clears. Those hooks ONLY run if something calls
 * `app.close()`. Node does NOT do this on a process signal by default: an
 * unhandled SIGTERM (what an orchestrator sends on every deploy, scale-down or
 * restart) terminates the process immediately, so without an explicit handler
 * the onClose hooks never fire and the final batch is silently dropped.
 *
 * This registers SIGTERM/SIGINT handlers that:
 *   1. `app.close()` — stops accepting connections, drains in-flight requests,
 *      and runs every `onClose` hook (flush, Redis quit, interval clears).
 *   2. `prisma.$disconnect()` — releases pooled DB connections so we don't leak
 *      a server-side session for the duration of the linger.
 *
 * Idempotent: a second signal arriving mid-shutdown is ignored rather than
 * kicking off a second `app.close()` (which would reject). Best-effort: a hook
 * that throws is logged but never blocks exit — a stuck shutdown that hangs
 * past the orchestrator's grace period just gets SIGKILL'd, which is strictly
 * worse than exiting now.
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from './prisma.js';

/** Signals that should trigger a graceful stop. */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface RegisterGracefulShutdownOptions {
  /**
   * Called once shutdown has finished (after `app.close()` + Prisma disconnect).
   * Defaults to `process.exit(0)`. Injectable so tests can assert the sequence
   * without tearing down the test runner.
   */
  onShutdownComplete?: (signal: NodeJS.Signals) => void;
}

/**
 * Wire SIGTERM/SIGINT to a graceful `app.close()` + Prisma disconnect.
 *
 * Returns the shutdown function so callers (and tests) can trigger the same
 * path without sending a real signal. The returned function is safe to call
 * repeatedly — only the first invocation does work.
 */
export function registerGracefulShutdown(
  app: FastifyInstance,
  options: RegisterGracefulShutdownOptions = {},
): (signal: NodeJS.Signals) => Promise<void> {
  const onShutdownComplete =
    options.onShutdownComplete ??
    (() => {
      process.exit(0);
    });

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, 'shutting down — draining requests and flushing buffers');

    // app.close() runs every onClose hook (request-log flush, Redis quit,
    // interval clears) and waits for in-flight requests to finish.
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, 'error during app.close() on shutdown');
    }

    // Release pooled DB connections. Separate try so a flaky disconnect can't
    // strand the process; it would otherwise hang until the orchestrator
    // SIGKILLs us, which also skips this cleanup.
    try {
      await prisma.$disconnect();
    } catch (err) {
      app.log.error({ err }, 'error disconnecting prisma on shutdown');
    }

    onShutdownComplete(signal);
  }

  for (const signal of SHUTDOWN_SIGNALS) {
    // `process.once` so a repeated signal of the SAME type doesn't stack a
    // second handler; the `shuttingDown` guard covers cross-signal repeats.
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  return shutdown;
}
