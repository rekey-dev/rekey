/**
 * PayPal's online signature check is sent the webhook body exactly as it
 * arrived, not a re-serialised copy (#416). PayPal signs a CRC32 of the bytes,
 * so re-serialising asked it about a body nobody sent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPaypalWebhook } from '../src/modules/billing/providers/paypal.js';

const creds = { clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-OURS' };
const headers = {
  'paypal-transmission-id': 'tid',
  'paypal-transmission-time': '2026-09-26T00:00:00Z',
  'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-transmission-sig': 'sig',
};

function stubPaypal(): string[] {
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'at' });
      return Response.json({ verification_status: 'SUCCESS' });
    }),
  );
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyPaypalWebhook', () => {
  it('embeds the raw event bytes, which re-serialising would change', async () => {
    const bodies = stubPaypal();
    const rawEvent = '{"id":"WH-EVT-1",  "event_type":"PAYMENT.SALE.COMPLETED","amount":1.0}';

    const outcome = await verifyPaypalWebhook({ creds, mode: 'test', headers, rawEvent });

    expect(outcome).toEqual({ ok: true });
    const verifyBody = bodies[1]!;
    expect(verifyBody).toContain(`"webhook_event":${rawEvent}}`);
    expect(JSON.parse(verifyBody)).toMatchObject({ webhook_id: 'WH-OURS', transmission_id: 'tid' });
  });

  it('refuses a body that is not one JSON value instead of splicing it', async () => {
    const bodies = stubPaypal();

    const outcome = await verifyPaypalWebhook({
      creds,
      mode: 'test',
      headers,
      rawEvent: '{},"webhook_id":"WH-ATTACKER"',
    });

    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
    expect(bodies).toEqual([]);
  });
});
