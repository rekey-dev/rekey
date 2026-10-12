/**
 * Runs the money checks of `rekey doctor`: reads each Application's plans,
 * providers, coupons, unapplied payments, billing stats and reconciliation
 * report with the operator token, and the billing outbox with the super-admin
 * key. Read-only requests, all of them.
 */

import type {
  ApplicationDto,
  BillingCredentialDto,
  BillingStatsDto,
  CouponWithStatsDto,
  Paged,
  PlanDto,
  ReconciliationReport,
  BillingOutboxStatus,
} from '@rekey.dev/node';
import { MAX_LIST_LIMIT, callApi, type ApiError, type ApiResult } from '../../lib/api.js';
import { appPath } from '../../lib/input.js';
import type { Check, Finding } from './check.js';
import {
  billingOutboxCheck,
  couponCoverageCheck,
  planCurrenciesCheck,
  priceProvidersCheck,
  providerCurrenciesCheck,
  reconciliationCheck,
  unappliedPaymentsCheck,
  unpricedSubscriptionsCheck,
  type UnappliedPaymentRow,
} from './money-checks.js';

/** The checks made once per Application, in the order they are reported. */
export const APPLICATION_CHECKS = [
  'plan-currencies',
  'provider-currencies',
  'price-providers',
  'coupon-coverage',
  'unapplied-payments',
  'unpriced-subscriptions',
  'reconciliation',
] as const;
type ApplicationCheck = (typeof APPLICATION_CHECKS)[number];

const OUTBOX = 'billing-outbox';

/** Pages read per list before a check works with what it has. 50 pages of 100 rows. */
const MAX_PAGES = 50;

const TOKEN_FIX =
  'Set REKEY_OPERATOR_TOKEN (or pass --operator-token) to an operator personal access token with the billing:read scope. Create one in the panel under Account, API tokens.';
const SCOPE_FIX =
  'The operator token is not allowed this read. Use a token with the billing:read scope whose workspace membership can read this Application.';
const ADMIN_KEY_FIX =
  'Set SUPER_ADMIN_KEY (or pass --admin-key) to check the billing outbox. Only whoever runs the deployment holds it; a Rekey Cloud workspace has none.';

export interface MoneyCheckInput {
  apiUrl: string;
  operatorToken: string | undefined;
  adminKey: string | undefined;
  /** Check this Application only. Left out, every Application the token can see. */
  applicationId: string | undefined;
  now: Date;
}

interface AllRows<T> {
  items: T[];
  total: number;
}

async function allPages<T>(apiUrl: string, token: string, path: string): Promise<ApiResult<AllRows<T>>> {
  const items: T[] = [];
  const joiner = path.includes('?') ? '&' : '?';
  for (let pageNumber = 0; ; pageNumber++) {
    const page = await callApi<Paged<T>>(apiUrl, token, {
      method: 'GET',
      path: `${path}${joiner}limit=${MAX_LIST_LIMIT}&offset=${pageNumber * MAX_LIST_LIMIT}`,
    });
    if (!page.ok) return page;
    items.push(...page.data.items);
    if (!page.data.page.hasMore || pageNumber + 1 >= MAX_PAGES) return { ok: true, data: { items, total: page.data.page.total } };
  }
}

/** A check whose rows could not be read: skipped when the token may not read them, failed otherwise. */
function unread(what: string, failure: { status: number; error: ApiError }): Finding {
  if (failure.status === 403) {
    return { status: 'skipped', message: `not checked: ${failure.error.code} reading ${what}`, fix: SCOPE_FIX };
  }
  return {
    status: 'fail',
    message: `Could not read ${what}: ${failure.error.code}: ${failure.error.message}`,
    fix: failure.error.fix ?? 'Check the Rekey API logs for this request.',
  };
}

/** The finding of a check over rows that were read, or why they could not be. */
function ifRead<T>(what: string, result: ApiResult<T>, check: (data: T) => Finding): Finding {
  return result.ok ? check(result.data) : unread(what, result);
}

