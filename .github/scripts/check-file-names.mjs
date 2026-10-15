#!/usr/bin/env node
/**
 * Fail when a tracked source or test file is named for the work that produced
 * it instead of for what it holds. See "Name things for what they are" in
 * AGENTS.md.
 *
 * A name like `review-fixes.test.ts` or `audit-3.test.ts` tells the next reader
 * nothing about what breaks when it goes red, and it stops meaning anything the
 * day the review is forgotten. Comments do not fail builds, so this does.
 *
 * Checked: every path segment below `apps/<app>/src`, `apps/<app>/test`,
 * `packages/<pkg>/src` and `packages/<pkg>/test`. A segment is split into words
 * on punctuation and on camelCase, and no word may be a process word.
 *
 *   node .github/scripts/check-file-names.mjs              check the tracked tree
 *   node .github/scripts/check-file-names.mjs --self-test  check the rules themselves
 */

import { execFileSync } from 'node:child_process';

const SCANNED = /^(apps|packages)\/[^/]+\/(src|test)\//;

/** Words that describe how or when a file came to exist. */
const PROCESS_WORDS = [
  /^audit(s|ed)?\d*$/,
  /^review(s|ed)?\d*$/,
  /^round\d*$/,
  /^wave\d*$/,
  /^phase\d*$/,
  /^batch\d*$/,
  /^gaps$/,
  /^(bug|hot)?fix(es|ed)?\d*$/,
  /^harden(ing|ed)?$/,
  /^followups?$/,
  /^misc$/,
  /^(temp|tmp|wip|todo)$/,
  /^final$/,
  /^(new|old|more|extra)$/,
  /^issues?\d*$/,
  /^pr\d+$/,
  /^v\d+$/,
  /^rc\d+$/,
];

/** `follow-up` splits into two words, so it is matched on the whole segment. */
const FOLLOW_UP = /(^|-)follow-ups?(-|$)/;

/**
 * Paths where a process word is the product's own vocabulary. Each entry is a
 * piece of the path and the reason the word is legitimate there. Add to this
 * list only for a word a user of the product would recognise, never to let a
 * work-named file through.
 */
const ALLOWED = [
  // The audit LOG is a product surface: operators read it in the panel and in
  // the super-admin dashboard, and these suites assert what is written to it.
  ['/src/app/(authed)/audit/', 'the super-admin audit log page'],
  ['/src/app/(authed)/audit-log/', 'the operator audit log page'],
  ['/test/audit-credential-config.test.ts', 'audit log entries for credential and auth-config changes'],
  ['/test/error-contract-and-audit.test.ts', 'the error contract and the audit log'],
  // "Review" as a screen: the consent an operator reviews, and the portal page
  // where a buyer reviews a plan before paying.
  ['/src/app/mcp-consent/review/', 'the MCP consent review screen'],
  ['/src/components/plan-review.tsx', 'the plan review page'],
  ['/test/plan-review', 'the plan review page'],
  // "Issue" as a verb: issuing a checkout session.
  ['/src/modules/billing/checkout/issue.ts', 'issues a checkout session'],
  // "New" as in creating one.
  ['/src/app/(authed)/applications/new-app.tsx', 'the create-application form'],
  // A published article keeps the URL it shipped under, whatever its title says.
  ['/src/app/blog/', 'published article URLs'],
];

function words(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The process word in a path, or null when the path is named for what it holds. */
export function processWordIn(path) {
  if (!SCANNED.test(path)) return null;
  if (ALLOWED.some(([piece]) => path.includes(piece))) return null;
  for (const segment of path.split('/').slice(3)) {
    const inSegment = words(segment);
    if (FOLLOW_UP.test(inSegment.join('-'))) return 'follow-up';
    const hit = inSegment.find((word) => PROCESS_WORDS.some((p) => p.test(word)));
    if (hit) return hit;
  }
  return null;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 })
    .split('\0')
    .filter(Boolean);
}

function selfTest() {
  const refused = [
    'apps/api/test/foo-review-fixes.test.ts',
    'apps/api/test/audit-3.test.ts',
    'apps/api/test/audit-round2.test.ts',
    'apps/api/test/phase4.test.ts',
    'apps/api/test/money-v2-wire-scale.test.ts',
    'apps/api/test/session-revocation-gaps.test.ts',
    'apps/api/test/auth-hardening-operator.test.ts',
    'apps/api/src/modules/billing/checkoutFollowUp.ts',
    'apps/panel/src/lib/misc.ts',
    'packages/sdk-node/src/client-new.ts',
    'packages/cli/test/rc3-flags.test.ts',
    'apps/api/src/modules/auth/pr412/guard.ts',
  ];
  const accepted = [
    'apps/api/test/refund-records.test.ts',
    'apps/api/test/provider-amount-scale.test.ts',
    'apps/api/test/audit-credential-config.test.ts',
    'apps/api/test/checkout-preview-agreement.test.ts',
    'apps/api/src/modules/billing/routing-preview.ts',
    'apps/api/src/modules/email/custom/template-rules.ts',
    'apps/api/src/lib/prefix.ts',
    'apps/portal/test/plan-review-page.test.tsx',
    'apps/panel/src/app/(authed)/audit-log/page.tsx',
    'prisma/migrations/20261011100001_money_v2_01_plan_default_price/migration.sql',
    'docs/specs/phase-2.md',
  ];
  const wrong = [
    ...refused.filter((p) => processWordIn(p) === null).map((p) => `should be refused: ${p}`),
    ...accepted.filter((p) => processWordIn(p) !== null).map((p) => `should be accepted: ${p}`),
  ];
  if (wrong.length) {
    console.error(wrong.join('\n'));
    process.exit(1);
  }
  console.log(`check-file-names self-test: ${refused.length} refused, ${accepted.length} accepted.`);
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const files = trackedFiles();
  const named = files
    .map((path) => ({ path, word: processWordIn(path) }))
    .filter((hit) => hit.word !== null);
  for (const { path, word } of named) {
    console.error(
      `::error file=${path}::"${word}" names the work that produced this file, not what it holds. ` +
        'Rename it for the behaviour it covers; split it if it covers several. See AGENTS.md.',
    );
  }
  if (named.length) process.exit(1);
  console.log(`check-file-names: ${files.filter((f) => SCANNED.test(f)).length} paths, none named for process.`);
}

main();
