/**
 * `create_plan` over MCP can create every plan KIND, not just subscriptions.
 *
 * The tool exposed slug/name/amount/currency/interval and nothing else, so
 * `kind` defaulted to SUBSCRIPTION on every call and there was no way to say
 * otherwise. The same omission hid LICENSE and USAGE entirely, and
 * `create_usage_meter` could not set `creditsPerUnit`, so a meter created
 * through MCP could only ever COUNT usage, never charge for it.
 *
 * The failure was SILENT, not a refusal, which is the part worth being precise
 * about. `inputSchema` is only advertised to the client in `tools/list`;
 * `tenant-mcp-server.ts` never validates arguments against it, so
 * `additionalProperties: false` is advisory. An agent that sent
 * `kind: 'CREDIT'` anyway had the key dropped by the handler, and the operator
 * got a SUBSCRIPTION plan named "1,000 credits" that grants no credits and
 * bills monthly. Reverting the handler mapping reproduces exactly that:
 * "expected 'SUBSCRIPTION' to be 'CREDIT'".
 *
 * `plansService.create` and `usageService.createMeter` have always accepted all
 * of it. Only the tools' input schemas were short. That is the failure mode
 * worth pinning: a capability the service supports that no caller can reach.
 *
 * Each case asserts the STORED row rather than the tool's echo, because a plan
 * that silently came back as SUBSCRIPTION is exactly the bug.
 *
 * Setup is per-test on purpose: `test/setup.ts` truncates in `beforeEach`, so
 * anything built in `beforeAll` is gone by the time the first case runs and
 * every call 401s against a tenant that no longer exists.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('Operator MCP create_plan covers every plan kind', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function call(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; data: Record<string, unknown> }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    const parsed = JSON.parse(res.body) as {
      result?: { content: Array<{ text: string }>; isError?: boolean };
    };
    if (!parsed.result) {
      throw new Error(`rpc ${name} -> ${res.statusCode} ${res.body.slice(0, 300)}`);
    }
    return {
      isError: parsed.result.isError === true,
      data: JSON.parse(parsed.result.content[0]!.text) as Record<string, unknown>,
    };
  }

  /** A fresh workspace, an operator MCP write token, and one Application. */
  async function setup(slug: string): Promise<{ token: string; appId: string }> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `mcp-kinds-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });

    const clientId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/register',
        payload: { redirect_uris: [REDIRECT] },
      })
      .then((r) => (r.json() as { client_id: string }).client_id);

    const { verifier, challenge } = pkce();
    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp/oauth/grant',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'mcp:operator:read mcp:operator:write',
        tenant_id: session.activeTenantId,
        approve: true,
      },
    });
    const code = new URL(
      (grant.json() as { data: { redirect: string } }).data.redirect,
    ).searchParams.get('code');

    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/token',
        payload: {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          client_id: clientId,
        },
      })
      .then((r) => (r.json() as { access_token: string }).access_token);

    const created = await call(token, 'create_application', { name: `App ${slug}`, slug });
    return { token, appId: created.data.id as string };
  }

  it('creates a CREDIT pack, the case that was unreachable', async () => {
    const { token, appId } = await setup('credit');
    const res = await call(token, 'create_plan', {
      applicationId: appId,
      slug: 'credits-1000',
      name: '1,000 credits',
      amount: 1000,
      kind: 'CREDIT',
      creditsAmount: 1000,
    });
    expect(res.isError).toBe(false);

    // Both halves matter. Before this the keys were dropped, so the row read
    // SUBSCRIPTION with a null creditsAmount: a monthly charge named after a
    // credit pack that grants nothing on purchase.
    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'credits-1000' },
    });
    expect(plan.kind).toBe('CREDIT');
    expect(plan.creditsAmount).toBe(1000);
  });

  it('still defaults to SUBSCRIPTION when kind is omitted', async () => {
    const { token, appId } = await setup('default');
    const res = await call(token, 'create_plan', {
      applicationId: appId,
      slug: 'pro-monthly',
      name: 'Pro',
      amount: 2500,
    });
    expect(res.isError).toBe(false);
    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'pro-monthly' },
    });
    expect(plan.kind).toBe('SUBSCRIPTION');
  });

  it('creates a TIMED licence with its duration', async () => {
    const { token, appId } = await setup('timed');
    const res = await call(token, 'create_plan', {
      applicationId: appId,
      slug: 'license-1y',
      name: 'One year licence',
      amount: 9900,
      kind: 'LICENSE',
      licenseKind: 'TIMED',
      licenseDurationDays: 365,
    });
    expect(res.isError).toBe(false);
    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'license-1y' },
    });
    expect(plan.kind).toBe('LICENSE');
    expect(plan.licenseKind).toBe('TIMED');
    expect(plan.licenseDurationDays).toBe(365);
  });

  it('creates a SEATS licence with its seat count', async () => {
    const { token, appId } = await setup('seats');
    const res = await call(token, 'create_plan', {
      applicationId: appId,
      slug: 'license-seats',
      name: 'Team licence',
      amount: 19900,
      kind: 'LICENSE',
      licenseKind: 'SEATS',
      licenseSeatsAllowed: 25,
    });
    expect(res.isError).toBe(false);
    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'license-seats' },
    });
    expect(plan.licenseKind).toBe('SEATS');
    expect(plan.licenseSeatsAllowed).toBe(25);
  });

  it('creates a USAGE plan against a meter that can charge', async () => {
    const { token, appId } = await setup('usage');
    const meterRes = await call(token, 'create_usage_meter', {
      applicationId: appId,
      slug: 'tokens',
      name: 'Tokens',
      unit: 'token',
      // Also previously unreachable: a meter created over MCP could only COUNT.
      creditsPerUnit: 2,
    });
    expect(meterRes.isError).toBe(false);
    const meter = await prisma.usageMeter.findFirstOrThrow({
      where: { applicationId: appId, slug: 'tokens' },
    });
    expect(meter.creditsPerUnit).toBe(2);

    const res = await call(token, 'create_plan', {
      applicationId: appId,
      slug: 'metered',
      name: 'Pay as you go',
      amount: 0,
      kind: 'USAGE',
      meterSlug: 'tokens',
      pricePerUnitCents: 5,
    });
    expect(res.isError).toBe(false);
    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'metered' },
    });
    expect(plan.kind).toBe('USAGE');
    expect(plan.meterSlug).toBe('tokens');
    expect(plan.pricePerUnitCents).toBe(5);
  });

  it('refuses to let operator metadata forge a provider registration', async () => {
    // `metadata` is new on this tool, and it reaches `plansService.create`,
    // which used to write it verbatim — the ONE writer that skipped the
    // stripping `mergeMetadata` performs, because it has nothing to merge
    // against.
    //
    // With `metadata.stripe.priceId` set, the plan is treated as already
    // registered: `ensurePlanRegistered` returns the stored id without minting
    // anything, `hasProviderRegistration` reports true, and checkout charges
    // THAT price while this row, the pricing page and the receipt all show
    // `amount`. A plan that bills for something else, and is frozen for good
    // because every repair is refused with PLAN_PRICE_IMMUTABLE.
    const { token, appId } = await setup('meta');
    const res = await call(token, 'create_plan', {
      applicationId: appId,
      slug: 'forged',
      name: 'Cheap looking plan',
      amount: 100,
      metadata: { stripe: { priceId: 'price_someone_elses_99_dollars' }, note: 'keep me' },
    });
    expect(res.isError).toBe(false);

    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId: appId, slug: 'forged' },
    });
    const meta = plan.metadata as Record<string, unknown>;
    // The reserved key is gone; the operator's own key survives, because this
    // is a strip of three names and not a rejection of metadata.
    expect(meta.stripe).toBeUndefined();
    expect(meta.note).toBe('keep me');
  });

  it('surfaces the per-kind requirement rather than creating a broken plan', async () => {
    // The service refuses a CREDIT plan with no creditsAmount. Now that `kind`
    // is reachable that refusal is reachable too, and it has to arrive as a
    // tool error the agent can act on rather than as a plan that looks fine
    // and grants nothing.
    const { token, appId } = await setup('broken');
    const res = await call(token, 'create_plan', {
      applicationId: appId,
      slug: 'credits-broken',
      name: 'Broken pack',
      amount: 500,
      kind: 'CREDIT',
    });
    expect(res.isError).toBe(true);
    expect(
      await prisma.plan.findFirst({ where: { applicationId: appId, slug: 'credits-broken' } }),
    ).toBeNull();
  });
});
