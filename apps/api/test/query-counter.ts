/**
 * Count the SQL statements Prisma sends while `fn` runs.
 *
 * `lib/prisma.ts` builds the client with query events under NODE_ENV=test; this
 * subscribes once and records only inside a `countQueries` window. BEGIN,
 * COMMIT and the fire-and-forget request-log / security-event inserts are
 * reported but not counted: the first two are transaction framing, the last
 * two are written off the request path and can land in any window.
 */

import { prisma } from '../src/lib/prisma.js';

interface QueryEvent {
  query: string;
}

let recording: string[] | null = null;
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  (prisma as unknown as { $on(e: 'query', cb: (e: QueryEvent) => void): void }).$on(
    'query',
    (e) => {
      recording?.push(e.query);
    },
  );
}

const NOT_COUNTED = [
  /^(BEGIN|COMMIT|ROLLBACK)\b/i,
  /INSERT INTO "public"\."api_request_logs"/i,
  /INSERT INTO "public"\."security_events"/i,
];

export interface QueryCount {
  count: number;
  queries: string[];
}

export async function countQueries(fn: () => Promise<unknown>): Promise<QueryCount> {
  subscribe();
  const log: string[] = [];
  recording = log;
  try {
    await fn();
    // Let any statement already dispatched report before the window closes.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    recording = null;
  }
  const counted = log.filter((q) => !NOT_COUNTED.some((re) => re.test(q)));
  return { count: counted.length, queries: counted };
}
