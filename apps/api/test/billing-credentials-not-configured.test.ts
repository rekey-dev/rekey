/**
 * PATCH and DELETE on billing credentials that were never stored answer 404
 * BILLING_CREDENTIALS_NOT_CONFIGURED, not a 500 from the missing row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('billing credentials that are not configured', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Per-test: `test/setup.ts` truncates every domain table in beforeEach. */
  async function fixture(slug: string): Promise<{ token: string; applicationId: string }> {
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    return { token, applicationId };
  }
  describe('billing credentials that were never stored', () => {
    it('DELETE answers 404, not 500', async () => {
      const { token, applicationId } = await fixture('bc-del');
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${applicationId}/billing-credentials/stripe`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
    });
  });
});
