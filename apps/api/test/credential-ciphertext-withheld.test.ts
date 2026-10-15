/**
 * The Application detail and list responses never carry the encrypted
 * credential columns, for any reader including a read-only APP_VIEWER.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

describe('encrypted credentials in Application responses', () => {
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
  describe('encrypted credential blobs never leave the API', () => {
    const SECRET_COLUMNS = [
      'oauthCredentialsCiphertext',
      'emailCredentialsCiphertext',
      'billingCredentialsCiphertext',
    ];

    it('are absent from the Application list response', async () => {
      const { token } = await fixture('cipher-list');
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      // `{items, page}` since 2.0.0-rc.3, every list endpoint returns the
      // envelope, so the rows live under `items`.
      const { items: rows, page } = res.json().data as {
        items: Array<Record<string, unknown>>;
        page: { total: number };
      };
      expect(rows.length).toBeGreaterThan(0);
      // The fixture creates one Application; if `total` ever exceeded the
      // window, this test would be checking a subset of the rows it claims to.
      expect(page.total).toBe(rows.length);
      for (const row of rows) {
        for (const column of SECRET_COLUMNS) {
          expect(row, `${column} is being served in the list`).not.toHaveProperty(column);
        }
      }
    });

    it('the whole response body contains no ciphertext column name', async () => {
      // A blunt backstop: the two assertions above check the top level, and a
      // future nested `application: {...}` would slip past them.
      const { token, applicationId } = await fixture('cipher-raw');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      for (const column of SECRET_COLUMNS) {
        expect(res.body).not.toContain(column);
      }
    });
  });
});
