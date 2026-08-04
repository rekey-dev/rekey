/**
 * Cross-tenant isolation matrix for `/api/v1/tenant/applications/:id/*`.
 *
 * Tenancy on this surface is NOT enforced by a global preHandler. Every route
 * makes its own `ensureAppAccess(req, id, need)` call (see
 * `src/lib/app-access.ts`). That is 80-odd hand-written call sites, and a
 * single forgotten one is a silent cross-tenant read of another operator's
 * Stripe credentials, SMTP password, or end-user list. Nothing but a test
 * catches it.
 *
 * So: build two workspaces, then for every sub-resource of A's Application ask
 * B's OWNER for it and require the non-disclosing 404. 404 rather than 403 is
 * deliberate — `notFound()` in app-access.ts returns `APPLICATION_NOT_FOUND`
 * precisely so the endpoint is not an existence oracle. Asserting 403 here
 * would be asserting a regression.
 *
 * Two things make this able to fail rather than pass vacuously:
 *
 *   1. **A positive control per probe.** Fastify answers an unrouted URL with
 *      404 too (`ROUTE_NOT_FOUND`), so a typo in the matrix would produce a
 *      green "cross-tenant denied" for a route that does not exist. Each case
 *      therefore first asserts the OWNING workspace is *not* refused.
 *   2. **A completeness guard** driven off the live route table
 *      (`app.swagger()`), not off this file. Adding an `:id` sub-resource
 *      without a matrix entry fails the suite.
 *
 * Adding a route later: add one PROBES entry. That is the whole job.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

const BASE = '/api/v1/tenant/applications';

// `light-my-request` is a transitive dependency of fastify, not one apps/api
// declares, so its types are not resolvable here. Derive the response type
// from `inject` itself instead of adding a dependency for one annotation.
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

interface Probe {
  /**
   * First path segment after `:id` — '' for the Application resource itself.
   * Matched against the live route table by the completeness guard below.
   */
  subResource: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Appended to `/api/v1/tenant/applications/<appId>`. */
  suffix: string;
  payload?: Record<string, unknown>;
}

/**
 * One probe per sub-resource. A read is preferred where the sub-resource has
 * one (cheapest, and a leaked read is the damaging direction); write-only
 * sub-resources use their mutating verb. The probe only has to reach
 * `ensureAppAccess` — what the handler does afterwards is other tests' job.
 */
const PROBES: Probe[] = [
  { subResource: '', method: 'GET', suffix: '' },
  { subResource: 'access', method: 'GET', suffix: '/access' },
  { subResource: 'api-keys', method: 'GET', suffix: '/api-keys' },
  // Clients registered against the Application as their authorization server.
  // The DELETE matters more than the GET here: a client id is a public value,
  // so revoke-by-id must be scoped by applicationId or anyone who has seen one
  // can remove it from someone else's Application.
  { subResource: 'oauth-clients', method: 'GET', suffix: '/oauth-clients' },
  {
    subResource: 'oauth-clients',
    method: 'DELETE',
    suffix: '/oauth-clients/some-client-id',
  },
  { subResource: 'auth-config', method: 'PATCH', suffix: '/auth-config', payload: {} },
  { subResource: 'billing-config', method: 'PATCH', suffix: '/billing-config', payload: {} },
  // The encrypted Stripe/PayPal/Razorpay keys. Worst possible omission.
  { subResource: 'billing-credentials', method: 'GET', suffix: '/billing-credentials' },
  {
    subResource: 'billing-credentials',
    method: 'GET',
    suffix: '/billing-credentials/webhook-events',
  },
  {
    subResource: 'billing-credentials',
    method: 'DELETE',
    suffix: '/billing-credentials/stripe',
  },
  { subResource: 'billing', method: 'GET', suffix: '/billing/providers' },
  { subResource: 'billing', method: 'GET', suffix: '/billing/stats' },
  { subResource: 'coupons', method: 'GET', suffix: '/coupons' },
  { subResource: 'dunning', method: 'GET', suffix: '/dunning' },
  { subResource: 'email-config', method: 'GET', suffix: '/email-config' },
  // The SMTP password.
  { subResource: 'email-credentials', method: 'DELETE', suffix: '/email-credentials' },
  { subResource: 'email-logs', method: 'GET', suffix: '/email-logs' },
  { subResource: 'email-templates', method: 'GET', suffix: '/email-templates' },
  { subResource: 'end-user-roles', method: 'GET', suffix: '/end-user-roles' },
  { subResource: 'end-users', method: 'GET', suffix: '/end-users' },
  { subResource: 'licenses', method: 'GET', suffix: '/licenses' },
  { subResource: 'oauth-config', method: 'DELETE', suffix: '/oauth-config/google' },
  { subResource: 'organizations', method: 'GET', suffix: '/organizations' },
  { subResource: 'payments', method: 'GET', suffix: '/payments' },
  { subResource: 'plans', method: 'GET', suffix: '/plans' },
  { subResource: 'plans', method: 'GET', suffix: '/plans/probe-plan/entitlements' },
  { subResource: 'portal', method: 'PATCH', suffix: '/portal', payload: {} },
  { subResource: 'requests', method: 'GET', suffix: '/requests' },
  { subResource: 'rotate-public-key', method: 'POST', suffix: '/rotate-public-key', payload: {} },
  { subResource: 'rotate-sessions', method: 'POST', suffix: '/rotate-sessions', payload: {} },
  { subResource: 'stats', method: 'GET', suffix: '/stats' },
  { subResource: 'usage-meters', method: 'GET', suffix: '/usage-meters' },
  { subResource: 'webhooks', method: 'GET', suffix: '/webhooks' },
];

