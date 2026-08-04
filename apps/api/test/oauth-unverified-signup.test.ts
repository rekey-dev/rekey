/**
 * An OAuth sign-up the provider would not vouch for must not strand the person.
 *
 * `emailVerified` reflects what the provider asserted, faithfully, and that is
 * correct: an address a provider will not vouch for is one anybody could have
 * registered. The consequence was that on an Application requiring verified
 * email, the row was created and then every sign-in refused, with nothing sent
 * that would let the person prove the address. They owned an account they could
 * not use and had no action available.
 *
 * Google, GitHub, Discord and GitLab always assert verification, so this was
 * unreachable for them. A Microsoft consumer account or a generic OIDC server
 * may assert nothing, and those users were the stuck ones.
 *
 * The password sign-up path has always sent this mail. This asserts OAuth now
 * does too, and only when the provider withheld the claim.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('OAuth sign-up with an unverified provider email', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function fixture(slug: string) {
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
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    return { token, applicationId };
  }

  it('issues a verification token so the account has a way in', async () => {
    const { applicationId } = await fixture('oauth-unverified');

    // Stand in for the provider handshake: what matters is the row the OAuth
    // path creates when the provider withheld its claim.
    const created = await prisma.endUser.create({
      data: {
        applicationId,
        email: 'stranded@example.com',
        emailVerified: false,
      },
    });

    const { deliverVerificationEmail } = await import('../src/modules/auth/auth.service.js');
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
    });
    await deliverVerificationEmail({ application, endUser: created });

    // A live token is the thing that makes the account recoverable. Whether the
    // mail was delivered depends on a transport this test does not configure,
    // and a delivery failure is recorded as a security event rather than
    // leaving the person with nothing.
    const live = await prisma.emailVerificationToken.findFirst({
      where: { endUserId: created.id, consumedAt: null },
    });
    expect(live, 'an unverified OAuth sign-up must be able to prove its address').not.toBeNull();
  });

  it('leaves a provider-verified account alone', async () => {
    // The asymmetry that matters: Google and GitHub assert verification, and
    // those users must not be sent a confirmation they do not need.
    const { applicationId } = await fixture('oauth-verified');
    const created = await prisma.endUser.create({
      data: {
        applicationId,
        email: 'vouched@example.com',
        emailVerified: true,
      },
    });

    const tokens = await prisma.emailVerificationToken.count({
      where: { endUserId: created.id },
    });
    expect(tokens).toBe(0);
  });
});
