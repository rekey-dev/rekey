/**
 * Thin admin-side fetch helper. The CLI calls `/api/v1/admin/*` routes
 * with a Bearer header carrying SUPER_ADMIN_KEY. We don't use
 * `@rekey.dev/node` here because that SDK is for the *public* API
 * (Application secret keys), not the admin surface.
 */

import type { Command } from 'commander';
import { fail, type OutputContext } from './output.js';

/**
 * Add `--limit` / `--offset` to a list command.
 *
 * Every `/api/v1/admin/*` list endpoint takes the same two params and answers
 * with `{items, page}`. Before 2.0.0-rc.3 they answered with a bare array and
 * the CLI could neither page nor tell the operator that it had been handed a
 * window rather than the set — `rekey apps list` printed 50 of 90 and said
 * nothing.
 */
export function withListOptions(command: Command): Command {
  return command
    .option('--limit <n>', 'Rows per page (default 50, max 100)')
    .option('--offset <n>', 'Rows to skip (0-based)');
}

/** Pull the `--limit` / `--offset` values off a parsed options object. */
export function readListOpts(opts: { limit?: string; offset?: string }): Record<string, string> {
  return {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
  };
}

/** Build a `?a=b&c=d` string, or `''` when there is nothing to send. */
export function listQuery(params: Record<string, string>): string {
  const p = new URLSearchParams(params);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface RequestArgs {
  ctx: OutputContext;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; fix?: string; docs?: string };
}

export async function adminRequest<T>(args: RequestArgs): Promise<T> {
  if (!args.ctx.apiUrl) {
    fail(args.ctx, {
      code: 'CLI_API_URL_MISSING',
      message: 'No Rekey API URL configured.',
      fix: 'Set REKEY_URL in your environment, or pass --api-url=https://your-rekey.example.',
    });
  }
  if (!args.ctx.adminKey) {
    fail(args.ctx, {
      code: 'CLI_ADMIN_KEY_MISSING',
      message: 'No admin credential configured.',
      fix: 'Set SUPER_ADMIN_KEY in your environment, or pass --admin-key=<hex>.',
    });
  }

  const url = `${args.ctx.apiUrl.replace(/\/$/, '')}${args.path}`;
  const res = await fetch(url, {
    method: args.method,
    headers: {
      Authorization: `Bearer ${args.ctx.adminKey}`,
      ...(args.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });

  const json = (await res.json().catch(() => ({}))) as
    | { success: true; data: T }
    | ErrorEnvelope;

  if (!res.ok || ('success' in json && json.success === false)) {
    if ('error' in json) {
      fail(args.ctx, json.error);
    }
    fail(args.ctx, {
      code: 'CLI_HTTP_ERROR',
      message: `Request failed with HTTP ${res.status}.`,
      fix: 'Check the Rekey API logs for details.',
    });
  }
  return (json as { success: true; data: T }).data;
}
