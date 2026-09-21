/**
 * The super-admin plan-create route must refuse a field it does not implement.
 *
 * `POST /api/v1/admin/applications/:id/plans` builds SUBSCRIPTION plans and
 * nothing else: its body schema knows slug/name/amount/currency/interval/
 * metadata. Zod's default is to STRIP anything else, so a caller that sent
 * `kind`, `licenseKind`, `creditsAmount` or a typo got a 201 back describing a
 * plan that was not the one they asked for. `rekey plans create --kind LICENSE
 * --credits-amount 500` printed a tick and created a SUBSCRIPTION.
 *
 * Silence is the whole bug. A 400 naming the key is recoverable; a 201 for the
 * wrong plan reaches a pricing page.
 *
 * Why the refusal lives in the handler's zod and NOT in the Fastify body
 * schema: Fastify's AJV runs with `removeAdditional: true`, so declaring
 * `additionalProperties: false` there would DELETE the unknown key before the
 * handler saw it, restoring the silent 201 by a different route. Same reasoning
 * as `SetLimitsBody` in tenants.routes.ts. The last test below is the standing
 * check on that, it fails if someone "tightens" the JSON schema instead.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('admin plan create refuses unknown fields', () => {
  let app: FastifyInstance;
  let applicationId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const tenant = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/tenants',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { name: 'StrictT', ownerEmail: 'strict@example.com' },
      })
      .then((r) => r.json().data as { id: string });
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/admin/applications',
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
        payload: { tenantId: tenant.id, name: 'StrictApp', slug: 'strict-app' },
      })
      .then((r) => (r.json().data as { id: string }).id);
  });

  const createPlan = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
      payload,
    });

  it('refuses the per-kind fields the CLI used to send, and creates nothing', async () => {
    const res = await createPlan({
      slug: 'lic',
      name: 'Lic',
      amount: 4900,
      kind: 'LICENSE',
      licenseKind: 'PERPETUAL',
    });

    expect(res.statusCode).toBe(400);
    const err = res.json().error as { code: string; issues?: Array<{ message: string }> };
    expect(err.code).toBe('VALIDATION_ERROR');
    // The refusal has to NAME the keys, otherwise the caller is told only that
    // something is wrong with a body they believe is correct.
    const said = JSON.stringify(err.issues ?? err);
    expect(said).toContain('kind');
    expect(said).toContain('licenseKind');

    expect(await prisma.plan.count({ where: { applicationId } })).toBe(0);
  });

  it('refuses the exact credit-pack call that used to report success', async () => {
    // `rekey plans create --kind CREDIT --credits-amount 500`, the reported bug.
    const res = await createPlan({
      slug: 'credits_500',
      name: '500 credits',
      amount: 999,
      kind: 'CREDIT',
      creditsAmount: 500,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    // Before the fix this was a 201 for a SUBSCRIPTION plan with
    // creditsAmount: null, which is what made the CLI print a tick.
    expect(await prisma.plan.count({ where: { applicationId } })).toBe(0);
  });

  it('refuses a typo rather than silently ignoring it', async () => {
    const res = await createPlan({ slug: 'typo', name: 'T', amount: 100, intervall: 'YEAR' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.json().error)).toContain('intervall');
  });

  it('still accepts every field it does implement', async () => {
    const res = await createPlan({
      slug: 'pro_yearly',
      name: 'Pro',
      amount: 9900,
      currency: 'EUR',
      interval: 'YEAR',
      metadata: { note: 'kept' },
    });

    expect(res.statusCode).toBe(201);
    const plan = res.json().data as Record<string, unknown>;
    expect(plan.slug).toBe('pro_yearly');
    expect(plan.currency).toBe('EUR');
    expect(plan.interval).toBe('YEAR');
    expect(plan.kind).toBe('SUBSCRIPTION');
    expect((plan.metadata as { note?: string }).note).toBe('kept');
  });

  it('lets the unknown key reach the handler, rather than stripping it in AJV', async () => {
    // The distinction this file exists to defend. If the Fastify body schema
    // gains `additionalProperties: false`, AJV (`removeAdditional: true`)
    // deletes `kind` and the handler sees a valid body: 201, silently wrong,
    // exactly the bug that was fixed. A 400 proves the key survived AJV.
    const res = await createPlan({ slug: 'reach', name: 'R', amount: 1, kind: 'SUBSCRIPTION' });
    expect(res.statusCode).toBe(400);
    expect(await prisma.plan.count({ where: { applicationId, slug: 'reach' } })).toBe(0);
  });
});
