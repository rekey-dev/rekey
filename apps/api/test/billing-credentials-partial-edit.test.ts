/**
 * Editing a provider's non-secret fields without retyping its secrets.
 *
 * Stored credentials are encrypted and never returned to the panel, so the edit
 * form renders secret inputs empty. Submitting that form used to send an empty
 * secret, which the validator rejected: the practical effect was that changing
 * a webhook URL meant going back to the provider dashboard for the API key.
 *
 * A blank SECRET on an already-configured provider now means "leave it as it
 * is". The three limits that keep this from being a hole are each pinned below:
 * it only applies when a credential row exists, only to fields the module marks
 * secret, and the merged result still faces the full pattern/required check.
 *
 * The stored secret is never returned by any endpoint, so these tests prove the
 * carry-forward happened by its EFFECT: the provider keeps working, and a later
 * read of the credential row still decrypts to the original key.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { decryptJson } from '../src/lib/secrets.js';

interface Bootstrapped {
  applicationId: string;
  tenantAccess: string;
}

describe('Billing credentials: partial edit keeps the stored secret', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const ts = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-bcpe-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: `App ${slug}`, slug: `bcpe-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    return { applicationId: application.id, tenantAccess: ts.accessToken };
  }

  function put(
    b: Bootstrapped,
    data: Record<string, string>,
    extra: Record<string, unknown> = {},
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { data, ...extra },
    });
  }

  /** Read the stored secret straight from the row. Nothing exposes it over HTTP. */
  async function storedApiKey(applicationId: string): Promise<string | undefined> {
    const row = await prisma.billingCredentials.findUniqueOrThrow({
      where: { applicationId_provider: { applicationId, provider: 'stripe' } },
      select: { ciphertext: true },
    });
    return decryptJson<Record<string, string>>(row.ciphertext).apiKey;
  }

  it('keeps the stored API key when the edit omits it', async () => {
    const b = await bootstrap('keep');
    expect((await put(b, { apiKey: 'sk_test_original_key', webhookSecret: 'whsec_one' })).statusCode).toBe(200);

    // The edit an operator actually makes: change the webhook secret and send
    // only that. The omitted key keeps its stored value.
    const res = await put(b, { webhookSecret: 'whsec_two' });
    expect(res.statusCode).toBe(200);

    expect(await storedApiKey(b.applicationId)).toBe('sk_test_original_key');
    const row = await prisma.billingCredentials.findUniqueOrThrow({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'stripe' } },
      select: { ciphertext: true },
    });
    expect(decryptJson<Record<string, string>>(row.ciphertext).webhookSecret).toBe('whsec_two');
  });

  it('a PRESENT but empty optional field still clears it', async () => {
    const b = await bootstrap('clear');
    await put(b, { apiKey: 'sk_test_original_key', webhookSecret: 'whsec_one' });

    // Blanking an optional field is how a signing secret has always been
    // dropped. Absence means keep; empty means clear. Collapsing the two would
    // remove the only way to clear one.
    const res = await put(b, { apiKey: 'sk_test_original_key', webhookSecret: '' });
    expect(res.statusCode).toBe(200);
    const row = await prisma.billingCredentials.findUniqueOrThrow({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'stripe' } },
      select: { ciphertext: true },
    });
    expect(decryptJson<Record<string, string>>(row.ciphertext).webhookSecret).toBe('');
  });

  it('still rotates the key when a new one is actually supplied', async () => {
    const b = await bootstrap('rotate');
    await put(b, { apiKey: 'sk_test_original_key', webhookSecret: 'whsec_one' });

    const res = await put(b, { apiKey: 'sk_test_rotated_key', webhookSecret: 'whsec_one' });
    expect(res.statusCode).toBe(200);
    // The carry-forward must not shadow a real rotation.
    expect(await storedApiKey(b.applicationId)).toBe('sk_test_rotated_key');
  });

  it('refuses a missing required field on FIRST configuration', async () => {
    const b = await bootstrap('first');
    const res = await put(b, { webhookSecret: 'whsec_one' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_INVALID');

    const row = await prisma.billingCredentials.findUnique({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'stripe' } },
    });
    expect(row).toBeNull();
  });

  it('a carried-forward key is still pattern-checked, not waved through', async () => {
    const b = await bootstrap('pattern');
    await put(b, { apiKey: 'sk_test_original_key', webhookSecret: 'whsec_one' });
    // Plant a stored value that no longer satisfies the provider's prefix rule,
    // as an encryption-key rotation or a hand-edited row could. The merge must
    // not become a way to keep an invalid credential alive.
    const { encryptJson } = await import('../src/lib/secrets.js');
    await prisma.billingCredentials.update({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'stripe' } },
      data: { ciphertext: encryptJson({ apiKey: 'not_a_stripe_key', webhookSecret: 'whsec_one' }) },
    });

    const res = await put(b, { webhookSecret: 'whsec_four' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_INVALID');
  });

  it('a partial edit does not relabel a live account as sandbox', async () => {
    const b = await bootstrap('mode');
    // PayPal has no `detectMode`, so the stored mode is the ONLY record of
    // which environment these credentials belong to. An edit that omits `mode`
    // used to fall back to 'test' and point every call at the sandbox host,
    // turning a one-field edit into a total payments outage.
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/paypal`,
          headers: { authorization: `Bearer ${b.tenantAccess}` },
          payload: {
            data: { clientId: 'live-client-id', clientSecret: 'live-client-secret', webhookId: 'WH-123' },
            mode: 'live',
          },
        })
      ).statusCode,
    ).toBe(200);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/paypal`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { data: { clientId: 'live-client-id-v2' } },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.billingCredentials.findUniqueOrThrow({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'paypal' } },
      select: { mode: true, ciphertext: true },
    });
    expect(row.mode).toBe('live');
    const creds = decryptJson<Record<string, string>>(row.ciphertext);
    expect(creds.clientSecret).toBe('live-client-secret');
    // And the non-secret optional field survives too: losing it 503s every
    // inbound PayPal webhook.
    expect(creds.webhookId).toBe('WH-123');
  });

  it('does not carry anything into a different application', async () => {
    const a = await bootstrap('iso-a');
    const c = await bootstrap('iso-b');
    await put(a, { apiKey: 'sk_test_original_key', webhookSecret: 'whsec_one' });

    // `c` has no stripe row of its own, so an omitted key has nothing to
    // inherit and must be refused rather than picking up a neighbour's.
    const res = await put(c, { webhookSecret: 'whsec_one' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_INVALID');
  });
});
