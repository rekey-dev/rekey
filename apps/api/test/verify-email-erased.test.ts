/**
 * A GDPR-erased end-user cannot be verified back into existence.
 *
 * `resendVerificationEmail` has always short-circuited on `erasedAt`, but
 * `verifyEmail` did not — so a token minted BEFORE the erasure stayed
 * redeemable after it. Redeeming flipped `emailVerified: true`, emitted an
 * `email.verified` webhook about a record that is supposed to be erased, and
 * answered `{ ok: true }`. The person was told "Email confirmed", and then
 * every sign-in was refused by `assertEndUserNotErased` at the session
 * chokepoint. The success was a lie and the write should never have happened.
 *
 * Only the SOFT erasure path was affected. A hard-deleted row takes its tokens
 * with it — `EmailVerificationToken.endUser` is `onDelete: Cascade` — so the
 * lookup misses and the caller already gets EMAIL_VERIFICATION_TOKEN_INVALID.
 * That asymmetry is why this went unnoticed: the obvious test case was fine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

// A caller-supplied verify link must sit on an origin the Application declared —
// the route takes a publishable key, so an unregistered destination is refused.
const VERIFY_ORIGIN = 'https://example.com';

describe('verifyEmail refuses an erased end-user', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** An Application, an unverified end-user, and a live verification token. */
  async function fixture(slug: string) {
    const tenantToken = await app
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
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    // Register the origin the verify link points at. MERGED into the existing
    // authConfig — replacing it wholesale drops the enabled sign-in methods and
    // the fixture's own sign-up then fails.
    const existing = await prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { authConfig: true },
    });
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        authConfig: {
          ...((existing.authConfig as Record<string, unknown>) ?? {}),
          appUrl: VERIFY_ORIGIN,
        },
      },
    });

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: 'k', mode: 'live', scopes: ['auth:write'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    const endUserId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => (r.json().data as { endUser: { id: string } }).endUser.id);

    // The token is minted while the account is live — the whole point is that
    // it predates the erasure.
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/resend-verification',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: {
          email: `eu-${slug}@example.com`,
          verifyUrl: `${VERIFY_ORIGIN}/verify?token={token}`,
        },
      })
      .then((r) => (r.json().data as { verificationToken: string | null }).verificationToken);

    return { liveKey, applicationId, endUserId, token };
  }

  it('refuses with END_USER_ERASED and does not flip emailVerified', async () => {
    const { liveKey, endUserId, token } = await fixture('vfe-erased');
    expect(token, 'fixture did not mint a token').toBeTruthy();

    // Soft erasure — the tombstone an operator sets on a data-subject request.
    await prisma.endUser.update({
      where: { id: endUserId },
      data: { erasedAt: new Date(), erasedBy: 'test' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { token },
    });

    // 410 Gone, the same terminal answer the authenticate paths give.
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('END_USER_ERASED');

    const row = await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } });
    expect(row.emailVerified, 'an erased record must not be written to').toBe(false);
  });

  it('does not burn the token, because the refusal comes before consumption', async () => {
    // Ordering matters and is easy to get wrong: refusing *after*
    // `consumeVerificationToken` would leave the token spent, so a later
    // un-erasure could not be followed by a normal verification.
    const { liveKey, endUserId, token } = await fixture('vfe-order');
    await prisma.endUser.update({
      where: { id: endUserId },
      data: { erasedAt: new Date(), erasedBy: 'test' },
    });

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { token },
    });

    const stillLive = await prisma.emailVerificationToken.findFirst({
      where: { endUserId, consumedAt: null },
    });
    expect(stillLive, 'the token should still be unspent').not.toBeNull();
  });

  it('still verifies a normal, un-erased account', async () => {
    // The control. A guard that refuses everything would pass the two tests
    // above and break the product.
    const { liveKey, endUserId, token } = await fixture('vfe-ok');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { token },
    });

    expect(res.statusCode).toBeLessThan(300);
    const row = await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } });
    expect(row.emailVerified).toBe(true);
  });
});
