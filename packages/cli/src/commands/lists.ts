/**
 * `rekey lists …`, lists of one Application, with that Application's secret key.
 *
 *   rekey lists ls
 *   rekey lists export <key> [--format csv|jsonl] [--status subscribed|unsubscribed|all] [--out <file>]
 *
 * Unlike the other commands these take `REKEY_SECRET` (or `--secret-key`),
 * not the super-admin key, so they work on Rekey Cloud too. `export` needs a
 * key minted with the elevated `contacts:read` scope.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import type { Command } from 'commander';
import { Rekey, RekeyError, type ListMemberDto } from '@rekey.dev/node';
import { fail, ok, readGlobalOpts, type OutputContext } from '../lib/output.js';

const FORMATS = ['csv', 'jsonl'] as const;
const STATUSES = ['subscribed', 'unsubscribed', 'all'] as const;
const COLUMNS = ['email', 'name', 'status', 'source', 'consentVersion', 'consentAt', 'subscribedAt', 'unsubscribedAt', 'updatedAt'] as const;

function appClient(ctx: OutputContext): Rekey {
  if (!ctx.apiUrl) {
    fail(ctx, {
      code: 'CLI_API_URL_MISSING',
      message: 'No Rekey API URL configured.',
      fix: 'Set REKEY_URL in your environment, or pass --api-url=https://your-rekey.example.',
    });
  }
  if (!ctx.secretKey) {
    fail(ctx, {
      code: 'CLI_SECRET_KEY_MISSING',
      message: 'The lists commands need an Application secret key.',
      fix: 'Set REKEY_SECRET, or pass --secret-key=rp_…, from Panel, Application, API Keys. `export` needs a key minted with contacts:read.',
    });
  }
  return new Rekey({ apiUrl: ctx.apiUrl, secretKey: ctx.secretKey });
}

async function orFail<T>(ctx: OutputContext, call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (err instanceof RekeyError) {
      fail(ctx, { code: err.code, message: err.message, ...(err.fix !== undefined && { fix: err.fix }) });
    }
    throw err;
  }
}

/** One CSV cell: quoted when needed, and a leading `= + - @` defused so a spreadsheet never runs it. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(format: (typeof FORMATS)[number], member: ListMemberDto): string {
  if (format === 'jsonl') return JSON.stringify(member);
  return COLUMNS.map((c) => csvCell(member[c])).join(',');
}

function write(out: WriteStream | NodeJS.WriteStream, line: string): Promise<void> {
  return new Promise((resolve) => {
    if (out.write(`${line}\n`)) resolve();
    else out.once('drain', () => resolve());
  });
}

export function registerListsCommand(program: Command): void {
  const lists = program.command('lists').description("Read an Application's lists (uses REKEY_SECRET)");

  lists
    .command('ls')
    .description('List the lists, with member counts')
    .action(async function (this: Command) {
      const ctx = readGlobalOpts(this);
      const data = await orFail(ctx, appClient(ctx).lists.list());
      ok(ctx, { lists: data }, (d) => {
        if (d.lists.length === 0) {
          process.stdout.write('(no lists)\n');
          return;
        }
        for (const l of d.lists) {
          const flags = [l.archived ? 'archived' : '', l.publicCapture ? 'public' : ''].filter(Boolean).join(',');
          process.stdout.write(`${l.key.padEnd(24)}  ${String(l.subscribed).padStart(7)} subscribed  ${l.name}${flags ? `  [${flags}]` : ''}\n`);
        }
      });
    });

  lists
    .command('export <key>')
    .description('Write every member of a list as CSV or JSON lines (needs a key with contacts:read)')
    .option('--format <format>', 'csv | jsonl', 'csv')
    .option('--status <status>', 'subscribed | unsubscribed | all', 'subscribed')
    .option('--out <file>', 'Write to this file instead of stdout')
    .action(async function (this: Command, key: string, opts: { format: string; status: string; out?: string }) {
      const ctx = readGlobalOpts(this);
      if (!FORMATS.includes(opts.format as never)) {
        fail(ctx, {
          code: 'CLI_LISTS_FORMAT_INVALID',
          message: `--format must be ${FORMATS.join(' or ')}. Got "${opts.format}".`,
          fix: 'Pass --format csv or --format jsonl.',
        });
      }
      if (!STATUSES.includes(opts.status as never)) {
        fail(ctx, {
          code: 'CLI_LISTS_STATUS_INVALID',
          message: `--status must be ${STATUSES.join(', ')}. Got "${opts.status}".`,
          fix: 'Pass --status subscribed, unsubscribed or all.',
        });
      }
      const format = opts.format as (typeof FORMATS)[number];
      const client = appClient(ctx);
      const out = opts.out ? createWriteStream(opts.out) : process.stdout;
      let count = 0;
      if (format === 'csv') await write(out, COLUMNS.join(','));
      const members = client.lists.iterateMembers(key, { status: opts.status as (typeof STATUSES)[number], limit: 500 });
      await orFail(
        ctx,
        (async () => {
          for await (const member of members) {
            await write(out, row(format, member));
            count++;
          }
        })(),
      );
      if (opts.out) {
        await new Promise<void>((resolve) => (out as WriteStream).end(resolve));
        ok(ctx, { key, format, status: opts.status, count, file: opts.out }, (d) => {
          process.stdout.write(`Wrote ${d.count} member${d.count === 1 ? '' : 's'} to ${d.file}\n`);
        });
      }
    });
}
