/**
 * Regressions for the 2026-08 external black-box audit: authorization defaults
 * and error mapping.
 *
 * Every case here reproduces a behaviour that was proven over HTTP against the
 * running API, and asserts the refusal. They are grouped by audit finding.
 *
 *   1. A workspace MEMBER with zero grants read every Application in the
 *      workspace — and zero grants is exactly what accepting an invite
 *      produces, so the "legacy" path was the live default.
 *   2. PATCH .../auth-config answered 200 for a body of entirely unrecognised
 *      keys and changed nothing, so `mfaa` for `mfa` silently no-opped an
 *      Application's MFA policy while reporting success.
 *   3. A payment-provider failure surfaced as 500 INTERNAL_ERROR to the end
 *      user and as a mismatched 401 BAD_REQUEST — with a fragment of the
 *      operator's Stripe key in `message` — to the operator.
 *   4. POST .../licenses returned a 404 with no `requestId`, the sole envelope
 *      break across 244 operations.
 *   5. GET /tenant/workspace/email-logs was MEMBER-readable while
 *      /tenant/security-events was ADMIN-only.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { getProviderForApplication } from '../src/modules/billing/providers/index.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { fakeProviderFor } from './fakes/billing-providers.js';

const PASSWORD = 'pw-one-two-three';

describe('authorization defaults + error mapping (audit 2026-08)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // The global rate limit is per-IP (100/min) and one app instance serves the
  // whole file, so each scenario gets its own source address.
  let n = 0;
  let currentIp = '10.77.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function signUp(email: string, workspaceName: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { accessToken: string }).accessToken;
  }

  interface Scenario {
    tag: string;
    ownerToken: string;
    memberToken: string;
    membershipId: string;
    appA: string;
    appB: string;
  }

  /** Owner + two Applications + one accepted invitation at `role`. */
  async function bootstrap(role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<Scenario> {
    currentIp = `10.77.${++n}.1`;
    const tag = `azd-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const ownerToken = await signUp(`owner-${tag}@example.com`, 'Authz Co');
    const inviteeToken = await signUp(`member-${tag}@example.com`, 'Member Own Co');

    const mkApp = async (suffix: string): Promise<string> => {
      const r = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: auth(ownerToken),
        payload: { name: `App ${suffix}`, slug: `${tag}-${suffix}`, enableBilling: true },
      });
      expect(r.statusCode).toBe(201);
      return (r.json().data as { id: string }).id;
    };
    const appA = await mkApp('a');
    const appB = await mkApp('b');

    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(ownerToken),
      payload: { email: `member-${tag}@example.com`, role },
    });
    expect(inv.statusCode).toBe(201);
    const accept = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(inviteeToken),
      payload: { token: (inv.json().data as { token: string }).token },
    });
    expect(accept.statusCode).toBe(200);
    const memberToken = (accept.json().data as { accessToken: string }).accessToken;

    const members = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: auth(ownerToken),
    });
    const membershipId = (
      members.json().data as { items: Array<{ membershipId: string; email: string }> }
    ).items.find((m) => m.email === `member-${tag}@example.com`)!.membershipId;

    return { tag, ownerToken, memberToken, membershipId, appA, appB };
  }

  // ==================================================================
  // 1 · Grant-scoped access is the DEFAULT for a new membership
  // ==================================================================

  describe('finding 1 · a freshly invited MEMBER starts with access to nothing', () => {
    /**
     * The audit read 31 GETs on an Application the member was never granted.
     * This is a representative spread across the sensitive ones it named:
     * end-user roster (with emails), API-key metadata, billing-credential
     * status, payments, webhooks, coupons, licences, organizations, email
     * logs, and per-app stats.
     */
    const READ_SURFACES = [
      'end-users',
      'api-keys',
      'billing-credentials',
      'payments',
      'webhooks',
      'coupons',
      'licenses',
      'organizations',
      'email-logs',
      'stats',
      'plans',
      'access',
      'end-user-roles',
    ];

    it('sees no Applications in the list', async () => {
      const { memberToken } = await bootstrap();
      const list = await inject({
        method: 'GET',
        url: '/api/v1/tenant/applications',
        headers: auth(memberToken),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toEqual({
        items: [],
        page: { total: 0, limit: expect.any(Number), offset: 0, hasMore: false },
      });
    });

    it('gets 404 on every read surface of an Application nobody granted them', async () => {
      const { memberToken, appA } = await bootstrap();

      const detail = await inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appA}`,
        headers: auth(memberToken),
      });
      expect(detail.statusCode).toBe(404);
      expect(detail.json().error.code).toBe('APPLICATION_NOT_FOUND');

      for (const path of READ_SURFACES) {
        const r = await inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${appA}/${path}`,
          headers: auth(memberToken),
        });
        expect(
          { path, status: r.statusCode, code: r.json().error?.code },
          `GET /${path} must not be readable without a grant`,
        ).toEqual({ path, status: 404, code: 'APPLICATION_NOT_FOUND' });
      }
    });

    it('grandfathers a membership that predates the default (legacyWorkspaceRead)', async () => {
      const { memberToken, membershipId, appA, appB } = await bootstrap();

      // Simulate a row the 2.0.0-rc.3 backfill touched: a MEMBER who existed
      // before grant-scoped-by-default and must not lose access on upgrade.
      await prisma.tenantMembership.update({
        where: { id: membershipId },
        data: { legacyWorkspaceRead: true },
      });

      const list = await inject({
        method: 'GET',
        url: '/api/v1/tenant/applications',
        headers: auth(memberToken),
      });
      expect(
        (list.json().data as { items: Array<{ id: string }> }).items.map((a) => a.id).sort(),
      ).toEqual([appA, appB].sort());

      const detail = await inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appA}`,
        headers: auth(memberToken),
      });
      expect(detail.statusCode).toBe(200);

      // Reads only — writes stay 403 with the pre-grants code, unchanged.
      const key = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/api-keys`,
        headers: auth(memberToken),
        payload: { name: 'k' },
      });
      expect(key.statusCode).toBe(403);
      expect(key.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
    });

    it('reports legacyWorkspaceRead on the members list so an owner can find them', async () => {
      const { ownerToken, membershipId, tag } = await bootstrap();
      await prisma.tenantMembership.update({
        where: { id: membershipId },
        data: { legacyWorkspaceRead: true },
      });
      const members = await inject({
        method: 'GET',
        url: '/api/v1/tenant/workspace/members',
        headers: auth(ownerToken),
      });
      const rows = (
        members.json().data as {
          items: Array<{ email: string; legacyWorkspaceRead: boolean }>;
        }
      ).items;
      expect(rows.find((m) => m.email === `member-${tag}@example.com`)!.legacyWorkspaceRead).toBe(
        true,
      );
      expect(rows.find((m) => m.email === `owner-${tag}@example.com`)!.legacyWorkspaceRead).toBe(
        false,
      );
    });

    it('setting a grant clears the grandfather flag, and removing the last grant does not restore it', async () => {
      const { ownerToken, memberToken, membershipId, appA, appB } = await bootstrap();
      await prisma.tenantMembership.update({
        where: { id: membershipId },
        data: { legacyWorkspaceRead: true },
      });

      const granted = await inject({
        method: 'PUT',
        url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
        headers: auth(ownerToken),
        payload: { applicationId: appA, role: 'APP_VIEWER' },
      });
      expect(granted.statusCode).toBe(200);
      expect(
        (await prisma.tenantMembership.findUniqueOrThrow({ where: { id: membershipId } }))
          .legacyWorkspaceRead,
      ).toBe(false);

      // Scoped: appA readable, appB is not.
      expect(
        (
          await inject({
            method: 'GET',
            url: `/api/v1/tenant/applications/${appB}`,
            headers: auth(memberToken),
          })
        ).statusCode,
      ).toBe(404);

      // Removing the LAST grant used to widen access back to the whole
      // workspace — a de-scoping call that granted more than it took away.
      const removed = await inject({
        method: 'DELETE',
        url: `/api/v1/tenant/workspace/members/${membershipId}/grants/${appA}`,
        headers: auth(ownerToken),
      });
      expect(removed.statusCode).toBe(200);

      const list = await inject({
        method: 'GET',
        url: '/api/v1/tenant/applications',
        headers: auth(memberToken),
      });
      expect(list.json().data).toEqual({
        items: [],
        page: { total: 0, limit: expect.any(Number), offset: 0, hasMore: false },
      });
      expect(
        (
          await inject({
            method: 'GET',
            url: `/api/v1/tenant/applications/${appA}`,
            headers: auth(memberToken),
          })
        ).statusCode,
      ).toBe(404);
    });

    it('leaves OWNER and ADMIN untouched', async () => {
      const { ownerToken, memberToken: adminToken, appA } = await bootstrap('ADMIN');
      for (const token of [ownerToken, adminToken]) {
        const r = await inject({
          method: 'GET',
          url: `/api/v1/tenant/applications/${appA}`,
          headers: auth(token),
        });
        expect(r.statusCode).toBe(200);
      }
    });
  });

  // ==================================================================
  // 2 · Unknown keys on config PATCH bodies are refused, not ignored
  // ==================================================================

  describe('finding 2 · a typo in a config patch is refused, not reported as success', () => {
    it('PATCH auth-config rejects a body of entirely unrecognised keys and changes nothing', async () => {
      const { ownerToken, appA } = await bootstrap();

      const before = (
        await prisma.application.findUniqueOrThrow({ where: { id: appA } })
      ).authConfig;

      // Verbatim from the audit: `mfaa` for `mfa`, `tokenAlgorithm` for
      // `tokenAlg`. Both silently no-opped the MFA policy and the token
      // signing algorithm while answering 200.
      const res = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appA}/auth-config`,
        headers: auth(ownerToken),
        payload: { mfaa: 'required', tokenAlgorithm: 'none', sessionTtl: 999999, bogus: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      // The response has to NAME the offending key, or the operator is left
      // guessing which of their four keys was the typo.
      expect(JSON.stringify(res.json().error.issues)).toMatch(/mfaa/);

      expect(
        (await prisma.application.findUniqueOrThrow({ where: { id: appA } })).authConfig,
      ).toEqual(before);
    });

    it('PATCH auth-config still accepts a well-formed patch', async () => {
      const { ownerToken, appA } = await bootstrap();
      const res = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appA}/auth-config`,
        headers: auth(ownerToken),
        payload: { mfa: 'required', tokenAlg: 'RS256' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.authConfig).toMatchObject({ mfa: 'required', tokenAlg: 'RS256' });
    });

    it('rejects unknown keys on every other config-shaped patch body', async () => {
      const { ownerToken, appA } = await bootstrap();

      const cases: Array<{ method: string; path: string; payload: Record<string, unknown> }> = [
        // A typo here used to answer 200 while leaving billing off.
        { method: 'PATCH', path: 'billing-config', payload: { enabld: true } },
        { method: 'PATCH', path: 'portal', payload: { enable: true } },
        // The worst of the four: an operator believing they had locked their
        // secret keys to an office CIDR when nothing was written.
        { method: 'PUT', path: 'access', payload: { ipAllowlst: ['10.0.0.0/8'] } },
      ];

      for (const c of cases) {
        const r = await inject({
          method: c.method,
          url: `/api/v1/tenant/applications/${appA}/${c.path}`,
          headers: auth(ownerToken),
          payload: c.payload,
        });
        expect(
          { path: c.path, status: r.statusCode, code: r.json().error?.code },
          `${c.method} /${c.path} must refuse an unrecognised key`,
        ).toEqual({ path: c.path, status: 400, code: 'VALIDATION_ERROR' });
      }
    });

    it('PATCH usage-meters/:slug refuses fields it does not edit instead of echoing a stale row', async () => {
      const { ownerToken, appA } = await bootstrap();
      expect(
        (
          await inject({
            method: 'POST',
            url: `/api/v1/tenant/applications/${appA}/usage-meters`,
            headers: auth(ownerToken),
            payload: { slug: 'api_calls', name: 'API calls', unit: 'call' },
          })
        ).statusCode,
      ).toBe(201);

      // Reported verbatim: this answered 200 having applied only `active`, and
      // echoed back the PRE-EDIT name and unit — so the response itself looked
      // like confirmation that the rename had happened.
      const res = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appA}/usage-meters/api_calls`,
        headers: auth(ownerToken),
        payload: { name: 'RENAMED', unit: 'widget', active: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.json().error.issues)).toMatch(/name|unit/);

      const after = await inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appA}/usage-meters`,
        headers: auth(ownerToken),
      });
      expect(
        (
          after.json().data as { items: Array<{ slug: string; name: string; unit: string }> }
        ).items.find((m) => m.slug === 'api_calls'),
      ).toMatchObject({ name: 'API calls', unit: 'call' });

      // The one field it does edit still works.
      const toggle = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appA}/usage-meters/api_calls`,
        headers: auth(ownerToken),
        payload: { active: false },
      });
      expect(toggle.statusCode).toBe(200);
      expect(toggle.json().data.active).toBe(false);
    });

    it('POST end-user-roles refuses an unrecognised key instead of 201-ing', async () => {
      const { ownerToken, appA } = await bootstrap();
      // `allowMagicLink` is not a role field — the real switch is the
      // auth-config `methods` array. It used to be accepted and dropped.
      const res = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/end-user-roles`,
        headers: auth(ownerToken),
        payload: { name: 'staff', allowMagicLink: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.json().error.issues)).toMatch(/allowMagicLink/);
    });

    it('all config-shaped bodies now agree on the refusal — no three-way split', async () => {
      const { ownerToken, appA } = await bootstrap();
      // The audit found billing-config answering 400 VALIDATION_ERROR while
      // auth-config answered 200 and end-user-roles answered 201, all for the
      // same class of mistake on the same API.
      const cases = [
        { method: 'PATCH', path: 'auth-config', payload: { nope: 1 } },
        { method: 'PATCH', path: 'billing-config', payload: { nope: 1 } },
        { method: 'PATCH', path: 'portal', payload: { nope: 1 } },
        { method: 'PUT', path: 'access', payload: { nope: 1 } },
        { method: 'POST', path: 'end-user-roles', payload: { name: 'ok', nope: 1 } },
      ];
      const seen = new Set<string>();
      for (const c of cases) {
        const r = await inject({
          method: c.method,
          url: `/api/v1/tenant/applications/${appA}/${c.path}`,
          headers: auth(ownerToken),
          payload: c.payload,
        });
        seen.add(`${r.statusCode}:${r.json().error?.code}`);
      }
      expect([...seen]).toEqual(['400:VALIDATION_ERROR']);
    });

    it('still ignores injected privileged keys — but now says so', async () => {
      const { ownerToken, appA } = await bootstrap();
      // The audit confirmed role/tenantId/applicationId/emailVerified/id are
      // correctly ignored on these bodies. The defect was that they were
      // ignored SILENTLY; the caller now gets told.
      const res = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appA}/auth-config`,
        headers: auth(ownerToken),
        payload: { mfa: 'optional', tenantId: 'attacker', applicationId: 'attacker', id: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      const application = await prisma.application.findUniqueOrThrow({ where: { id: appA } });
      expect(application.id).toBe(appA);
    });
  });

  // ==================================================================
  // 3 · Provider-SDK failures map to one honest envelope
  // ==================================================================

  describe('finding 3 · a payment-provider failure is a 502, not a 401 or a 500', () => {
    /** A Stripe auth error, shaped exactly as the SDK throws it. */
    function stripeAuthError(): Error {
      const e = new Error('Invalid API Key provided: sk_test_************2345');
      e.name = 'StripeAuthenticationError';
      (e as unknown as { statusCode: number }).statusCode = 401;
      (e as unknown as { type: string }).type = 'StripeAuthenticationError';
      return e;
    }

    async function withStripeCreds(applicationId: string): Promise<void> {
      await billingCredentialsService.upsertCredentials(applicationId, 'stripe', {
        apiKey: 'sk_test_ci_only',
        webhookSecret: 'whsec_ci_only',
      });
    }

    it('operator: POST /plans answers 502 BILLING_PROVIDER_ERROR, not 401 BAD_REQUEST', async () => {
      const { ownerToken, appA } = await bootstrap();
      await withStripeCreds(appA);

      const failing = {
        ...fakeProviderFor('stripe'),
        name: 'stripe',
        ensurePlanRegistered: async () => {
          throw stripeAuthError();
        },
      };
      vi.mocked(getProviderForApplication).mockResolvedValueOnce(failing as never);

      const res = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/plans`,
        headers: auth(ownerToken),
        payload: { slug: 'pro', name: 'Pro', amount: 1200, interval: 'MONTH' },
      });

      expect(res.statusCode).toBe(502);
      const err = res.json().error;
      expect(err.code).toBe('BILLING_PROVIDER_ERROR');
      // The three signals that used to disagree now agree: an upstream status,
      // an upstream code, and a `fix` about credentials rather than about the
      // caller's request shape.
      expect(err.fix).not.toMatch(/route schema/i);
      expect(err.fix).toMatch(/credential/i);
      expect(err.message).toMatch(/stripe/i);
      expect(err.requestId).toEqual(expect.any(String));
    });

    it('end-user: POST /billing/checkout answers 502 and leaks no provider detail', async () => {
      const { ownerToken, appA } = await bootstrap();
      await withStripeCreds(appA);

      // A plan (registered by the healthy fake) and an end-user to buy it.
      expect(
        (
          await inject({
            method: 'POST',
            url: `/api/v1/tenant/applications/${appA}/plans`,
            headers: auth(ownerToken),
            payload: { slug: 'basic', name: 'Basic', amount: 500, interval: 'MONTH' },
          })
        ).statusCode,
      ).toBe(201);

      const liveKey = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/api-keys`,
        headers: auth(ownerToken),
        payload: { name: 'k', mode: 'live' },
      }).then((r) => (r.json().data as { rawKey: string }).rawKey);

      const endUserToken = await inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: auth(liveKey),
        payload: { email: `buyer-${n}@example.com`, password: PASSWORD },
      }).then((r) => (r.json().data as { accessToken: string }).accessToken);

      const failing = {
        ...fakeProviderFor('stripe'),
        name: 'stripe',
        createCheckoutSession: async () => {
          throw stripeAuthError();
        },
      };
      vi.mocked(getProviderForApplication).mockResolvedValueOnce(failing as never);

      const res = await inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': endUserToken },
        payload: {
          planSlug: 'basic',
          successUrl: 'https://example.com/ok',
          cancelUrl: 'https://example.com/no',
        },
      });

      expect(res.statusCode).toBe(502);
      const err = res.json().error;
      expect(err.code).toBe('BILLING_PROVIDER_ERROR');
      expect(err.code).not.toBe('INTERNAL_ERROR');
      // The buyer is the operator's CUSTOMER. They must not be shown the
      // operator's key fragment, nor told to "share this request id with
      // support" for somebody else's misconfigured Stripe account.
      expect(err.message).not.toMatch(/sk_test/);
      expect(err.message).not.toMatch(/Invalid API Key/i);
      expect(err.fix).not.toMatch(/share request id/i);
      expect(err.requestId).toEqual(expect.any(String));
    });

    it('end-user: POST /billing/subscription/cancel answers 502, and the subscription is untouched', async () => {
      const { ownerToken, appA } = await bootstrap();
      await withStripeCreds(appA);

      expect(
        (
          await inject({
            method: 'POST',
            url: `/api/v1/tenant/applications/${appA}/plans`,
            headers: auth(ownerToken),
            payload: { slug: 'cancelme', name: 'Cancel Me', amount: 700, interval: 'MONTH' },
          })
        ).statusCode,
      ).toBe(201);

      const liveKey = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/api-keys`,
        headers: auth(ownerToken),
        payload: { name: 'k', mode: 'live' },
      }).then((r) => (r.json().data as { rawKey: string }).rawKey);

      const endUserToken = await inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: auth(liveKey),
        payload: { email: `canceller-${n}@example.com`, password: PASSWORD },
      }).then((r) => (r.json().data as { accessToken: string }).accessToken);

      // A provider-backed ACTIVE subscription for that user.
      const endUser = await prisma.endUser.findFirstOrThrow({
        where: { applicationId: appA, email: `canceller-${n}@example.com` },
      });
      const plan = await prisma.plan.findFirstOrThrow({
        where: { applicationId: appA, slug: 'cancelme' },
      });
      const sub = await prisma.subscription.create({
        data: {
          applicationId: appA,
          endUserId: endUser.id,
          planId: plan.id,
          status: 'ACTIVE',
          provider: 'stripe',
          providerSubId: 'sub_provider_side',
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      });

      const failing = {
        ...fakeProviderFor('stripe'),
        name: 'stripe',
        cancelSubscription: async () => {
          throw stripeAuthError();
        },
      };
      vi.mocked(getProviderForApplication).mockResolvedValueOnce(failing as never);

      const res = await inject({
        method: 'POST',
        url: '/api/v1/billing/subscription/cancel',
        headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': endUserToken },
        payload: { atPeriodEnd: false },
      });

      expect(res.statusCode).toBe(502);
      const err = res.json().error;
      expect(err.code).toBe('BILLING_PROVIDER_ERROR');
      // The reported shape: 401 + BAD_REQUEST + "check the request shape",
      // telling the buyer their request was malformed while the subscription
      // they asked to cancel carried on billing.
      expect(err.fix).not.toMatch(/route schema/i);
      expect(err.message).not.toMatch(/sk_test/);

      // The subscription genuinely was NOT canceled — the failure is honest
      // about that now, where the 401 implied a client-side mistake.
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(after.status).toBe('ACTIVE');
      expect(after.canceledAt).toBeNull();
    });

    it('an UNMAPPED provider error still cannot escape as a 4xx passthrough', async () => {
      const { ownerToken, appA } = await bootstrap();
      await withStripeCreds(appA);

      // `getProviderForApplication` itself is outside every call site's
      // try/catch, so this exercises the last-resort guard in the global error
      // handler rather than any individual mapping.
      vi.mocked(getProviderForApplication).mockRejectedValueOnce(stripeAuthError() as never);

      const res = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/plans`,
        headers: auth(ownerToken),
        payload: { slug: 'edge', name: 'Edge', amount: 900, interval: 'MONTH' },
      });

      expect(res.statusCode).toBe(502);
      const err = res.json().error;
      expect(err.code).toBe('BILLING_PROVIDER_ERROR');
      expect(err.message).not.toMatch(/sk_test/);
      expect(err.requestId).toEqual(expect.any(String));
    });

    it('does not relabel a RekeyError the provider layer raised deliberately', async () => {
      const { ownerToken, appA } = await bootstrap();
      // No Stripe credentials → the factory's own 400, which is our
      // classification of the operator's situation, not an upstream failure.
      const res = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/billing-credentials/stripe/register-webhook`,
        headers: auth(ownerToken),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
    });
  });

  // ==================================================================
  // 4 · Every error response carries a requestId
  // ==================================================================

  describe('finding 4 · POST /licenses returns a complete error envelope', () => {
    it('404s with requestId and the X-Request-Id header', async () => {
      const { ownerToken, appA } = await bootstrap();
      const res = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appA}/licenses`,
        headers: auth(ownerToken),
        payload: { endUserId: 'eu_does_not_exist', kind: 'PERPETUAL' },
      });
      expect(res.statusCode).toBe(404);
      const err = res.json().error;
      expect(err.code).toBe('END_USER_NOT_FOUND');
      // The whole finding: this field was absent, uniquely, on this route.
      expect(err.requestId).toEqual(expect.any(String));
      expect(res.headers['x-request-id']).toBe(err.requestId);
    });

    it('the other two hand-built envelopes carry it as well', async () => {
      const { ownerToken, appA, tag } = await bootstrap();
      const email = `dupe-${tag}@example.com`;
      const create = () =>
        inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appA}/end-users`,
          headers: auth(ownerToken),
          payload: { email, password: PASSWORD },
        });
      expect((await create()).statusCode).toBe(201);
      const dupe = await create();
      expect(dupe.statusCode).toBe(409);
      expect(dupe.json().error.code).toBe('EMAIL_ALREADY_EXISTS');
      expect(dupe.json().error.requestId).toEqual(expect.any(String));
      expect(dupe.headers['x-request-id']).toBe(dupe.json().error.requestId);
    });
  });

  // ==================================================================
  // 5 · Workspace audit surfaces share one role floor
  // ==================================================================

  describe('finding 5 · workspace-level operator surfaces agree on their role floor', () => {
    it('a MEMBER cannot read workspace email logs, invitations, or security events', async () => {
      const { memberToken } = await bootstrap();
      const paths = [
        '/api/v1/tenant/workspace/email-logs',
        '/api/v1/tenant/workspace/invitations',
        // Already correct before this change — the parity anchor the other
        // two are being aligned to.
        '/api/v1/tenant/security-events',
      ];
      for (const url of paths) {
        const r = await inject({ method: 'GET', url, headers: auth(memberToken) });
        expect(
          { url, status: r.statusCode, code: r.json().error?.code },
          `${url} must share the OWNER/ADMIN floor of its siblings`,
        ).toEqual({ url, status: 403, code: 'TENANT_ROLE_INSUFFICIENT' });
      }
    });

    it('the GET and the POST of an invitation now agree', async () => {
      const { memberToken } = await bootstrap();
      const read = await inject({
        method: 'GET',
        url: '/api/v1/tenant/workspace/invitations',
        headers: auth(memberToken),
      });
      const write = await inject({
        method: 'POST',
        url: '/api/v1/tenant/workspace/invitations',
        headers: auth(memberToken),
        payload: { email: 'someone@example.com', role: 'MEMBER' },
      });
      expect(read.statusCode).toBe(write.statusCode);
      expect(read.json().error.code).toBe(write.json().error.code);
    });

    it('OWNER and ADMIN keep access to all three', async () => {
      const { ownerToken, memberToken: adminToken } = await bootstrap('ADMIN');
      for (const token of [ownerToken, adminToken]) {
        for (const url of [
          '/api/v1/tenant/workspace/email-logs',
          '/api/v1/tenant/workspace/invitations',
          '/api/v1/tenant/security-events',
        ]) {
          const r = await inject({ method: 'GET', url, headers: auth(token) });
          expect({ url, status: r.statusCode }).toEqual({ url, status: 200 });
        }
      }
    });
  });
});
