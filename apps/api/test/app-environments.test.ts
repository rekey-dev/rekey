/**
 * Application environments — the replacement for the old test/live DataMode.
 *
 * Three properties are worth defending in tests, because each one is a place
 * where the old design silently did the wrong thing:
 *
 *   1. New applications are DEVELOPMENT. Least privilege: nobody gets a
 *      production-grade app by forgetting to say so.
 *   2. The environment moves through exactly ONE door. Since 2026-08-20 it is
 *      no longer immutable: POST /:id/promote raises DEVELOPMENT/STAGING to
 *      PRODUCTION, once, one-way. What these tests defend is that promote is
 *      the ONLY door — no config route accepts the field, and nothing moves an
 *      Application back down. See lifecycle behaviour in
 *      app-lifecycle.test.ts; what is tested here is that every OTHER route
 *      still refuses.
 *   3. Environment does NOT constrain billing credentials — any app may hold
 *      live keys. What is enforced is that the recorded `mode` cannot
 *      contradict the key material, so the label never lies about the key.
 *
 * Plus the removal of the stub: an application with no billing credentials
 * refuses checkout instead of pretending one happened.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const PASSWORD = 'correct-horse-battery';

describe('Application environments', () => {
  let app: FastifyInstance;
  let operator: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'env-op@example.com', password: PASSWORD, workspaceName: 'Env WS' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
  });

  const createApp = (
    slug: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; environment: string }> =>
    app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: slug, slug, enableBilling: true, ...body },
      })
      .then((r) => r.json().data as { id: string; environment: string });

  const mintKey = (appId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/api-keys`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { name: 'k' },
    });

  /**
   * `key` and `mode` are separate arguments on purpose: the whole point of the
   * tests below is what happens when the label disagrees with the credential.
   * A helper that derived one from the other could only ever prove that a
   * self-consistent pair is accepted.
   */
  const putStripeCreds = (appId: string, key: 'test' | 'live', mode?: 'test' | 'live') =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${operator}` },
      payload: {
        data: {
          apiKey: key === 'live' ? 'sk_live_ci_only' : 'sk_test_ci_only',
          webhookSecret: 'whsec_ci_only',
        },
        ...(mode !== undefined && { mode }),
      },
    });

  const putRazorpayCreds = (appId: string, key: 'test' | 'live', mode?: 'test' | 'live') =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/billing-credentials/razorpay`,
      headers: { authorization: `Bearer ${operator}` },
      payload: {
        data: {
          keyId: key === 'live' ? 'rzp_live_ci_only' : 'rzp_test_ci_only',
          keySecret: 'ci_only',
          webhookSecret: 'ci_only',
        },
        ...(mode !== undefined && { mode }),
      },
    });

  it('a new Application is DEVELOPMENT unless it says otherwise', async () => {
    expect((await createApp('env-default')).environment).toBe('DEVELOPMENT');
    expect((await createApp('env-prod', { environment: 'PRODUCTION' })).environment).toBe(
      'PRODUCTION',
    );
    expect((await createApp('env-stage', { environment: 'STAGING' })).environment).toBe('STAGING');
  });

  it('the key prefix follows the environment and is not selectable', async () => {
    const dev = await createApp('env-keys-dev');
    const prod = await createApp('env-keys-prod', { environment: 'PRODUCTION' });

    const devKey = await mintKey(dev.id);
    expect(devKey.statusCode).toBe(201);
    expect((devKey.json().data as { rawKey: string }).rawKey).toMatch(/^rp_test_/);

    const prodKey = await mintKey(prod.id);
    expect(prodKey.statusCode).toBe(201);
    expect((prodKey.json().data as { rawKey: string }).rawKey).toMatch(/^rp_live_/);
  });

  // Promote is the only door into PRODUCTION, and this is the standing check
  // that it stays the only one. Every route swept below must keep ignoring the
  // field: if a future config route starts accepting it, the last assertion
  // here fails. (`promote` itself is covered in app-lifecycle.test.ts — the
  // point of this test is everything that must NOT work.)
  it('environment cannot be changed by any route except promote', async () => {
    const a = await createApp('env-immutable');
    expect(a.environment).toBe('DEVELOPMENT');

    // The old PATCH /environment endpoint is gone, not merely restricted.
    // Promotion is a POST to /promote with its own preconditions; a general
    // "set the environment to whatever I say" route has never come back, and
    // in particular there is still no way to ask for DEVELOPMENT.
    const gone = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${a.id}/environment`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { environment: 'PRODUCTION' },
    });
    expect(gone.statusCode).toBe(404);

    // And no other application-update surface will take the field either —
    // each writes an explicit column whitelist, so an extra key is ignored
    // rather than applied. Sweep the ones that exist today.
    const smuggle = async (path: string, payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${a.id}${path}`,
        headers: { authorization: `Bearer ${operator}` },
        payload: { ...payload, environment: 'PRODUCTION' },
      });
    await smuggle('/auth-config', { passwordMinLength: 10 });
    await smuggle('/billing-config', { enabled: true });
    await smuggle('/portal', { enabled: true });
    await smuggle('/access', { corsOrigins: ['https://example.com'] });

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${a.id}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect((after.json().data as { environment: string }).environment).toBe('DEVELOPMENT');
    // Still a development app, so still minting test-prefixed keys.
    expect((await mintKey(a.id)).json().data.rawKey).toMatch(/^rp_test_/);
  });

  it('a PRODUCTION application is production from birth', async () => {
    const prod = await createApp('env-born-prod', { environment: 'PRODUCTION' });
    expect(prod.environment).toBe('PRODUCTION');
    expect((await mintKey(prod.id)).json().data.rawKey).toMatch(/^rp_live_/);
    // ...and it takes live credentials immediately, with no promotion step.
    expect((await putStripeCreds(prod.id, 'live')).statusCode).toBe(200);
  });

  it('a non-production Application MAY store live billing credentials', async () => {
    // Deliberately testing against a live processor is a real workflow, and it
    // is the operator's own processor account. Environment does not gate this;
    // abuse of non-production apps is a quota/rate-limit concern instead.
    const dev = await createApp('env-creds-dev');

    expect((await putStripeCreds(dev.id, 'live', 'live')).statusCode).toBe(200);
    expect((await putStripeCreds(dev.id, 'test', 'test')).statusCode).toBe(200);
  });

  it('a PRODUCTION Application MAY store test billing credentials', async () => {
    const prod = await createApp('env-creds-prod', { environment: 'PRODUCTION' });

    expect((await putStripeCreds(prod.id, 'test', 'test')).statusCode).toBe(200);
    expect((await putStripeCreds(prod.id, 'live', 'live')).statusCode).toBe(200);
  });

  // ---- The label must never be able to launder a live key ----
  //
  // Environment no longer gates which credentials may be stored, but the
  // stored `mode` must still not be a LIE. The provider SDK authenticates with
  // the KEY and ignores this column, so a live key labelled `test` would make
  // the panel, revenue stats and dunning all report something false about the
  // operator's own money. Assert the refusal per provider that can tell, in
  // both directions.

  it('a live Stripe key labelled mode:test is refused on a DEVELOPMENT app', async () => {
    const dev = await createApp('env-launder-stripe');

    const res = await putStripeCreds(dev.id, 'live', 'test');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_MODE_CONTRADICTED');

    // And nothing was stored — the refusal is not a warning.
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${dev.id}/billing-credentials`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(list.json().data).toEqual([]);
  });

  it('a live Razorpay key labelled mode:test is refused on a DEVELOPMENT app', async () => {
    const dev = await createApp('env-launder-rzp');
    const res = await putRazorpayCreds(dev.id, 'live', 'test');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_MODE_CONTRADICTED');
  });

  it('a test key labelled mode:live is refused too — the key decides, both ways', async () => {
    const prod = await createApp('env-launder-back', { environment: 'PRODUCTION' });
    const res = await putStripeCreds(prod.id, 'test', 'live');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_MODE_CONTRADICTED');
  });

  it('with no mode supplied the key alone decides', async () => {
    const dev = await createApp('env-detect-dev');
    // sk_live_ with no label: detected live, stored as live even on DEVELOPMENT.
    expect((await putStripeCreds(dev.id, 'live')).statusCode).toBe(200);
    const listLive = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${dev.id}/billing-credentials`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(listLive.json().data[0].mode).toBe('live');
  });

  it('PATCH .../billing-credentials/:provider cannot relabel a stored key either', async () => {
    const dev = await createApp('env-relabel');
    expect((await putStripeCreds(dev.id, 'test')).statusCode).toBe(200);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${dev.id}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { mode: 'live' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_MODE_CONTRADICTED');
  });

  it('checkout without billing credentials refuses instead of stubbing', async () => {
    const a = await createApp('env-no-creds');
    const key = (await mintKey(a.id)).json().data.rawKey as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${a.id}/plans`,
      headers: { authorization: `Bearer ${operator}` },
      payload: { slug: 'pro', name: 'Pro', amount: 1000, interval: 'MONTH' },
    });
    const userToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key}` },
        payload: { email: 'env-eu@example.com', password: PASSWORD },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${key}`, 'x-rekey-user-token': userToken },
      payload: {
        planSlug: 'pro',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/no',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
  });
});
