/**
 * A SEATS licence never issues more activations than it has seats, however
 * many machines verify at once, and a machine that already holds a seat never
 * takes a second one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
  userId: string;
  userAccess: string;
}

describe('licence seats under concurrent verifies', () => {
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
          email: `op-a2-${slug}@example.com`,
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
        payload: { name: `App ${slug}`, slug: `a2-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${ts.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `eu-a2-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then(
        (r) =>
          r.json().data as {
            accessToken: string;
            endUser: { id: string };
          },
      );
    await configureSandboxStripe(application.id);
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: ts.accessToken,
      userId: eu.endUser.id,
      userAccess: eu.accessToken,
    };
  }

  it('license SEATS verify is atomic: N parallel calls on a 2-seat license issue at most 2 activations', async () => {
    const b = await bootstrap('seats');
    const { licensesService } = await import('../src/modules/licenses/licenses.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: b.userId } });
    const issued = await licensesService.issue({
      application,
      endUser,
      kind: 'SEATS',
      seatsAllowed: 2,
    });

    // Fire 10 verifies for 10 different machines in parallel.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        licensesService.verify({
          applicationId: b.applicationId,
          rawKey: issued.rawKey,
          machineFingerprint: `machine-${i}`,
        }),
      ),
    );
    const allowed = results.filter((r) => r.ok).length;
    const exhausted = results.filter((r) => !r.ok && r.reason === 'seats_exhausted').length;
    expect(allowed + exhausted).toBe(10);
    expect(allowed).toBeLessThanOrEqual(2);
    expect(exhausted).toBeGreaterThanOrEqual(8);

    const actualActivations = await prisma.licenseActivation.count({
      where: { licenseId: (issued.license as { id: string }).id },
    });
    expect(actualActivations).toBeLessThanOrEqual(2);
  });

  it('license verify from a previously-active machine never consumes a new seat', async () => {
    const b = await bootstrap('seats-repeat');
    const { licensesService } = await import('../src/modules/licenses/licenses.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: b.userId } });
    const issued = await licensesService.issue({
      application,
      endUser,
      kind: 'SEATS',
      seatsAllowed: 1,
    });

    // Activate one machine.
    const first = await licensesService.verify({
      applicationId: b.applicationId,
      rawKey: issued.rawKey,
      machineFingerprint: 'machine-A',
    });
    expect(first.ok).toBe(true);

    // Same machine, 5 more times, should keep passing without consuming.
    for (let i = 0; i < 5; i++) {
      const r = await licensesService.verify({
        applicationId: b.applicationId,
        rawKey: issued.rawKey,
        machineFingerprint: 'machine-A',
      });
      expect(r.ok).toBe(true);
    }
    expect(
      await prisma.licenseActivation.count({
        where: { licenseId: (issued.license as { id: string }).id },
      }),
    ).toBe(1);
  });

  afterAll(async () => {
    await prisma.couponRedemption.deleteMany({});
    await prisma.licenseActivation.deleteMany({});
    await prisma.license.deleteMany({});
    await prisma.coupon.deleteMany({});
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
  });
});
