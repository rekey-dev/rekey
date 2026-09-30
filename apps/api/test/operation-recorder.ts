/**
 * Record the Prisma operations one piece of work issues, and nothing else.
 *
 * `countQueries` listens to Prisma's `query` event, which carries no caller:
 * every statement on the shared client lands in whatever window is open,
 * including a detached email log insert from an earlier request, a health
 * probe, and the `SELECT 1` Prisma's pool sends on checking out a connection
 * that sat idle for about 15 seconds. This records through a Prisma middleware
 * instead, and keeps an operation only when it was issued inside `fn`'s async
 * context, so concurrent work from anywhere else is invisible.
 *
 * An operation is `Model.action` plus the shape of its arguments (keys kept,
 * values replaced by `?`), which is what decides the SQL Prisma generates.
 * Writes the request detaches on purpose (request log, security events) are
 * dropped for the same reason `countQueries` drops them: they can settle after
 * the window closes. Anything else still in flight when `fn` settles is
 * dropped too, so a window never grows after it is read.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';

interface Window {
  open: boolean;
  operations: string[];
}

const DETACHED_MODELS = new Set(['ApiRequestLog', 'SecurityEvent']);

// One store and one middleware per process: the suite runs every file in one
// fork against the same client, and a middleware can never be removed.
const GLOBAL_KEY = Symbol.for('rekey.test.operationRecorder');
type Global = typeof globalThis & { [GLOBAL_KEY]?: AsyncLocalStorage<Window> };

function store(): AsyncLocalStorage<Window> {
  const g = globalThis as Global;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY];
  const als = new AsyncLocalStorage<Window>();
  g[GLOBAL_KEY] = als;
  (prisma as unknown as { $use(mw: Prisma.Middleware): void }).$use(async (params, next) => {
    const window = als.getStore();
    if (window?.open && !(params.model && DETACHED_MODELS.has(params.model))) {
      window.operations.push(`${params.model ?? '$raw'}.${params.action} ${shape(params.args)}`);
    }
    return next(params);
  });
  return als;
}

function shape(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(shape).join(',')}]`;
  if (value === null || typeof value !== 'object' || value instanceof Date) return '?';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${k}:${shape(v)}`).join(',')}}`;
}

/**
 * Run `fn` and return the Prisma operations issued inside it, in the order
 * they were issued.
 *
 * @example
 * const ops = await recordOperations(() => app.inject({ method: 'GET', url: '/api/v1/billing/entitlements' }));
 * expect(ops.filter((o) => o.startsWith('CreditBalance.'))).toHaveLength(1);
 */
export async function recordOperations(fn: () => Promise<unknown>): Promise<string[]> {
  const window: Window = { open: true, operations: [] };
  try {
    // Awaited inside the context: a Prisma query and `app.inject` are both
    // lazy, and start on `then`, not when they are created.
    await store().run(window, async () => {
      await fn();
    });
  } finally {
    window.open = false;
  }
  return [...window.operations];
}
