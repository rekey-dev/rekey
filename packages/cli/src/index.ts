#!/usr/bin/env node
/**
 * `rekey` — command-line interface.
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

import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerAppsCommand } from './commands/apps.js';
import { registerPlansCommand } from './commands/plans.js';
import { registerVersionCommand } from './commands/version.js';
import { VERSION } from './lib/version.js';

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
    // `rekey version` was the only way to ask, and `rekey --version` — which is
    // what everyone tries first — answered "unknown option". Both work now; the
    // subcommand stays because it is the one that honours --json.
    .version(VERSION, '-V, --version', 'Print the CLI version')
    .option('--api-url <url>', 'Override REKEY_URL', process.env.REKEY_URL)
    .option('--admin-key <key>', 'Override SUPER_ADMIN_KEY', process.env.SUPER_ADMIN_KEY)
    .option('--json', 'Emit machine-readable JSON on stdout (errors still go to stderr).')
    .showHelpAfterError();

  registerVersionCommand(program);
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerAppsCommand(program);
  registerPlansCommand(program);

  return program;
}

/** Parse `process.argv` and run. Called only when this file IS the entry point. */
export async function main(argv: string[] = process.argv): Promise<void> {
  await buildProgram()
    .parseAsync(argv)
    .catch((err: unknown) => {
      // Top-level safety net. Individual commands handle their own errors and
      // call process.exit(1); we only get here if a command throws something
      // unhandled.
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

// This package declares `main` / `types` / `exports`, so `import '@rekey.dev/cli'`
// resolves — and it used to PARSE `process.argv` and `process.exit(1)` while the
// module was still evaluating, hijacking the importing program's arguments. Same
// defect as @rekey.dev/mcp's env check. Running is now gated on actually being
// the process entry point.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
