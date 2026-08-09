import type { Prisma, SecurityEvent } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';

/**
 * Wait for security events to land, instead of assuming they already have.
 *
 * `recordSecurityEvent` is called as `void recordSecurityEvent(...)` everywhere
 * — deliberately, so that writing an audit row can never block or fail the
 * request that triggered it (decisions.md, 2026-05-31). The row therefore lands
 * some time *after* the response the test just awaited.
 *
 * On a quiet machine the insert wins the race and a direct `findMany` passes,
 * which is why this reads as a stable test locally and fails in CI perhaps one
 * run in ten. It cost a red build on the rc.7 mirror sync: the credential was
 * stored and encrypted correctly, and the assertion that the audit row existed
 * ran before the row did.
 *
 * Polling rather than a fixed sleep, so the common case stays fast.
 *
 * This is only for asserting events **are** written. A test asserting that
 * nothing was recorded has the opposite problem — there is no moment at which
 * "still absent" becomes conclusive — and polling cannot fix it.
 */
export async function waitForSecurityEvents(
  where: Prisma.SecurityEventWhereInput,
  { atLeast = 1, timeoutMs = 5000 }: { atLeast?: number; timeoutMs?: number } = {},
): Promise<SecurityEvent[]> {
  const deadline = Date.now() + timeoutMs;
  let events: SecurityEvent[] = [];

  for (;;) {
    events = await prisma.securityEvent.findMany({ where });
    if (events.length >= atLeast) return events;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForSecurityEvents: expected at least ${atLeast} event(s) matching ` +
          `${JSON.stringify(where)} within ${timeoutMs}ms, found ${events.length}. ` +
          'If the write genuinely never happens this is a real failure, not a race.',
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
