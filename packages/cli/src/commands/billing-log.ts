/**
 * `rekey billing log`, an Application's billing log.
 *
 *   rekey billing log --app <id> [--type a,b] [--tier permanent|diagnostic]
 *       [--end-user id] [--subscription id] [--payment id] [--currency INR]
 *       [--from ISO] [--to ISO] [--limit n] [--cursor c] [--all [--max n]]
 *       [--include actors]
 *
 * Newest first, paged on a cursor. With `--json` it prints
 * `{ items, nextCursor, actors }`. Entries name people by id; `--include
 * actors` adds who those ids are, and the text output then prints an email or
 * a name in place of the id.
 */

import type { Command } from 'commander';
import {
  formatMoney,
  type BillingEventTier,
  type BillingLogActors,
  type BillingLogEntry,
  type BillingLogInclude,
  type BillingLogPage,
} from '@rekey.dev/node';
import { ok, readGlobalOpts } from '../lib/output.js';
import { operatorRequest } from '../lib/api.js';
import { appPath, queryString, readChoice, readCurrency, readInstant, readInteger } from '../lib/input.js';

/** The API's page-size ceiling for the log (`BILLING_LOG_MAX_LIMIT`). */
const MAX_PAGE = 200;
const DEFAULT_MAX_ENTRIES = 1000;
const TIERS: readonly BillingEventTier[] = ['PERMANENT', 'DIAGNOSTIC'];
const DATE = { code: 'CLI_BILLING_DATE_INVALID' };
const INCLUDES: readonly BillingLogInclude[] = ['actors'];

const NAMED_IDS = [
  ['payment', 'paymentId'],
  ['refund', 'refundId'],
  ['subscription', 'subscriptionId'],
  ['checkout', 'checkoutSessionId'],
  ['end-user', 'endUserId'],
  ['provider', 'provider'],
] as const;

/** An end user as a log line names them: their email, `erased`, or the id when nobody was resolved. */
function endUserName(actors: BillingLogActors | null, id: string): string {
  const user = actors?.endUsers?.find((each) => each.id === id);
  if (user?.state === 'erased') return `${id} (erased)`;
  return user?.state === 'known' && user.email !== null ? user.email : id;
}

/** Who caused an entry, when it was a person the page resolved. */
function actorName(actors: BillingLogActors | null, actor: BillingLogEntry['actor']): string | null {
  if (actors === null || actor.id === null) return null;
  if (actor.type === 'end_user') return endUserName(actors, actor.id);
  if (actor.type !== 'operator') return null;
  const operator = actors.operators.find((each) => each.id === actor.id);
  if (operator?.state !== 'known') return actor.id;
  return operator.name === null ? operator.email : `${operator.name} <${operator.email}>`;
}

/**
 * One log entry as a line: when, what, how much, and the records it names.
 * With the page's `actors`, an end user is written by email and the operator
 * or end user who caused the entry is added as `by=`.
 *
 * @example
 * logLine(entry); // '2026-10-01T09:00:00.000Z  payment.recorded  $19.00  payment=pay_1 subscription=sub_1'
 * logLine(entry, page.actors); // '...  payment=pay_1 subscription=sub_1 end-user=buyer@example.com'
 */
export function logLine(entry: BillingLogEntry, actors: BillingLogActors | null = null): string {
  const money = entry.amount !== null && entry.currency !== null ? formatMoney(entry.amount, entry.currency) : '-';
  const ids = NAMED_IDS.flatMap(([label, key]) => {
    const value = entry[key];
    if (value === null) return [];
    return [`${label}=${key === 'endUserId' ? endUserName(actors, value) : value}`];
  });
  const by = actorName(actors, entry.actor);
  if (by !== null) ids.push(`by=${by}`);
  return [entry.occurredAt, entry.type, money, ids.join(' ')].join('  ').trimEnd();
}

/** The actors of several pages as one, each person once. */
function mergeActors(a: BillingLogActors | null, b: BillingLogActors | null): BillingLogActors | null {
  if (a === null || b === null) return a ?? b;
  const once = <T extends { id: string }>(rows: readonly T[]): T[] => [...new Map(rows.map((row) => [row.id, row])).values()];
  return {
    endUsers: a.endUsers === null || b.endUsers === null ? null : once([...a.endUsers, ...b.endUsers]),
    operators: once([...a.operators, ...b.operators]),
  };
}

