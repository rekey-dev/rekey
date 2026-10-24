/**
 * An end user deleting their own account: DELETE /api/v1/users/me erases them
 * the way an operator erasure does, after a step-up from a browser caller,
 * and never while a subscription is still billing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail, endUsersConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();
endUsersConfirmTheirEmail();

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;
const PASSWORD = 'pw-one-two-three';

describe('deleting your own account', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  interface Ctx {
    applicationId: string;
    publicKey: string;
    liveKey: string;
    userToken: string;
    userId: string;
    userEmail: string;
  }

  /** Admin-route bootstrap: the create response is the only place the raw
   *  publishable key and raw secret key are both handed back. */
  async function bootstrap(): Promise<Ctx> {
    const slug = `bfg-${Math.random().toString(36).slice(2, 8)}`;
    /** Surface the response body on a failed fixture call. Without this a 429 or
     *  400 here shows up as "Cannot read properties of undefined (reading 'id')"
     *  several lines later, which says nothing about the actual cause. */
    const created = <T>(res: { statusCode: number; json: () => { data?: T } }, what: string): T => {
      if (res.statusCode >= 300) {
        throw new Error(`fixture ${what} failed: ${res.statusCode} ${JSON.stringify(res.json())}`);
      }
      return res.json().data as T;
    };

    const tenant = created<{ id: string }>(
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: `T ${slug}`, ownerEmail: `op-${slug}@example.com` },
      }),
      'tenant',
    );

    const application = created<{ id: string; publicKey: string }>(
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: `A ${slug}`, slug, enableBilling: true },
      }),
      'application',
    );
    expect(application.publicKey.startsWith('rp_pub_')).toBe(true);

    // Organizations are opt-in per Application; MFA defaults to 'optional'
    // (enrollment allowed) so it needs no flip here.
    await prisma.application.update({
      where: { id: application.id },
      data: {
        authConfig: {
          methods: ['password'],
          passwordMinLength: 8,
          redirectUrls: [],
          organizationsEnabled: true,
          signupEnabled: true,
          passwordBreachCheckEnabled: false,
        } as never,
      },
    });

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/admin/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    const userEmail = `eu-${slug}@example.com`;
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${application.publicKey}` },
        payload: { email: userEmail, password: PASSWORD },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      applicationId: application.id,
      publicKey: application.publicKey,
      liveKey,
      userToken: eu.accessToken,
      userId: eu.endUser.id,
      userEmail,
    };
  }

  const del = (key: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'DELETE',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${key}`, 'x-rekey-user-token': token },
      ...(payload !== undefined && { payload }),
    });

  it('a browser caller must confirm with the password, then the account is erased and its token dies', async () => {
    const ctx = await bootstrap();
    const none = await del(ctx.publicKey, ctx.userToken);
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await del(ctx.publicKey, ctx.userToken, { password: 'wrong-password' })).json().error.code).toBe('STEP_UP_REQUIRED');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: ctx.userId } })).erasedAt).toBeNull();

    const res = await del(ctx.publicKey, ctx.userToken, { password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.erased).toBe(true);
    const row = await prisma.endUser.findUniqueOrThrow({ where: { id: ctx.userId } });
    expect(row.erasedAt).not.toBeNull();
    expect(row.email).not.toBe(ctx.userEmail);
    expect(row.erasedBy).toBe(ctx.userId);
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${ctx.publicKey}`, 'x-rekey-user-token': ctx.userToken },
    });
    expect(after.statusCode).toBe(410);
    expect(after.json().error.code).toBe('END_USER_ERASED');
  });

  it('a secret-key caller needs no step-up', async () => {
    const ctx = await bootstrap();
    const res = await del(ctx.liveKey, ctx.userToken);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the Application can keep deletion on its own server, or turn it off', async () => {
    const ctx = await bootstrap();
    const setDeletion = async (accountDeletion: string) => {
      const app_ = await prisma.application.findUniqueOrThrow({ where: { id: ctx.applicationId } });
      await prisma.application.update({
        where: { id: ctx.applicationId },
        data: { authConfig: { ...(app_.authConfig as object), accountDeletion } as never },
      });
    };

    await setDeletion('server_only');
    const browser = await del(ctx.publicKey, ctx.userToken, { password: PASSWORD });
    expect(browser.statusCode).toBe(403);
    expect(browser.json().error.code).toBe('ACCOUNT_SELF_DELETION_DISABLED');
    // Refused before any password check, so a refused Application is no oracle.
    expect((await del(ctx.publicKey, ctx.userToken, {})).json().error.code).toBe('ACCOUNT_SELF_DELETION_DISABLED');

    await setDeletion('off');
    const server = await del(ctx.liveKey, ctx.userToken);
    expect(server.statusCode).toBe(403);
    expect(server.json().error.code).toBe('ACCOUNT_SELF_DELETION_DISABLED');
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: ctx.userId } })).erasedAt).toBeNull();

    await setDeletion('server_only');
    expect((await del(ctx.liveKey, ctx.userToken)).statusCode).toBe(200);
  });

  it('is refused while a subscription is still billing through a provider, and allowed once it is set to cancel', async () => {
    const ctx = await bootstrap();
    const plan = await prisma.plan.create({
      data: { applicationId: ctx.applicationId, slug: `p-${ctx.userId.slice(-6)}`, name: 'Paid', interval: 'MONTH', active: true },
    });
    const sub = await prisma.subscription.create({
      data: {
        applicationId: ctx.applicationId,
        endUserId: ctx.userId,
        planId: plan.id,
        status: 'ACTIVE',
        provider: 'stripe',
        providerSubId: 'sub_still_billing',
      },
    });
    const refused = await del(ctx.liveKey, ctx.userToken);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ACCOUNT_HAS_ACTIVE_SUBSCRIPTION');
    await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAt: new Date(Date.now() + 86_400_000) } });
    expect((await del(ctx.liveKey, ctx.userToken)).statusCode).toBe(200);
  });
});
