import type { Command } from 'commander';
import { ok, readGlobalOpts } from '../lib/output.js';
import { VERSION } from '../lib/version.js';

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Print the CLI version')
    .action(function (this: Command) {
      const ctx = readGlobalOpts(this);
      ok(ctx, { version: VERSION }, (d) => process.stdout.write(`${d.version}\n`));
    });
}
