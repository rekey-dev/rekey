/** `rekey payments show`, through the compiled binary against the stub server. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN, runCli, startStubServer, valid, type StubServer } from './helpers.js';

const APP = '/api/v1/tenant/applications/app_1';
const AUTH = `Bearer ${OPERATOR_TOKEN}`;

function payment(over: Record<string, unknown> = {}) {
  return valid('TenantPaymentDtoSchema', {
    id: 'pay_1',
    endUserId: 'eu_1' as string | null,
    endUserEmail: 'buyer@example.com' as string | null,
    subscriptionId: 'sub_1' as string | null,
    amount: 1900,
    currency: 'USD',
    status: 'PARTIALLY_REFUNDED',
    refundedAmount: 500,
    verification: 'verified',
    provider: 'stripe' as string | null,
    refundable: true,
    refundBlockedReason: null as string | null,
    providerPaymentId: 'in_1' as string | null,
    description: null,
    createdAt: '2026-10-02T10:00:00.000Z',
    ...over,
  });
}

describe('rekey payments', () => {
  let stub: StubServer;
  let env: Record<string, string>;

  beforeAll(async () => {
    stub = await startStubServer();
    env = { REKEY_URL: stub.url, REKEY_OPERATOR_TOKEN: OPERATOR_TOKEN };
  });

  afterAll(async () => {
    await stub.close();
  });

  it('payments show needs an operator token with billing:read', async () => {
    stub.reset();
    const r = await runCli(['payments', 'show', 'pay_1', '--app', 'app_1', '--json'], { REKEY_URL: stub.url });
    expect(r.code).toBe(1);
    const { error } = JSON.parse(r.stderr) as { error: { code: string; fix: string } };
    expect(error.code).toBe('CLI_OPERATOR_TOKEN_MISSING');
    expect(error.fix).toContain('billing:read');
    expect(stub.requests).toEqual([]);
  });

  it('payments show prints the payment and that it can be refunded', async () => {
    stub.reset();
    const row = payment();
    stub.ok(`GET ${APP}/payments/pay_1`, row);
    const text = await runCli(['payments', 'show', 'pay_1', '--app', 'app_1'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(stub.requests).toEqual([{ key: `GET ${APP}/payments/pay_1`, body: undefined, auth: AUTH }]);
    expect(text.stdout).toBe(
      [
        'pay_1  $19.00  PARTIALLY_REFUNDED  verified  2026-10-02T10:00:00.000Z',
        '    refunded: $5.00 of $19.00',
        '    provider: stripe (in_1)',
        '    end user: buyer@example.com (eu_1)',
        '    subscription: sub_1',
        '    refundable: yes',
        '',
      ].join('\n'),
    );
    const json = await runCli(['payments', 'show', 'pay_1', '--app', 'app_1', '--json'], env);
    expect(JSON.parse(json.stdout)).toEqual(row);
  });

  it('payments show says why a payment cannot be refunded, in its own currency', async () => {
    stub.reset();
    stub.ok(
      `GET ${APP}/payments/pay_2`,
      payment({
        id: 'pay_2',
        endUserId: null,
        endUserEmail: null,
        subscriptionId: null,
        amount: 5000,
        currency: 'JPY',
        status: 'SUCCEEDED',
        refundedAmount: 0,
        provider: null,
        providerPaymentId: null,
        refundable: false,
        refundBlockedReason: 'no_provider_charge_id',
      }),
    );
    const text = await runCli(['payments', 'show', 'pay_2', '--app', 'app_1'], env);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toBe(
      [
        'pay_2  ¥5,000  SUCCEEDED  verified  2026-10-02T10:00:00.000Z',
        '    refunded: ¥0 of ¥5,000',
        '    provider: not recorded',
        '    end user: none',
        '    subscription: none',
        '    refundable: no (no_provider_charge_id). No provider charge id was recorded for this payment, so Rekey cannot ask anyone to refund it. Refund it in the provider dashboard.',
        '',
      ].join('\n'),
    );
  });

  it('payments show without a payment id is a usage error, and PAYMENT_NOT_FOUND passes through', async () => {
    stub.reset();
    const usage = await runCli(['payments', 'show', '--app', 'app_1', '--json'], env);
    expect((JSON.parse(usage.stderr) as { error: { code: string } }).error.code).toBe('CLI_USAGE_ERROR');
    const error = { code: 'PAYMENT_NOT_FOUND', message: 'no such payment', fix: 'List the payments.' };
    stub.error(`GET ${APP}/payments/nope`, 404, error);
    const r = await runCli(['payments', 'show', 'nope', '--app', 'app_1', '--json'], env);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({ success: false, error });
  });
});
