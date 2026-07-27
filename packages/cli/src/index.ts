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

import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerAppsCommand } from './commands/apps.js';
import { registerPlansCommand } from './commands/plans.js';
import { registerVersionCommand } from './commands/version.js';

const program = new Command();

program
  .name('rekey')
  .description(
    'Rekey command-line interface. Pass --json on any command for machine-readable output. ' +
      'See packages/cli/AGENTS.md for the full agent-facing contract.',
  )
  .option('--api-url <url>', 'Override RELIPAY_URL', process.env.RELIPAY_URL)
  .option('--admin-key <key>', 'Override SUPER_ADMIN_KEY', process.env.SUPER_ADMIN_KEY)
  .option('--json', 'Emit machine-readable JSON on stdout (errors still go to stderr).')
  .showHelpAfterError();

registerVersionCommand(program);
registerInitCommand(program);
registerDoctorCommand(program);
registerAppsCommand(program);
registerPlansCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  // Top-level safety net. Individual commands handle their own errors and
  // call process.exit(1); we only get here if a command throws something
  // unhandled.
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
