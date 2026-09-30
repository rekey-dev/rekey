#!/usr/bin/env node
/**
 * `rekey`, command-line interface.
 *
 * Two design rules drive everything in here (per PLAN.md §2.5 "AI-first DX"):
 *
 *   1. **Every command runs non-interactively when given enough flags.**
 *      No required prompts. An AI agent can call `rekey apps create
 *      --tenant tn_xxx --name "MyApp" --slug myapp --json` and parse the
 *      output without ever needing a TTY.
 *
 *   2. **Output is structured when asked.** Pass `--json` and you get a
 *      single JSON document on stdout suitable for `jq`. Without `--json`,
 *      the same data is rendered as friendly human text on stdout. Errors
 *      always go to stderr; exit code matches success.
 */

import { Command, CommanderError } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerAppsCommand } from './commands/apps.js';
import { registerPlansCommand } from './commands/plans.js';
import { registerListsCommand } from './commands/lists.js';
import { registerAnalyticsCommand } from './commands/analytics.js';
import { registerVersionCommand } from './commands/version.js';
import { VERSION } from './lib/version.js';
import { isEntryPoint } from './lib/entry-point.js';
import { fail } from './lib/output.js';

export { VERSION } from './lib/version.js';

/** Assemble the `rekey` command tree without running it. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('rekey')
    .description(
      'Rekey command-line interface. Pass --json on any command for machine-readable output. ' +
        'Agent-facing contract: the AGENTS.md shipped in this package, also at ' +
        'https://github.com/rekey-dev/rekey/blob/main/packages/cli/AGENTS.md',
    )
    // `rekey version` was the only way to ask, and `rekey --version`, which is
    // what everyone tries first, answered "unknown option". Both work now; the
    // subcommand stays because it is the one that honours --json.
    .version(VERSION, '-V, --version', 'Print the CLI version')
    // No option defaults from the environment: commander prints a default in
    // --help, so the live SUPER_ADMIN_KEY ended up in the help text.
    // readGlobalOpts falls back to the environment instead.
    .option('--api-url <url>', 'Rekey API URL (env: REKEY_URL)')
    .option('--admin-key <key>', 'Super-admin key (env: SUPER_ADMIN_KEY)')
    .option('--secret-key <key>', 'Application secret key, for `lists` (env: REKEY_SECRET)')
    .option('--operator-token <token>', 'Operator personal access token, for `analytics` (env: REKEY_OPERATOR_TOKEN)')
    .option('--json', 'Emit machine-readable JSON on stdout (errors still go to stderr).')
    .showHelpAfterError();

  registerVersionCommand(program);
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerAppsCommand(program);
  registerPlansCommand(program);
  registerListsCommand(program);
  registerAnalyticsCommand(program);

  return program;
}

const USAGE_ERROR_FIX = 'Run `rekey --help`, or `rekey <command> --help`, for the accepted commands and options.';

/**
 * Send commander's own parse errors (unknown option, missing required option,
 * unknown command) through the `--json` error envelope instead of plain text.
 * Commander copies these settings onto subcommands only at creation time, so
 * the whole tree is walked.
 */
function routeUsageErrorsToJson(cmd: Command): void {
  cmd.exitOverride().configureOutput({ writeErr: () => {}, outputError: () => {} });
  for (const sub of cmd.commands) routeUsageErrorsToJson(sub);
}

function usageErrorMessage(err: CommanderError): string {
  if (err.code === 'commander.help') return 'No command given.';
  return err.message.replace(/^error: /, '');
}

/** Parse `process.argv` and run. Called only when this file IS the entry point. */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  const json = argv.includes('--json');
  if (json) routeUsageErrorsToJson(program);

  await program.parseAsync(argv).catch((err: unknown) => {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) process.exit(0);
      fail(
        { json, apiUrl: undefined, adminKey: undefined, secretKey: undefined },
        { code: 'CLI_USAGE_ERROR', message: usageErrorMessage(err), fix: USAGE_ERROR_FIX },
      );
    }
    // Top-level safety net. Individual commands handle their own errors and
    // call process.exit(1); we only get here if a command throws something
    // unhandled.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

// This package declares `main` / `types` / `exports`, so `import '@rekey.dev/cli'`
// resolves, and it used to PARSE `process.argv` and `process.exit(1)` while the
// module was still evaluating, hijacking the importing program's arguments.
// Running is gated on actually being the process entry point.
if (isEntryPoint(import.meta.url)) {
  void main();
}