interface Workspace {
  accessToken: string;
  tenantId: string;
}

function errorCode(res: InjectResponse): string | undefined {
  return (res.json() as { error?: { code?: string } }).error?.code;
}

describe('cross-tenant isolation matrix', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Fixtures are built inside each `it()`, not in a shared beforeAll: setup.ts
  // TRUNCATEs every domain table before each test, so shared state would be
  // gone by the time the case runs.
  async function workspace(tag: string): Promise<Workspace> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `xt-${tag}-${Math.random().toString(36).slice(2, 10)}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `XT ${tag}`,
      },
    });
    expect(r.statusCode).toBe(201);
    const data = r.json().data as { accessToken: string; activeTenantId: string };
    return { accessToken: data.accessToken, tenantId: data.activeTenantId };
  }

  async function createApplication(owner: Workspace): Promise<string> {
    const r = await app.inject({
      method: 'POST',
      url: `${BASE}/`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { name: 'XT app', slug: `xt-app-${Math.random().toString(36).slice(2, 10)}` },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  function send(
    probe: Probe,
    applicationId: string,
    accessToken: string,
  ): Promise<InjectResponse> {
    const opts: InjectOptions = {
      method: probe.method,
      url: `${BASE}/${applicationId}${probe.suffix}`,
      headers: { authorization: `Bearer ${accessToken}` },
    };
    if (probe.payload !== undefined) opts.payload = probe.payload;
    return app.inject(opts);
  }

  it.each(PROBES.map((probe) => [`${probe.method} :id${probe.suffix}`, probe] as const))(
    '%s — another workspace gets 404 APPLICATION_NOT_FOUND, never the resource',
    async (_label, probe) => {
      const a = await workspace('a');
      const b = await workspace('b');
      const applicationId = await createApplication(a);

      // Positive control. Without it a typo'd suffix would still "pass" the
      // assertion below, because an unrouted URL is also a 404.
      const owner = await send(probe, applicationId, a.accessToken);
      expect(errorCode(owner)).not.toBe('ROUTE_NOT_FOUND');
      expect(errorCode(owner)).not.toBe('APPLICATION_NOT_FOUND');

      // The guard itself. B's operator is OWNER of B and a stranger to A.
      const stranger = await send(probe, applicationId, b.accessToken);
      expect(stranger.statusCode).toBe(404);
      expect(errorCode(stranger)).toBe('APPLICATION_NOT_FOUND');
    },
  );

  it('every :id sub-resource in the live route table has a probe', () => {
    // The route table, not a source grep — this is what the server actually
    // serves. A new sub-resource lands here the moment it is registered.
    const doc = (app as unknown as { swagger: () => { paths: Record<string, unknown> } }).swagger();
    const registered = new Set<string>();
    for (const path of Object.keys(doc.paths)) {
      const rest = path.startsWith(`${BASE}/{id}`) ? path.slice(`${BASE}/{id}`.length) : null;
      if (rest === null) continue;
      // '' for the Application itself, otherwise the first segment after {id}.
      registered.add(rest === '' ? '' : (rest.split('/')[1] ?? ''));
    }

    const probed = new Set(PROBES.map((p) => p.subResource));
    const unprobed = [...registered].filter((s) => !probed.has(s)).sort();
    expect(
      unprobed,
      'a tenant-scoped Application sub-resource has no cross-tenant probe — add one to PROBES',
    ).toEqual([]);

    // And the reverse: a probe naming a sub-resource that no longer exists is
    // dead weight that would keep passing forever.
    const stale = [...probed].filter((s) => !registered.has(s)).sort();
    expect(stale, 'PROBES names a sub-resource the server no longer serves').toEqual([]);
  });
});
