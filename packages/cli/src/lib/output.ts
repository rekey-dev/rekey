/**
 * Output helpers — used by every command to emit either human-friendly text
 * or machine-readable JSON, depending on the global `--json` flag.
 *
 * Errors always go to stderr; exit code is 0 on success, 1 on failure.
 * Commands should return *data*, not call `process.exit` directly — the
 * runner here decides on the right exit path.
 */

import type { Command } from 'commander';

export interface OutputContext {
  json: boolean;
  apiUrl: string | undefined;
  adminKey: string | undefined;
}

/** Read globals (`--json`, `--api-url`, `--admin-key`) from any subcommand. */
export function readGlobalOpts(cmd: Command): OutputContext {
  // commander attaches global opts to the root program; walk parents.
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  const opts = root.opts<{ json?: boolean; apiUrl?: string; adminKey?: string }>();
  return {
    json: Boolean(opts.json),
    apiUrl: opts.apiUrl,
    adminKey: opts.adminKey,
  };
}

/** Print success output. JSON-mode: a single JSON document. Text mode: `render` runs. */
export function ok<T>(ctx: OutputContext, data: T, render: (d: T) => void): void {
  if (ctx.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    render(data);
  }
}

/** Fail with an error envelope on stderr and a non-zero exit. */
export function fail(
  ctx: OutputContext,
  args: { code: string; message: string; fix?: string },
): never {
  if (ctx.json) {
    process.stderr.write(JSON.stringify({ success: false, error: args }, null, 2) + '\n');
  } else {
    process.stderr.write(`error: ${args.message}\n`);
    process.stderr.write(`code:  ${args.code}\n`);
    if (args.fix) process.stderr.write(`fix:   ${args.fix}\n`);
  }
  process.exit(1);
}
