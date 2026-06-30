/**
 * Graceful shutdown (registerGracefulShutdown).
 *
 * The request-log feature flushes its in-memory buffer in a Fastify `onClose`
 * hook so the last batch survives a deploy/restart. That hook only runs if
 * something calls `app.close()` — Node does NOT do this on SIGTERM by default.
 * `registerGracefulShutdown` is the missing trigger.
 *
 * These tests drive the shutdown path directly (via the function it returns)
 * rather than emitting a real signal, and inject `onShutdownComplete` so the
 * test runner is never `process.exit()`-ed out from under vitest.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { recordApiRequest, flushApiRequestLogs } from '../src/lib/request-log.js';
import { registerGracefulShutdown } from '../src/lib/shutdown.js';

/**
 * Strip any process signal listeners registered by a test so they don't leak
 * into sibling test files (vitest runs this whole suite in one fork).
 */
function clearSignalListeners(): void {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
}

describe('registerGracefulShutdown', () => {
  afterEach(() => {
    clearSignalListeners();
  });

  it('flushes the buffered request-log batch on shutdown (no data loss)', async () => {
    // Drain anything left in the shared buffer from earlier work so this test
    // owns exactly the rows it enqueues.
    await flushApiRequestLogs();

    const app = await buildApp({ logger: false });
    await app.ready();

    const appId = `shutdown-flush-${Date.now()}`;
    // Enqueue a row WITHOUT flushing — it lives only in the in-memory buffer,
    // exactly the state the process would be in when a SIGTERM lands.
    recordApiRequest({
      method: 'GET',
      routePath: '/api/v1/shutdown-probe',
      statusCode: 200,
      durationMs: 1,
      applicationId: appId,
    });

    // Precondition: nothing persisted yet — the row is buffer-only.
    expect(
      await prisma.apiRequestLog.count({ where: { applicationId: appId } }),
    ).toBe(0);

    // Drive the graceful-shutdown path. Inject onShutdownComplete so we don't
    // call process.exit(); this runs app.close() → the onClose flush hook.
    const onShutdownComplete = vi.fn();
    const shutdown = registerGracefulShutdown(app, { onShutdownComplete });
    await shutdown('SIGTERM');

    // The buffered row must have been flushed by the onClose hook.
    expect(
      await prisma.apiRequestLog.count({ where: { applicationId: appId } }),
    ).toBe(1);
    expect(onShutdownComplete).toHaveBeenCalledOnce();
    expect(onShutdownComplete).toHaveBeenCalledWith('SIGTERM');
  });

  it('is idempotent — a second shutdown call is a no-op', async () => {
    const app = await buildApp({ logger: false });
    await app.ready();

    const onShutdownComplete = vi.fn();
    const shutdown = registerGracefulShutdown(app, { onShutdownComplete });

    await shutdown('SIGTERM');
    // Second invocation (e.g. SIGINT after SIGTERM, or a repeated signal) must
    // not re-run app.close() — which would reject on an already-closed app.
    await expect(shutdown('SIGINT')).resolves.toBeUndefined();
    expect(onShutdownComplete).toHaveBeenCalledOnce();
  });

  it('registers SIGTERM and SIGINT process listeners', async () => {
    const app = await buildApp({ logger: false });
    await app.ready();

    const before = {
      term: process.listenerCount('SIGTERM'),
      int: process.listenerCount('SIGINT'),
    };
    registerGracefulShutdown(app);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);

    // Close the app directly (we didn't trigger shutdown) so the fork doesn't
    // leak an open server between tests.
    await app.close();
  });
});
