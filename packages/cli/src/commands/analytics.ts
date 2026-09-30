/**
 * `rekey analytics users`, the Users overview of one Application.
 *
 *   rekey analytics users --app <id> [--range 30d] [--from YYYY-MM-DD --to YYYY-MM-DD]
 *     [--compare prev|none] [--sections kpis,activity] [--platform ios,web] [--country DE]
 *     [--via passkey] [--created-via oauth] [--onboarding completed] [--verified true]
 *     [--mfa true] [--plan <id>] [--paying true] [--org <id>] [--json]
 *
 * Reads as a workspace member, so it takes an operator personal access token
 * (`REKEY_OPERATOR_TOKEN` or `--operator-token`), not the admin key. The
 * options are passed through to the API unchanged; it validates them.
 */

import type { Command } from 'commander';
import { operatorRequest } from '../lib/api.js';
import { ok, readGlobalOpts } from '../lib/output.js';

const PASS_THROUGH: Array<[flag: string, param: string]> = [
  ['range', 'range'],
  ['from', 'from'],
  ['to', 'to'],
  ['compare', 'compare'],
  ['sections', 'sections'],
  ['platform', 'platform'],
  ['country', 'country'],
  ['via', 'via'],
  ['createdVia', 'createdVia'],
  ['onboarding', 'onboarding'],
  ['verified', 'verified'],
  ['mfa', 'mfa'],
  ['plan', 'plan'],
  ['paying', 'paying'],
  ['org', 'org'],
];

interface Envelope {
  status: string;
  timezone?: string;
  source?: string;
  error?: { code: string; message: string };
  data?: unknown;
}

interface UsersAnalytics {
  range: { from: string; to: string; days: number; timezone: string };
  sections: Record<string, Envelope>;
}

/**
 * The query string for the flags given, in a fixed order.
 *
 * @example
 *   analyticsQuery({ range: '7d', platform: 'ios' }) // '?range=7d&platform=ios'
 */
export function analyticsQuery(opts: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [flag, param] of PASS_THROUGH) {
    const v = opts[flag];
    if (v !== undefined) q.set(param, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function registerAnalyticsCommand(program: Command): void {
  const analytics = program.command('analytics').description('Aggregate analytics (uses REKEY_OPERATOR_TOKEN)');

  analytics
    .command('users')
    .description("An Application's Users overview: KPIs, activity, mix, onboarding, retention, health")
    .requiredOption('--app <id>', 'Application id')
    .option('--range <range>', '7d, 30d, 90d, 12m or custom (default 30d)')
    .option('--from <day>', 'First day, YYYY-MM-DD, with --range custom')
    .option('--to <day>', 'Last day, YYYY-MM-DD, with --range custom')
    .option('--compare <mode>', 'prev or none (default prev)')
    .option('--sections <list>', 'Comma list: kpis, activity, mix, onboarding, retention, security, billing, usage')
    .option('--platform <list>', 'Comma list of latest platforms')
    .option('--country <list>', 'Comma list of ISO 3166-1 alpha-2 codes')
    .option('--via <list>', 'Comma list of latest sign-in methods')
    .option('--created-via <list>', 'Comma list of sign-up sources')
    .option('--onboarding <status>', 'pending, completed or skipped')
    .option('--verified <bool>', 'true or false')
    .option('--mfa <bool>', 'true or false')
    .option('--plan <id>', 'Plan id (needs billing:read)')
    .option('--paying <bool>', 'true or false (needs billing:read)')
    .option('--org <id>', 'Organization id (needs organizations:read)')
    .action(async function (this: Command) {
      const ctx = readGlobalOpts(this);
      const opts = this.opts<Record<string, string | undefined> & { app: string }>();
      const data = await operatorRequest<UsersAnalytics>({
        ctx,
        method: 'GET',
        path: `/api/v1/tenant/applications/${encodeURIComponent(opts.app)}/analytics/users${analyticsQuery(opts)}`,
      });
      ok(ctx, data, (d) => {
        process.stdout.write(`${d.range.from} to ${d.range.to} (${d.range.days} days, ${d.range.timezone})\n`);
        for (const [name, s] of Object.entries(d.sections)) {
          const detail =
            s.status === 'ok' ? `${s.source ?? ''} ${s.timezone ?? ''}`.trim() : s.status === 'error' ? `${s.error?.code}` : '';
          process.stdout.write(`  ${name.padEnd(11)} ${s.status}${detail ? ` (${detail})` : ''}\n`);
        }
        process.stdout.write('Pass --json for the numbers.\n');
      });
    });
}
