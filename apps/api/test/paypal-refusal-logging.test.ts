import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPaypalOrder } from '../src/modules/billing/providers/paypal-orders.js';

const REFUSAL = {
  name: 'UNPROCESSABLE_ENTITY',
  message: 'The requested action could not be performed.',
  debug_id: 'f00dcafe1234',
  details: [{ issue: 'PAYER_ACCOUNT_LOCKED_OR_CLOSED' }],
  payer: {
    name: { given_name: 'Ada', surname: 'Lovelace' },
    email_address: 'ada@example.com',
    address: { address_line_1: '12 Analytical Row', postal_code: 'N1 9GU' },
  },
};

describe('PayPal refusal logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs a failed order read as status, debug_id, name and message only', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(REFUSAL), { status: 422 }));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(readPaypalOrder({ base: 'https://api-m.sandbox.paypal.com', token: 't' }, 'ORDER-1')).rejects.toMatchObject({
      code: 'BILLING_PROVIDER_REFUSED',
    });

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[1]).toEqual({
      status: 422,
      name: 'UNPROCESSABLE_ENTITY',
      message: 'The requested action could not be performed.',
      debugId: 'f00dcafe1234',
    });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/Ada|Lovelace|ada@example\.com|Analytical|N1 9GU/);
  });
});
