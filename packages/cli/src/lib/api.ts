/**
 * Fetch helpers for the two surfaces the CLI drives: `/api/v1/admin/*` with
 * SUPER_ADMIN_KEY, and `/api/v1/tenant/*` with an operator personal access
 * token. `@rekey.dev/node` is not used for these: that SDK speaks the public
 * API with an Application secret key.
 */

import type { Command } from 'commander';
import { fail, type OutputContext } from './output.js';

/**
 * Add `--limit` / `--offset` to a list command.
 *
 * Every `/api/v1/admin/*` list endpoint takes the same two params and answers
 * with `{items, page}`. Before 2.0.0-rc.3 they answered with a bare array and
 * the CLI could neither page nor tell the operator that it had been handed a
 * window rather than the set, `rekey apps list` printed 50 of 90 and said
 * nothing.
 */
export function withListOptions(command: Command): Command {
  return command
    .option('--limit <n>', 'Rows per page (default 50, max 100)')
    .option('--offset <n>', 'Rows to skip (0-based)');
}

/** The admin list routes' page-size ceiling (`MAX_LIMIT` in the API). */
export const MAX_LIST_LIMIT = 100;

/**
 * Pull the `--limit` / `--offset` values off a parsed options object, refusing
 * values the API would reject before any request is made.
 *
 * @example
 * const qs = listQuery(readListOpts(ctx, opts));
 */
export function readListOpts(
  ctx: OutputContext,
  opts: { limit?: string; offset?: string },
): Record<string, string> {
  if (opts.limit !== undefined) {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      fail(ctx, {
        code: 'CLI_LIST_LIMIT_INVALID',
        message: `--limit must be an integer from 1 to ${MAX_LIST_LIMIT}. Got "${opts.limit}".`,
        fix: `Pass a whole number between 1 and ${MAX_LIST_LIMIT}, and page further with --offset.`,
      });
    }
  }
  if (opts.offset !== undefined) {
    const offset = Number(opts.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      fail(ctx, {
        code: 'CLI_LIST_OFFSET_INVALID',
        message: `--offset must be a non-negative integer. Got "${opts.offset}".`,
        fix: 'Pass a whole number such as 0 or 50.',
      });
    }
  }
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface ApiError {
  code: string;
  message: string;
  fix?: string;
}

/** What one request came to. `status` is 0 when no HTTP answer arrived. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

interface ErrorEnvelope {
  success: false;
  error: ApiError & { docs?: string };
}

/**
 * One request with a bearer credential, answered as a value. Commands that
 * should stop on an error use `adminRequest` or `operatorRequest`; `doctor`
 * uses this, because a refused request is one of its findings.
 *
 * @example
 * const result = await callApi<Paged<PlanDto>>(apiUrl, token, { method: 'GET', path });
 * if (!result.ok) return result.error.code;
 */
export async function callApi<T>(
  apiUrl: string,
  bearer: string,
  request: Pick<RequestArgs, 'method' | 'path' | 'body'>,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl.replace(/\/$/, '')}${request.path}`, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: 'CLI_NETWORK_ERROR',
        message: `Could not reach ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
        fix: 'Check REKEY_URL (or --api-url) and that the Rekey API is running. `rekey doctor` probes it.',
      },
    };
  }
  const json = (await res.json().catch(() => ({}))) as { success: true; data: T } | ErrorEnvelope;
  if (res.ok && !('success' in json && json.success === false)) {
    return { ok: true, data: (json as { success: true; data: T }).data };
  }
  if ('error' in json) {
    const { code, message, fix } = json.error;
    return { ok: false, status: res.status, error: { code, message, ...(fix !== undefined && { fix }) } };
  }
  return {
    ok: false,
    status: res.status,
    error: {
      code: 'CLI_HTTP_ERROR',
      message: `Request failed with HTTP ${res.status}.`,
      fix: 'Check the Rekey API logs for details.',
    },
  };
}

function requireApiUrl(ctx: OutputContext): string {
  if (ctx.apiUrl) return ctx.apiUrl;
  fail(ctx, {
    code: 'CLI_API_URL_MISSING',
    message: 'No Rekey API URL configured.',
    fix: 'Set REKEY_URL in your environment, or pass --api-url=https://your-rekey.example.',
  });
}

async function dataOrFail<T>(ctx: OutputContext, call: Promise<ApiResult<T>>): Promise<T> {
  const result = await call;
  if (result.ok) return result.data;
  fail(ctx, result.error);
}

/**
 * A request to a super-admin route (`/api/v1/admin/*`) with SUPER_ADMIN_KEY.
 *
 * @example
 * const data = await adminRequest<Paged<PlanDto>>({ ctx, method: 'GET', path: '/api/v1/admin/applications' });
 */
export async function adminRequest<T>(args: RequestArgs): Promise<T> {
  const apiUrl = requireApiUrl(args.ctx);
  if (!args.ctx.adminKey) {
    fail(args.ctx, {
      code: 'CLI_ADMIN_KEY_MISSING',
      message: 'No admin credential configured.',
      fix: 'Set SUPER_ADMIN_KEY in your environment, or pass --admin-key=<hex>.',
    });
  }
  return dataOrFail(args.ctx, callApi<T>(apiUrl, args.ctx.adminKey, args));
}

/** The operator scope a billing command needs, named in the fix when the token is missing. */
export type OperatorScope = 'billing:read' | 'billing:write';

/**
 * A request to an operator route (`/api/v1/tenant/*`) with an operator
 * personal access token. `scope` is the scope the route asks of the token.
 *
 * @example
 * const data = await operatorRequest<T>({ ctx, method: 'GET', path: '/api/v1/tenant/applications', scope: 'billing:read' });
 */
export async function operatorRequest<T>(args: RequestArgs & { scope?: OperatorScope }): Promise<T> {
  const apiUrl = requireApiUrl(args.ctx);
  if (!args.ctx.operatorToken) {
    fail(args.ctx, {
      code: 'CLI_OPERATOR_TOKEN_MISSING',
      message: 'This command acts as a workspace member and needs an operator personal access token.',
      fix:
        'Create one in the panel under Account, API tokens' +
        (args.scope === undefined ? '' : `, with the ${args.scope} scope`) +
        ', then set REKEY_OPERATOR_TOKEN or pass --operator-token.',
    });
  }
  return dataOrFail(args.ctx, callApi<T>(apiUrl, args.ctx.operatorToken, args));
}
