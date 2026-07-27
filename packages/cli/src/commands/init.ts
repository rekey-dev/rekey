/**
 * `rekey init` — bootstrap a fresh deployment.
 *
 * One-shot, non-interactive when given the required flags:
 *
 *   rekey init --tenant-name "Acme" --owner-email ops@acme.com \
 *                --app-name "Acme Prod" --app-slug acme-prod \
 *                --json
 *
 * Creates:
 *   1. A Tenant.
 *   2. An Application under that Tenant.
 *   3. A live API key for the new Application.
 *
 * Returns all three. The raw API key is shown ONCE — store it immediately.
 */

import type { Command } from 'commander';
import { ok, fail, readGlobalOpts } from '../lib/output.js';
import { adminRequest } from '../lib/api.js';

interface InitOptions {
  tenantName?: string;
  ownerEmail?: string;
  appName?: string;
  appSlug?: string;
  apiKeyName?: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Bootstrap a fresh Rekey deployment: Tenant + Application + first API key.')
    .requiredOption('--tenant-name <name>', 'Display name for the new Tenant')
    .requiredOption('--owner-email <email>', 'Owner email for the new Tenant')
    .requiredOption('--app-name <name>', 'Display name for the first Application')
    .requiredOption('--app-slug <slug>', 'URL-safe slug for the first Application')
    .option('--api-key-name <name>', 'Label for the first API key', 'cli')
    .action(async function (this: Command, opts: InitOptions) {
      const ctx = readGlobalOpts(this);
      if (!opts.tenantName || !opts.ownerEmail || !opts.appName || !opts.appSlug) {
        fail(ctx, {
          code: 'CLI_INIT_ARGS_MISSING',
          message: 'init requires --tenant-name, --owner-email, --app-name, --app-slug.',
          fix: 'Pass all four flags. See `rekey init --help`.',
        });
      }

      const tenant = await adminRequest<{ id: string; name: string; ownerEmail: string }>({
        ctx,
        method: 'POST',
        path: '/api/v1/admin/tenants',
        body: { name: opts.tenantName, ownerEmail: opts.ownerEmail },
      });

      const application = await adminRequest<{
        id: string;
        slug: string;
        publicKey: string;
      }>({
        ctx,
        method: 'POST',
        path: '/api/v1/admin/applications',
        body: { tenantId: tenant.id, name: opts.appName, slug: opts.appSlug },
      });

      const keyResp = await adminRequest<{
        apiKey: { id: string; keyPrefix: string };
        rawKey: string;
        warning: string;
      }>({
        ctx,
        method: 'POST',
        path: `/api/v1/admin/applications/${application.id}/api-keys`,
        body: { name: opts.apiKeyName ?? 'cli', mode: 'live' },
      });

      ok(ctx, { tenant, application, apiKey: keyResp }, (d) => {
        process.stdout.write(`✓ Tenant      ${d.tenant.id}  ${d.tenant.name}\n`);
        process.stdout.write(`✓ Application ${d.application.id}  ${d.application.slug}\n`);
        process.stdout.write(`✓ Public key  ${d.application.publicKey}\n`);
        process.stdout.write(`✓ API key     ${d.apiKey.apiKey.keyPrefix}…\n\n`);
        process.stdout.write(`SECRET KEY (shown once — save it now):\n`);
        process.stdout.write(`  ${d.apiKey.rawKey}\n`);
      });
    });
}
