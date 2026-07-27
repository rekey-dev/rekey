/**
 * Thin admin-side fetch helper. The CLI calls `/api/v1/admin/*` routes
 * with a Bearer header carrying SUPER_ADMIN_KEY. We don't use
 * `@rekey.dev/node` here because that SDK is for the *public* API
 * (Application secret keys), not the admin surface.
 */

import { fail, type OutputContext } from './output.js';

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
      fix: 'Set RELIPAY_URL in your environment, or pass --api-url=https://your-rekey.example.',
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