async function checkApplication(input: MoneyCheckInput, token: string, applicationId: string): Promise<Check[]> {
  const read = <T>(rest: string) => allPages<T>(input.apiUrl, token, appPath(applicationId, rest));
  const one = <T>(rest: string) => callApi<T>(input.apiUrl, token, { method: 'GET', path: appPath(applicationId, rest) });
  const [plans, credentials, coupons, unapplied, stats, reconciliation] = await Promise.all([
    read<PlanDto>('/plans'),
    one<BillingCredentialDto[]>('/billing-credentials'),
    read<CouponWithStatsDto>('/coupons'),
    read<UnappliedPaymentRow>('/unapplied-payments?status=OPEN'),
    one<BillingStatsDto>('/billing/stats'),
    one<ReconciliationReport>('/billing/reconciliation'),
  ]);
  const withPlans = (check: (rows: PlanDto[]) => Finding) => ifRead('the plans', plans, (page) => check(page.items));
  const withProviders = (check: (rows: BillingCredentialDto[]) => Finding) => ifRead('the billing providers', credentials, check);

  const findings: Record<ApplicationCheck, Finding> = {
    'plan-currencies': withPlans((rows) => planCurrenciesCheck(applicationId, rows)),
    'provider-currencies': withProviders(providerCurrenciesCheck),
    'price-providers': withPlans((rows) => withProviders((providers) => priceProvidersCheck(applicationId, rows, providers))),
    'coupon-coverage': withPlans((rows) =>
      ifRead('the coupons', coupons, (page) => couponCoverageCheck(applicationId, page.items, rows, input.now)),
    ),
    'unapplied-payments': ifRead('the unapplied payments', unapplied, (page) =>
      unappliedPaymentsCheck(applicationId, page.items, page.total),
    ),
    'unpriced-subscriptions': ifRead('the billing stats', stats, (data) => unpricedSubscriptionsCheck(applicationId, data)),
    reconciliation: ifRead('the reconciliation report', reconciliation, (report) => reconciliationCheck(applicationId, report)),
  };
  return APPLICATION_CHECKS.map((name) => ({ name, ...findings[name], applicationId }));
}

async function outboxCheck(input: MoneyCheckInput): Promise<Check> {
  if (!input.adminKey) {
    return { name: OUTBOX, status: 'skipped', message: 'not checked: it needs the super-admin key', fix: ADMIN_KEY_FIX };
  }
  const status = await callApi<BillingOutboxStatus>(input.apiUrl, input.adminKey, {
    method: 'GET',
    path: '/api/v1/admin/metrics/billing-outbox',
  });
  if (status.ok) return { name: OUTBOX, ...billingOutboxCheck(status.data) };
  return {
    name: OUTBOX,
    status: 'fail',
    message: `Could not read the billing outbox: ${status.error.code}: ${status.error.message}`,
    fix: status.error.fix ?? 'Check SUPER_ADMIN_KEY and the Rekey API logs.',
  };
}

/** Every money check as `skipped`, for a run that cannot make them. */
export function skippedMoneyChecks(message: string, fix: string): Check[] {
  return [...APPLICATION_CHECKS, OUTBOX].map((name) => ({ name, status: 'skipped', message, fix }));
}

/**
 * The money checks of one run.
 *
 * @example
 * const checks = await runMoneyChecks({ apiUrl, operatorToken, adminKey, applicationId: undefined, now: new Date() });
 */
export async function runMoneyChecks(input: MoneyCheckInput): Promise<Check[]> {
  const outbox = await outboxCheck(input);
  const token = input.operatorToken;
  if (!token) {
    const skipped = skippedMoneyChecks('not checked: no operator token', TOKEN_FIX).filter((check) => check.name !== OUTBOX);
    return [...skipped, outbox];
  }

  const checks: Check[] = [];
  let applicationIds: string[];
  if (input.applicationId !== undefined) {
    applicationIds = [input.applicationId];
  } else {
    const applications = await allPages<ApplicationDto>(input.apiUrl, token, '/api/v1/tenant/applications');
    if (!applications.ok) {
      return [
        {
          name: 'applications',
          status: 'fail',
          message: `Could not list the Applications the operator token can see: ${applications.error.code}: ${applications.error.message}`,
          fix: applications.error.fix ?? TOKEN_FIX,
        },
        outbox,
      ];
    }
    applicationIds = applications.data.items.map((application) => application.id);
    checks.push({
      name: 'applications',
      status: 'ok',
      message: `the operator token sees ${applicationIds.length} Application${applicationIds.length === 1 ? '' : 's'}`,
    });
  }

  for (const applicationId of applicationIds) checks.push(...(await checkApplication(input, token, applicationId)));
  checks.push(outbox);
  return checks;
}