interface LogOptions {
  app: string;
  type?: string;
  tier?: string;
  endUser?: string;
  subscription?: string;
  payment?: string;
  currency?: string;
  from?: string;
  to?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
  max?: string;
  include?: string;
}

/**
 * Attach `log` under `rekey billing`.
 *
 * @example
 * registerBillingLogCommand(program.command('billing'));
 */
export function registerBillingLogCommand(billing: Command): void {
  billing
    .command('log')
    .description('Read the billing log, newest first: every money change and pricing decision')
    .requiredOption('--app <id>', 'Application id')
    .option('--type <list>', 'Comma list of event types, e.g. checkout.price_fallback,payment.refunded')
    .option('--tier <tier>', 'permanent | diagnostic')
    .option('--end-user <id>', 'Only entries about this end user')
    .option('--subscription <id>', 'Only entries that name this subscription')
    .option('--payment <id>', 'Only entries that name this payment')
    .option('--currency <code>', 'Only entries about money in this ISO 4217 currency')
    .option('--from <instant>', 'Entries at or after this ISO 8601 instant')
    .option('--to <instant>', 'Entries before this ISO 8601 instant')
    .option('--limit <n>', `Entries per page, 1 to ${MAX_PAGE} (default 50)`)
    .option('--cursor <cursor>', 'The nextCursor of the previous page')
    .option('--all', 'Follow nextCursor to the end of the log, up to --max entries')
    .option('--max <n>', `With --all, stop after this many entries (default ${DEFAULT_MAX_ENTRIES})`)
    .option(
      '--include <what>',
      'actors: also resolve who the end users and operators named are, as they stand now. End users need a token with end-users:read',
    )
    .action(async function (this: Command, opts: LogOptions) {
      const ctx = readGlobalOpts(this);
      const limit =
        opts.limit === undefined
          ? undefined
          : readInteger(ctx, opts.limit, { code: 'CLI_BILLING_LIMIT_INVALID', what: '--limit' }, 1, MAX_PAGE);
      const max =
        opts.max === undefined
          ? DEFAULT_MAX_ENTRIES
          : readInteger(ctx, opts.max, { code: 'CLI_BILLING_MAX_INVALID', what: '--max' }, 1, 100_000);
      const filters = {
        type: opts.type,
        tier:
          opts.tier === undefined
            ? undefined
            : readChoice(ctx, opts.tier.toUpperCase(), TIERS, { code: 'CLI_BILLING_TIER_INVALID', what: '--tier' }),
        endUserId: opts.endUser,
        subscriptionId: opts.subscription,
        paymentId: opts.payment,
        currency:
          opts.currency === undefined
            ? undefined
            : readCurrency(ctx, opts.currency, { code: 'CLI_BILLING_CURRENCY_INVALID', what: '--currency' }),
        from: opts.from === undefined ? undefined : readInstant(ctx, opts.from, { ...DATE, what: '--from' }),
        to: opts.to === undefined ? undefined : readInstant(ctx, opts.to, { ...DATE, what: '--to' }),
        include:
          opts.include === undefined
            ? undefined
            : readChoice(ctx, opts.include, INCLUDES, { code: 'CLI_BILLING_INCLUDE_INVALID', what: '--include' }),
      };
      const page = (cursor: string | undefined, size: number | undefined) =>
        operatorRequest<BillingLogPage>({
          ctx,
          method: 'GET',
          path: appPath(opts.app, `/billing/events${queryString({ ...filters, limit: size, cursor })}`),
          scope: 'billing:read',
        });

      const readToEnd = async (): Promise<BillingLogPage> => {
        const items: BillingLogEntry[] = [];
        let actors: BillingLogActors | null = null;
        let cursor = opts.cursor;
        for (;;) {
          const next = await page(cursor, Math.min(limit ?? MAX_PAGE, max - items.length));
          items.push(...next.items);
          actors = mergeActors(actors, next.actors);
          if (next.nextCursor === null || items.length >= max) return { items, nextCursor: next.nextCursor, actors };
          cursor = next.nextCursor;
        }
      };
      const data = opts.all === true ? await readToEnd() : await page(opts.cursor, limit);

      ok(ctx, data, (d) => {
        if (d.items.length === 0) process.stdout.write('(no entries)\n');
        for (const entry of d.items) process.stdout.write(`${logLine(entry, d.actors)}\n`);
        if (d.nextCursor !== null) {
          process.stdout.write(`\nMore entries: pass --cursor ${d.nextCursor} for the next page.\n`);
        }
      });
    });
}
