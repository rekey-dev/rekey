/**
 * `rekey apps …` — Application management.
 *
 *   rekey apps list [--tenant <id>]
 *   rekey apps get <id>
 *   rekey apps create --tenant <id> --name <name> --slug <slug>
 */

import type { Command } from 'commander';
import { ok, fail, readGlobalOpts } from '../lib/output.js';
import { adminRequest } from '../lib/api.js';

interface ApplicationDto {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  publicKey: string;
  createdAt: string;
}

export function registerAppsCommand(program: Command): void {
  const apps = program.command('apps').description('Manage Applications');

  apps
    .command('list')
    .description('List Applications (optionally filter by --tenant)')
    .option('--tenant <id>', 'Restrict to one Tenant id')
    .action(async function (this: Command, opts: { tenant?: string }) {
      const ctx = readGlobalOpts(this);
      const path = opts.tenant
        ? `/api/v1/admin/applications?tenantId=${encodeURIComponent(opts.tenant)}`
        : '/api/v1/admin/applications';
      const data = await adminRequest<ApplicationDto[]>({ ctx, method: 'GET', path });
      ok(ctx, { applications: data }, (d) => {
        if (d.applications.length === 0) {
          process.stdout.write('(no applications)\n');
          return;
        }
        for (const a of d.applications) {
          process.stdout.write(`${a.id}  ${a.slug.padEnd(20)}  ${a.name}\n`);
        }
      });
    });

  apps
    .command('get <id>')
    .description('Get an Application by id')
    .action(async function (this: Command, id: string) {
      const ctx = readGlobalOpts(this);
      const data = await adminRequest<ApplicationDto>({
        ctx,
        method: 'GET',
        path: `/api/v1/admin/applications/${encodeURIComponent(id)}`,
      });
      ok(ctx, data, (d) => {
        process.stdout.write(`id:        ${d.id}\n`);
        process.stdout.write(`name:      ${d.name}\n`);
        process.stdout.write(`slug:      ${d.slug}\n`);
        process.stdout.write(`tenant:    ${d.tenantId}\n`);
        process.stdout.write(`publicKey: ${d.publicKey}\n`);
        process.stdout.write(`created:   ${d.createdAt}\n`);
      });
    });

  apps
    .command('create')
    .description('Create an Application under a Tenant')
    .requiredOption('--tenant <id>')
    .requiredOption('--name <name>')
    .requiredOption('--slug <slug>')
    .action(async function (
      this: Command,
      opts: { tenant?: string; name?: string; slug?: string },
    ) {
      const ctx = readGlobalOpts(this);
      if (!opts.tenant || !opts.name || !opts.slug) {
        fail(ctx, {
          code: 'CLI_APPS_CREATE_ARGS_MISSING',
          message: 'apps create requires --tenant, --name, --slug.',
          fix: 'Pass all three. See `rekey apps create --help`.',
        });
      }
      const data = await adminRequest<ApplicationDto>({
        ctx,
        method: 'POST',
        path: '/api/v1/admin/applications',
        body: { tenantId: opts.tenant, name: opts.name, slug: opts.slug },
      });
      ok(ctx, data, (d) => {
        process.stdout.write(`✓ ${d.id}  ${d.slug}  (${d.publicKey})\n`);
      });
    });
}
