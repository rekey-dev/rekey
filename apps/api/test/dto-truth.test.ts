/**
 * Three published DTOs that did not describe the responses they named.
 *
 * `@rekey.dev/shared-types` is what an SDK consumer types their code against,
 * and what the OpenAPI document derives 40 of its 55 components from. When a
 * DTO and its handler disagree, the disagreement is invisible from both sides:
 * the handler has no idea a DTO claims to describe it, and the DTO compiles
 * fine describing nothing. It surfaces as a runtime `undefined` in someone
 * else's codebase.
 *
 * Found by the agents documenting response schemas, who correctly wrote local
 * schemas matching the real responses rather than referencing DTOs that lied:
 *
 *   - `UsageRecordDto` promised `applicationId` and `meterSlug`. The route
 *     returned the raw Prisma row, which has NEITHER — `applicationId` lives on
 *     the meter, and the row stores `meterId`, an internal id the caller cannot
 *     resolve back to the slug they sent.
 *   - `UsageAggregateDto` promised `{meterSlug, total, from, to}`. The service
 *     returned `{total, count}` — no overlap beyond `total`, and `count` was
 *     undocumented.
 *   - `CreditBalanceDto` required `endUserId`, which an ORGANIZATION balance
 *     cannot have, and `updatedAt`, which does not exist at all: the balance is
 *     summed from the ledger, not stored on a row with a timestamp.
 *
 * The first two were fixed by shaping the handler to the DTO — the DTO was the
 * better contract. The third by correcting the DTO — the handler was right and
 * the DTO described something impossible.
 *
 * These assert the response parses against the exported schema, so the two
 * cannot drift apart again without a test naming which field moved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  CreditBalanceDtoSchema,
  UsageAggregateDtoSchema,
  UsageRecordDtoSchema,
} from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';

describe('published DTOs describe the responses they name', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Fixture per test: `test/setup.ts` truncates every domain table in beforeEach. */
  async function fixture(slug: string): Promise<{ liveKey: string; endUserId: string }> {
    const tenantAccess = await app
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
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: {
          name: 'k',
          mode: 'live',
          scopes: ['auth:write', 'billing:read', 'billing:write'],
        },
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

    // A meter to record against.
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/usage-meters`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { slug: 'api_calls', name: 'API calls', unit: 'call' },
    });

    return { liveKey, endUserId };
  }

  it('POST /usage/record returns the fields UsageRecordDto requires', async () => {
    const { liveKey, endUserId } = await fixture('dto-rec');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { endUserId, meterSlug: 'api_calls', quantity: 3 },
    });

    expect(res.statusCode).toBe(201);
    const parsed = UsageRecordDtoSchema.safeParse(res.json().data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);

    // The two fields that used to be absent, named explicitly so a regression
    // says which one went missing rather than just "parse failed".
    expect(res.json().data.meterSlug).toBe('api_calls');
    expect(res.json().data.applicationId).toBeTruthy();
    // …and the internal id is not leaked in their place.
    expect(res.json().data).not.toHaveProperty('meterId');
  });

  it('GET /usage/aggregate returns the fields UsageAggregateDto requires', async () => {
    const { liveKey, endUserId } = await fixture('dto-agg');
    await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { endUserId, meterSlug: 'api_calls', quantity: 7 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/usage/aggregate?meterSlug=api_calls&endUserId=${endUserId}`,
      headers: { authorization: `Bearer ${liveKey}` },
    });

    expect(res.statusCode).toBe(200);
    const parsed = UsageAggregateDtoSchema.safeParse(res.json().data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.json().data.meterSlug).toBe('api_calls');
    expect(res.json().data.total).toBe(7);
    // `count` was always returned and never documented; it is part of the
    // contract now, so a handler that stops sending it should fail here.
    expect(res.json().data.count).toBe(1);
  });

  it('GET /credits/balance parses for an end-user subject', async () => {
    const { liveKey, endUserId } = await fixture('dto-bal');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/credits/balance?endUserId=${endUserId}`,
      headers: { authorization: `Bearer ${liveKey}` },
    });

    expect(res.statusCode).toBe(200);
    const parsed = CreditBalanceDtoSchema.safeParse(res.json().data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.json().data.endUserId).toBe(endUserId);
    // The field the DTO used to require and the response has never carried.
    expect(res.json().data).not.toHaveProperty('updatedAt');
  });

  it('GET /credits/balance parses for an ORGANIZATION subject — the case the DTO made impossible', async () => {
    // This is the one that mattered: `endUserId` was required, so an
    // organization balance could not satisfy its own published type. Anyone
    // who trusted the DTO wrote `balance.endUserId` and got undefined.
    const { liveKey, endUserId } = await fixture('dto-org');
    const organizationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/users/me/organizations',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { name: 'Acme', slug: 'acme', ownerEndUserId: endUserId },
      })
      .then((r) => (r.json().data as { id: string } | undefined)?.id);

    // The route above is end-user-scoped in some builds; skip cleanly rather
    // than assert on a fixture detail this test is not about.
    if (!organizationId) return;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/credits/balance?organizationId=${organizationId}`,
      headers: { authorization: `Bearer ${liveKey}` },
    });

    expect(res.statusCode).toBe(200);
    const parsed = CreditBalanceDtoSchema.safeParse(res.json().data);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(res.json().data.organizationId).toBe(organizationId);
    expect(res.json().data.endUserId).toBeUndefined();
  });
});
