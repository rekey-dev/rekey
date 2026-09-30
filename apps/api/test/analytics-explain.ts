/**
 * The plan guard for dashboard reads: record every statement a request sends,
 * then EXPLAIN each one with sequential scans switched off. A `Seq Scan` that
 * survives `enable_seqscan = off` over one of the big tables means no index
 * can serve that query, so it would read the whole table on every cache miss.
 *
 * `GENERIC_PLAN` (Postgres 16) plans the parameterised text as sent, without
 * needing the parameter values.
 */

import { prisma } from '../src/lib/prisma.js';

export const BIG_TABLES = ['end_users', 'security_events', 'refresh_tokens', 'usage_records', 'subscriptions'] as const;

let recording: string[] | null = null;
let subscribed = false;

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  (prisma as unknown as { $on(e: 'query', cb: (e: { query: string }) => void): void }).$on('query', (e) => {
    recording?.push(e.query);
  });
}

/** The SQL `fn` sent, as Prisma logged it. */
export async function recordStatements(fn: () => Promise<unknown>): Promise<string[]> {
  subscribe();
  const log: string[] = [];
  recording = log;
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    recording = null;
  }
  return log;
}

/**
 * Prisma binds parameters over the extended protocol, which refuses a `$1`
 * with no value. Dynamic SQL inside plpgsql parses the text with no
 * parameters, which `GENERIC_PLAN` accepts.
 */
const EXPLAIN_FUNCTION = `
CREATE OR REPLACE FUNCTION pg_temp.rk_explain_generic(q text) RETURNS json LANGUAGE plpgsql AS $fn$
DECLARE result json;
BEGIN
  EXECUTE 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ' || q INTO result;
  RETURN result;
END
$fn$`;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

function seqScans(node: PlanNode, out: string[]): void {
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) out.push(node['Relation Name']);
  for (const child of node.Plans ?? []) seqScans(child, out);
}

/**
 * Big tables read by a sequential scan in each statement that touches one.
 *
 * @example
 *   expect(await seqScansOnBigTables(statements)).toEqual([]);
 */
export async function seqScansOnBigTables(statements: string[]): Promise<Array<{ sql: string; tables: string[] }>> {
  const relevant = statements.filter(
    (q) => /^\s*(SELECT|WITH)\b/i.test(q) && BIG_TABLES.some((t) => q.includes(`"${t}"`)),
  );
  const findings: Array<{ sql: string; tables: string[] }> = [];
  for (const sql of relevant) {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe(EXPLAIN_FUNCTION);
      return tx.$queryRawUnsafe<Array<{ plan: Array<{ Plan: PlanNode }> }>>(
        'SELECT pg_temp.rk_explain_generic($1) AS plan',
        sql,
      );
    });
    const tables: string[] = [];
    seqScans(plan[0]!.plan[0]!.Plan, tables);
    const big = tables.filter((t) => (BIG_TABLES as readonly string[]).includes(t));
    if (big.length > 0) findings.push({ sql: sql.slice(0, 400), tables: big });
  }
  return findings;
}
