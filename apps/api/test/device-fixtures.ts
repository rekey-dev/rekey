/**
 * Fixtures the device suites share.
 *
 * The device limit is an entitlement, so giving a test Application a cap means
 * creating a $0 plan that carries `max_devices` and making it the default. Four
 * suites needed exactly that and each had its own copy.
 */

import type { FastifyInstance } from 'fastify';
import type { WebhookDelivery } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';

/** A $0 default plan carrying `max_devices = limit` for the Application. */
export async function setDefaultDeviceLimit(
  app: FastifyInstance,
  operatorToken: string,
  applicationId: string,
  limit: number,
): Promise<void> {
  const auth = { authorization: `Bearer ${operatorToken}` };
  const slug = `free-${limit}`;
  const plan = await app.inject({
    method: 'POST',
    url: `/api/v1/tenant/applications/${applicationId}/plans`,
    headers: auth,
    payload: { slug, name: slug, amount: 0, kind: 'SUBSCRIPTION' },
  });
  if (plan.statusCode !== 201) throw new Error(`plan ${plan.statusCode}: ${plan.body}`);
  const put = await app.inject({
    method: 'PUT',
    url: `/api/v1/tenant/applications/${applicationId}/plans/${slug}/entitlements`,
    headers: auth,
    payload: { kind: 'FEATURE', key: 'max_devices', valueType: 'INT', value: String(limit) },
  });
  if (put.statusCode !== 200) throw new Error(`entitlement ${put.statusCode}: ${put.body}`);
  const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
  await prisma.application.update({
    where: { id: applicationId },
    data: { billingConfig: { ...(application.billingConfig as object), defaultPlanSlug: slug } as never },
  });
}

/** An end-user with a password, created through the operator route. */
export async function makeEndUser(
  app: FastifyInstance,
  operatorToken: string,
  applicationId: string,
  email: string,
  password = 'pw-one-two-three',
): Promise<string> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/v1/tenant/applications/${applicationId}/end-users`,
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: { email, password },
  });
  if (r.statusCode !== 201) throw new Error(`end-user ${r.statusCode}: ${r.body}`);
  return (r.json().data as { id: string }).id;
}

/**
 * Poll for outbound delivery rows. Emission is fire-and-forget, so a test
 * that asserts on deliveries waits for them rather than sleeping and hoping.
 * Returns whatever exists once `count` is reached or the timeout passes; the
 * caller asserts on the result either way.
 */
export async function waitForDeliveries(
  where: { applicationId: string; eventType?: string; endpointId?: string },
  count: number,
  timeoutMs = 4000,
): Promise<WebhookDelivery[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.webhookDelivery.findMany({ where, orderBy: { createdAt: 'asc' } });
    if (rows.length >= count || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
}
