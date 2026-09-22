/**
 * Count the SQL statements Prisma sends while `fn` runs.
 *
 * `lib/prisma.ts` builds the client with query events under NODE_ENV=test; this
 * subscribes once and records only inside a `countQueries` window. BEGIN,
 * COMMIT and the fire-and-forget request-log / security-event inserts are
 * reported but not counted: the first two are transaction framing, the last
 * two are written off the request path and can land in any window.
 *
 * The webhook delivery CLAIM is not counted either. It is the first statement
 * of `attemptDelivery`, which only the delivery scheduler, the BullMQ worker
 * and the retry poller ever call, never a request handler, so no request's
 * cost includes it. It used to reach windows from other files: the test
 * scheduler's retry timers outlived their app, and a 30s retry scheduled by
 * credit-events.test.ts fired inside self-read-surface.test.ts's count. Those
 * timers are now stopped on app close and before every test
 * (`stopScheduledDeliveries`), which is the actual fix. What can still land in
 * a window is an attempt the window's own request kicked off by emitting an
 * event: background delivery work, not the request's statements. Only the
 * claim is matched (a SET of `next_attempt_at` alone, guarded on `status`),
 * so a request-path statement such as the operator retry's reset, which SETs
 * `status`, is still counted.
 */

import { prisma } from '../src/lib/prisma.js';

interface QueryEvent {
  query: string;
}

let recording: string[] | null = null;
let subscribed = false;
/** When the last `query` event arrived, counted or not. */
let lastEventAt = 0;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  (prisma as unknown as { $on(e: 'query', cb: (e: QueryEvent) => void): void }).$on(
    'query',
    (e) => {
      lastEventAt = Date.now();
      recording?.push(e.query);
    },
  );
}

const NOT_COUNTED = [
  /^(BEGIN|COMMIT|ROLLBACK)\b/i,
  /INSERT INTO "public"\."api_request_logs"/i,
  /INSERT INTO "public"\."security_events"/i,
  /^UPDATE "public"\."webhook_deliveries" SET "next_attempt_at" = \$1, "updated_at" = \$2 WHERE .*"webhook_deliveries"\."status" = CAST/i,
];

export interface QueryCount {
  count: number;
  queries: string[];
}

const QUIET_MS = 150;
const SETTLE_LIMIT_MS = 2000;

/**
 * Wait until no `query` event has arrived for QUIET_MS.
 *
 * Prisma delivers query events after the statement, and on a loaded runner
 * (CI with coverage) later than on a laptop. A fixed 20ms drain after `fn`
 * was not enough there: the previous request's last events landed inside the
 * NEXT window, which then counted six statements for a four-statement request
 * (and the window they left counted too few). Settling on BOTH sides keeps
 * each window to its own request's statements, however slow delivery is, as
 * long as it is slower than nothing for QUIET_MS.
 *
 * QUIET_MS was 50 and still wasn't a safe margin: `lastEventAt` is bumped by
 * every `query` event whether or not a window is recording, and the loop
 * below only waits until `Date.now() - lastEventAt >= QUIET_MS`. When a
 * window's own trailing event (its last query) lands more than QUIET_MS after
 * the one before it, this returns "quiet" one poll tick early, `recording` is
 * nulled out, and that trailing event is dropped outright (undercounting its
 * own window) or, if a later window has since opened, attributed there
 * instead (overcounting that one). Reproduced 2026-09-22 by injecting 30-90ms
 * of jitter into the `$on` callback above, standing in for the delay a loaded
 * CI runner already adds on its own: this traced exactly to
 * apps/api/test/self-read-surface.test.ts's "skips the credit balance read"
 * case, where the count came up one short because the request's own
 * `api_keys` lookup landed outside its window. 150ms keeps the fast-path
 * settle cost small (most windows still resolve near-instantly) while
 * absorbing several times the jitter that reproduced the drop, well inside
 * SETTLE_LIMIT_MS's 2s ceiling for a genuinely stuck window.
 */
async function settle(): Promise<void> {
  const started = Date.now();
  await new Promise((r) => setTimeout(r, QUIET_MS));
  while (Date.now() - lastEventAt < QUIET_MS && Date.now() - started < SETTLE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function countQueries(fn: () => Promise<unknown>): Promise<QueryCount> {
  subscribe();
  const log: string[] = [];
  // Statements from whatever ran before must report before the window opens.
  await settle();
  recording = log;
  try {
    await fn();
    // And this request's statements must report before it closes.
    await settle();
  } finally {
    recording = null;
  }
  const counted = log.filter((q) => !NOT_COUNTED.some((re) => re.test(q)));
  return { count: counted.length, queries: counted };
}
