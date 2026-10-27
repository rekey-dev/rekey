/** `rekey refunds …`, through the compiled binary against the stub server. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN, paged, runCli, startStubServer, valid, type StubServer } from './helpers.js';

const APP = '/api/v1/tenant/applications/app_1';
const AUTH = `Bearer ${OPERATOR_TOKEN}`;

function refund(over: Record<string, unknown> = {}) {
  return valid('RefundDtoSchema', {
    id: 'rf_1',
    paymentId: 'pay_1',
    providerRefundId: 're_1',
    amount: 500,
    currency: 'USD',
    status: 'succeeded',
    reason: 'Duplicate charge' as string | null,
    initiatedBy: 'operator',
    createdAt: '2026-10-02T10:00:00.000Z',
    ...over,
  });
}

describe('rekey refunds', () => {
  let stub: StubServer;
  let env: Record<string, string>;

  beforeAll(async () => {
    stub = await startStubServer();
    env = { REKEY_URL: stub.url, REKEY_OPERATOR_TOKEN: OPERATOR_TOKEN };
  });

  afterAll(async () => {
    await stub.close();
  });

  it('refunds list needs an operator token with the read scope', async () => {
    stub.reset();
    const r = await runCli(['refunds', 'list', 'pay_1', '--app', 'app_1', '--json'], { REKEY_URL: stub.url });
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe('CLI_OPERATOR_TOKEN_MISSING');
    expect(error.fix).toContain('with the read scope');
    expect(stub.requests).toEqual([]);
  });

  it('refunds list prints each refund with its money formatted', async () => {
    stub.reset();
    const rows = [refund(), refund({ id: 'rf_2', paymentId: 'pay_1', amount: 500, currency: 'JPY', status: 'pending', reason: null, initiatedBy: 'provider' })];
    stub.ok(`GET ${APP}/payments/pay_1/refunds`, paged(rows));
    const text = await runCli(['refunds', 'list', 'pay_1', '--app', 'app_1'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key: `GET ${APP}/payments/pay_1/refunds`, body: undefined, auth: AUTH }]);
    expect(text.stdout).toBe(
      [
        'rf_1  $5.00  succeeded  by operator  2026-10-02T10:00:00.000Z  Duplicate charge',
        'rf_2  ¥500  pending  by provider  2026-10-02T10:00:00.000Z',
        '',
      ].join('\n'),
    );
    const json = await runCli(['refunds', 'list', 'pay_1', '--app', 'app_1', '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual({ refunds: rows, page: { total: 2, limit: 50, offset: 0, hasMore: false } });
  });

  it('refunds list without a payment id is a usage error, and PAYMENT_NOT_FOUND passes through', async () => {
    stub.reset();
    const usage = await runCli(['refunds', 'list', '--app', 'app_1', '--json'], env);
    expect((JSON.parse(usage.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');
    const error = { code: 'PAYMENT_NOT_FOUND', message: 'no such payment', fix: 'List the payments.' };
    stub.error(`GET ${APP}/payments/nope/refunds`, 404, error);
    const r = await runCli(['refunds', 'list', 'nope', '--app', 'app_1', '--json'], env);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });
});
