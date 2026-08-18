/**
 * Audit blind spots (BUG-3). Sensitive operator mutations must write a
 * SecurityEvent:
 *   (a) billing-credential create/update/delete → app.billing_credentials_*
 *   (b) auth-config changes incl. a tokenAlg switch → app.auth_config_updated
 *
 * (BUG-3c, the end-user plain-delete → end_user.deleted event, is covered in
 * end-user-erasure.test.ts alongside the provider-cancel behavior.)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

interface Bootstrapped {
  applicationId: string;
  tenantAccess: string;
}

describe('Audit — credential + auth-config mutations write SecurityEvents', () => {
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
        payload: { email: `op-ac-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: `App ${slug}`, slug: `ac-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    return { applicationId: application.id, tenantAccess: ts.accessToken };
  }

  /**
   * Poll until the events this assertion needs are present.
   *
   * `expectTypes` is required, and the exit condition is "every one of these
   * has arrived", not "at least one row exists". The previous version returned
   * as soon as `rows.length > 0`, so a test that performs PUT then PATCH then
   * DELETE and asserts on the LAST event returned after the FIRST one landed
   * and failed with `expected undefined to be defined` on a loaded runner.
   * These writes are fire-and-forget (`void recordSecurityEvent(...)`), so each
   * lands independently and the first arriving says nothing about the rest.
   */
  async function eventsFor(
    b: Bootstrapped,
    expectTypes: string[],
  ): Promise<Array<{ type: string; applicationId: string | null; metadata: unknown }>> {
    const deadline = Date.now() + 5000;
    let rows: Array<{ type: string; applicationId: string | null; metadata: unknown }> = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const log = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/security-events',
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      rows = (log.json().data as { items: typeof rows }).items;
      const mine = rows.filter((r) => r.applicationId === b.applicationId);
      const haveAll = expectTypes.every((t) => mine.some((r) => r.type === t));
      // Deadline still returns what we have, so the assertion below reports the
      // missing event rather than a timeout with no detail.
      if (haveAll || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('billing-credential upsert (PUT) records app.billing_credentials_updated', async () => {
    const b = await bootstrap('cred-put');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { data: { apiKey: 'sk_test_abc123', webhookSecret: 'whsec_x' } },
    });
    expect(res.statusCode).toBe(200);

    const events = await eventsFor(b, ['app.billing_credentials_updated']);
    const e = events.find((x) => x.type === 'app.billing_credentials_updated' && x.applicationId === b.applicationId);
    expect(e).toBeDefined();
    expect((e!.metadata as { provider: string; action: string }).provider).toBe('stripe');
    expect((e!.metadata as { action: string }).action).toBe('upsert');
  });

  it('billing-credential PATCH + DELETE record updated then deleted events', async () => {
    const b = await bootstrap('cred-patch-del');
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { data: { apiKey: 'sk_test_abc123', webhookSecret: 'whsec_x' } },
    });
    expect(
      (await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { enabled: false },
      })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      })).statusCode,
    ).toBe(200);

    const events = await eventsFor(b, [
      'app.billing_credentials_updated',
      'app.billing_credentials_deleted',
    ]);
    expect(events.some((e) => e.type === 'app.billing_credentials_updated' && e.applicationId === b.applicationId)).toBe(true);
    const del = events.find((e) => e.type === 'app.billing_credentials_deleted' && e.applicationId === b.applicationId);
    expect(del).toBeDefined();
    expect((del!.metadata as { provider: string }).provider).toBe('stripe');
  });

  it('auth-config PATCH (incl. tokenAlg switch) records app.auth_config_updated', async () => {
    const b = await bootstrap('authcfg');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { tokenAlg: 'RS256', signupEnabled: false },
    });
    expect(res.statusCode).toBe(200);

    const events = await eventsFor(b, ['app.auth_config_updated']);
    const e = events.find((x) => x.type === 'app.auth_config_updated' && x.applicationId === b.applicationId);
    expect(e).toBeDefined();
    expect((e!.metadata as { tokenAlg: string }).tokenAlg).toBe('RS256');
    expect((e!.metadata as { changed: string[] }).changed).toContain('tokenAlg');
    expect((e!.metadata as { changed: string[] }).changed).toContain('signupEnabled');
  });
});
