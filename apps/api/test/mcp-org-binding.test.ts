/**
 * An end-user MCP connection can act for one of the user's organizations
 * (gap 7 of docs/specs/auth-me-include.md).
 *
 * The user chooses at consent; the choice is stored on the authorization code,
 * carried into the access token as `oid` and down the refresh chain, and every
 * account tool resolves its subject from it with the HTTP API's rule: the
 * organization is the billing subject only in an org-billed Application.
 *
 * The negative cases carry the weight. A binding must never reach an
 * organization the user is not a member of, one in another Application, or
 * one they have since left or had their role disabled in. Those fail closed:
 * the refresh is refused and a live access token stops working, rather than
 * quietly reporting the user's own plan as the organization's.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';
import { seedPlan } from './seed-plan.js';

operatorsConfirmTheirEmail();

const REDIRECT = 'http://localhost:9876/cb';
const PASSWORD = 'pw-one-two-three';

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function form(payload: Record<string, string>): { headers: Record<string, string>; payload: string } {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(payload).toString(),
  };
}

interface Fixture {
  slug: string;
  appId: string;
  clientId: string;
  liveKey: string;
  operatorToken: string;
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
}

describe('MCP organization binding', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;

  async function bootstrap(opts: { billingSubject: 'org' | 'user'; organizationsEnabled?: boolean }): Promise<Fixture> {
    const slug = `orgb-${n++}-${Math.random().toString(36).slice(2, 7)}`;
    const operatorToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: 'Org Binding Co' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'Org Binding App', slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/auth-config`,
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { mcpEnabled: true, oidcEnabled: true, organizationsEnabled: opts.organizationsEnabled ?? true },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    // Billing on, so the REST licence route the tools are compared with answers.
    const { billingConfig } = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await prisma.application.update({
      where: { id: appId },
      data: {
        billingConfig: {
          ...(billingConfig as object),
          enabled: true,
          ...(opts.billingSubject === 'org' && { billingSubject: 'org' }),
        },
      },
    });
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const clientId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/mcp/${slug}/oauth/register`,
        payload: { redirect_uris: [REDIRECT], client_name: 'Claude' },
      })
      .then((r) => (r.json() as { client_id: string }).client_id);
    return { slug, appId, clientId, liveKey, operatorToken };
  }

  async function endUser(fx: Fixture, email: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${fx.appId}/end-users`,
      headers: { authorization: `Bearer ${fx.operatorToken}` },
      payload: { email, password: PASSWORD, emailVerified: true },
    });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json().data as { id: string }).id;
  }

  async function org(appId: string, slug: string, members: Array<[string, string]>): Promise<string> {
    const o = await prisma.organization.create({ data: { applicationId: appId, name: `Org ${slug}`, slug } });
    for (const [endUserId, role] of members) {
      await prisma.organizationMembership.create({ data: { organizationId: o.id, endUserId, role } });
    }
    return o.id;
  }

  /** Org-billed data: a personal plan + credits + licence, and the org's. */
  async function seedBilling(fx: Fixture, userId: string, orgId: string): Promise<void> {
    const plan = async (slug: string): Promise<string> =>
      (
        await seedPlan({ applicationId: fx.appId, slug, name: slug, kind: 'SUBSCRIPTION' }, null)
      ).id;
    const solo = await plan('solo');
    const crew = await plan('crew');
    await prisma.subscription.create({
      data: { applicationId: fx.appId, endUserId: userId, planId: solo, status: 'ACTIVE' },
    });
    await prisma.subscription.create({
      data: { applicationId: fx.appId, endUserId: userId, planId: crew, status: 'ACTIVE', beneficiaryOrgId: orgId },
    });
    await prisma.creditBalance.create({
      data: { applicationId: fx.appId, endUserId: userId, subjectKey: `u:${userId}`, balance: 7 },
    });
    await prisma.creditBalance.create({
      data: { applicationId: fx.appId, organizationId: orgId, subjectKey: `o:${orgId}`, balance: 900 },
    });
    const licence = (seats: number, organizationId?: string) =>
      prisma.license.create({
        data: {
          applicationId: fx.appId,
          endUserId: userId,
          ...(organizationId && { organizationId }),
          kind: 'PERPETUAL',
          keyPrefix: 'lk_test',
          keyHash: randomBytes(16).toString('hex'),
          seatsAllowed: seats,
        },
      });
    await licence(1);
    await licence(25, orgId);
  }

  /** A licence pooled to the organization but bought by someone else. */
  async function teammatePoolLicence(fx: Fixture, orgId: string): Promise<string> {
    const teammate = await endUser(fx, `mate-${Math.random().toString(36).slice(2, 7)}@example.com`);
    await prisma.organizationMembership.create({ data: { organizationId: orgId, endUserId: teammate, role: 'MEMBER' } });
    const row = await prisma.license.create({
      data: {
        applicationId: fx.appId,
        endUserId: teammate,
        organizationId: orgId,
        kind: 'PERPETUAL',
        keyPrefix: 'lk_test',
        keyHash: randomBytes(16).toString('hex'),
        seatsAllowed: 5,
      },
    });
    return row.id;
  }

  /** `GET /users/me/licenses` ids for this user, the session switched into `orgId` when given. */
  async function restLicenceIds(fx: Fixture, email: string, orgId?: string): Promise<string[]> {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${fx.liveKey}` },
      payload: { email, password: PASSWORD },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    let token = (signIn.json().data as { accessToken: string }).accessToken;
    if (orgId) {
      const switched = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${orgId}/switch`,
        headers: { authorization: `Bearer ${fx.liveKey}`, 'x-rekey-user-token': token },
      });
      expect(switched.statusCode, switched.body).toBe(200);
      token = (switched.json().data as { accessToken: string }).accessToken;
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/licenses?limit=100',
      headers: { authorization: `Bearer ${fx.liveKey}`, 'x-rekey-user-token': token },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data.items as Array<{ id: string }>).map((l) => l.id);
  }

  function authorizeParams(fx: Fixture, challenge: string, scope = 'mcp:account'): Record<string, string> {
    return {
      response_type: 'code',
      client_id: fx.clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      state: 'st',
    };
  }

  function signInStep(fx: Fixture, email: string, challenge: string, scope?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/authorize`,
      ...form({ ...authorizeParams(fx, challenge, scope), email, password: PASSWORD, consent: 'allow' }),
    });
  }

  function consentTokenOf(html: string): string {
    const m = /name="consent_token" value="([^"]+)"/.exec(html);
    if (!m) throw new Error(`no consent step rendered:\n${html.slice(0, 400)}`);
    return m[1]!;
  }

  function chooseStep(
    fx: Fixture,
    consentToken: string,
    organization: string,
    challenge: string,
    overrides: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/authorize`,
      ...form({ ...authorizeParams(fx, challenge), consent_token: consentToken, organization, consent: 'allow', ...overrides }),
    });
  }

  function codeOf(res: { statusCode: number; headers: Record<string, unknown>; body: string }): string {
    expect(res.statusCode, res.body.slice(0, 400)).toBe(302);
    const code = new URL(String(res.headers.location)).searchParams.get('code');
    if (!code) throw new Error(`no code in ${String(res.headers.location)}`);
    return code;
  }

  async function redeem(fx: Fixture, code: string, verifier: string): Promise<Tokens> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: fx.clientId }),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Tokens;
  }

  function refresh(fx: Fixture, refreshToken: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: fx.clientId }),
    });
  }

  /** Interactive consent all the way to tokens, choosing `organization` when asked. */
  async function connect(fx: Fixture, email: string, organization: string): Promise<Tokens> {
    const { verifier, challenge } = pkce();
    const step1 = await signInStep(fx, email, challenge);
    expect(step1.statusCode).toBe(200);
    const step2 = await chooseStep(fx, consentTokenOf(step1.body), organization, challenge);
    return redeem(fx, codeOf(step2), verifier);
  }

  function callToolRaw(fx: Fixture, accessToken: string, name: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}`,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } },
    });
  }

  async function tool<T = Record<string, unknown>>(fx: Fixture, accessToken: string, name: string): Promise<T> {
    const res = await callToolRaw(fx, accessToken, name);
    expect(res.statusCode, res.body).toBe(200);
    const result = (res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError, result.content[0]!.text).toBeFalsy();
    return JSON.parse(result.content[0]!.text) as T;
  }

  function introspect(fx: Fixture, token: string) {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/introspect`,
        headers: { authorization: `Bearer ${fx.liveKey}`, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ token }).toString(),
      })
      .then((r) => r.json() as Record<string, unknown>);
  }

  const oidOf = (token: string): unknown => (jwt.decode(token) as Record<string, unknown>).oid;

  // -------------------------------------------------------------------------
  // Consent
  // -------------------------------------------------------------------------

  it('asks which account to act for, offering only organizations the user can act for in this Application', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const other = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'pick@example.com');
    const stranger = await endUser(fx, 'stranger@example.com');
    const mine = await org(fx.appId, `mine-${n}`, [[userId, 'MEMBER']]);
    const notMine = await org(fx.appId, `not-mine-${n}`, [[stranger, 'OWNER']]);
    const otherAppOwner = await endUser(other, 'owner@example.com');
    const elsewhere = await org(other.appId, `elsewhere-${n}`, [[otherAppOwner, 'OWNER']]);

    const { challenge } = pkce();
    const step1 = await signInStep(fx, 'pick@example.com', challenge);
    expect(step1.statusCode).toBe(200);
    expect(step1.body).toContain('Choose an account for Claude');
    expect(step1.body).toContain('value="personal" checked');
    expect(step1.body).toContain(`value="${mine}"`);
    expect(step1.body).not.toContain(notMine);
    expect(step1.body).not.toContain(elsewhere);
    // The second step asks for no password: the sign-in is carried over.
    expect(step1.body).not.toContain('name="password"');
    expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
  });

  it('binds the chosen organization into the code, the access token and every refresh', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'bind@example.com');
    const orgId = await org(fx.appId, `bind-${n}`, [[userId, 'OWNER']]);

    const tokens = await connect(fx, 'bind@example.com', orgId);
    expect(oidOf(tokens.access_token)).toBe(orgId);
    const code = await prisma.oAuthAuthCode.findFirstOrThrow({ where: { applicationId: fx.appId } });
    expect(code.organizationId).toBe(orgId);

    const first = await refresh(fx, tokens.refresh_token);
    expect(first.statusCode, first.body).toBe(200);
    const rotated = first.json() as Tokens;
    expect(oidOf(rotated.access_token)).toBe(orgId);
    const second = await refresh(fx, rotated.refresh_token);
    expect(second.statusCode, second.body).toBe(200);
    expect(oidOf((second.json() as Tokens).access_token)).toBe(orgId);

    const state = await introspect(fx, rotated.access_token);
    expect(state).toMatchObject({ active: true, sub: userId, oid: orgId });
  });

  it('refuses a consent step whose request was edited after sign-in', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'tamper@example.com');
    const orgId = await org(fx.appId, `t-${n}`, [[userId, 'OWNER']]);
    const { challenge } = pkce();
    const token = consentTokenOf((await signInStep(fx, 'tamper@example.com', challenge)).body);
    // A different PKCE challenge would let whoever holds ITS verifier redeem.
    const swapped = await chooseStep(fx, token, orgId, pkce().challenge);
    expect(swapped.statusCode).toBe(200);
    expect(swapped.body).toContain('Your sign-in expired');
    const forged = await chooseStep(fx, `${token}x`, orgId, challenge);
    expect(forged.body).toContain('Your sign-in expired');
    expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
  });

  describe('the consent token pins what the sign-in step checked', () => {
    const REDIRECT_2 = 'http://localhost:9876/cb2';

    async function setup(): Promise<{ fx: Fixture; userId: string; orgId: string; challenge: string; token: string }> {
      const fx = await bootstrap({ billingSubject: 'org' });
      // The client registers a second redirect URI, so a swapped one passes
      // the client allowlist and only the consent token can refuse it.
      await prisma.oAuthClient.update({ where: { id: fx.clientId }, data: { redirectUris: [REDIRECT, REDIRECT_2] } });
      const userId = await endUser(fx, 'pin@example.com');
      const orgId = await org(fx.appId, `pin-${n}`, [[userId, 'OWNER']]);
      const { challenge } = pkce();
      const token = consentTokenOf((await signInStep(fx, 'pin@example.com', challenge)).body);
      return { fx, userId, orgId, challenge, token };
    }

    async function expectRefused(
      fx: Fixture,
      res: { statusCode: number; body: string },
    ): Promise<void> {
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.body).toContain('Your sign-in expired');
      expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
    }

    it('refuses a changed scope', async () => {
      const { fx, orgId, challenge, token } = await setup();
      await expectRefused(fx, await chooseStep(fx, token, orgId, challenge, { scope: 'openid mcp:account' }));
    });

    it('refuses a different registered redirect_uri', async () => {
      const { fx, orgId, challenge, token } = await setup();
      await expectRefused(fx, await chooseStep(fx, token, orgId, challenge, { redirect_uri: REDIRECT_2 }));
    });

    it('refuses once the user signs out everywhere after the sign-in step', async () => {
      const { fx, userId, orgId, challenge, token } = await setup();
      await prisma.endUser.update({
        where: { id: userId },
        data: { sessionsInvalidBefore: new Date(Date.now() + 2000) },
      });
      await expectRefused(fx, await chooseStep(fx, token, orgId, challenge));
    });

    it('refuses an eu_access, mcp_access or id_token presented as the consent token', async () => {
      const { fx, orgId, challenge } = await setup();
      const session = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${fx.liveKey}` },
        payload: { email: 'pin@example.com', password: PASSWORD },
      });
      expect(session.statusCode, session.body).toBe(200);
      const euAccess = (session.json().data as { accessToken: string }).accessToken;

      // An mcp_access token and an id_token for the same user, from an
      // openid-only grant (no organization step, so one-step consent).
      const oidc = pkce();
      const oidcTokens = (await redeem(
        fx,
        codeOf(await signInStep(fx, 'pin@example.com', oidc.challenge, 'openid')),
        oidc.verifier,
      )) as Tokens & { id_token: string };
      expect(oidcTokens.id_token).toBeTruthy();
      await prisma.oAuthAuthCode.deleteMany({ where: { applicationId: fx.appId } });

      for (const replay of [euAccess, oidcTokens.access_token, oidcTokens.id_token]) {
        await expectRefused(fx, await chooseStep(fx, replay, orgId, challenge));
      }
    });
  });

  it('refuses to redeem a bound code once the user has left the organization', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'redeem@example.com');
    const orgId = await org(fx.appId, `rd-${n}`, [[userId, 'OWNER']]);
    const { verifier, challenge } = pkce();
    const token = consentTokenOf((await signInStep(fx, 'redeem@example.com', challenge)).body);
    const code = codeOf(await chooseStep(fx, token, orgId, challenge));

    // Removed in the up-to-60 seconds between consent and redemption.
    await prisma.organizationMembership.deleteMany({ where: { organizationId: orgId, endUserId: userId } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/${fx.slug}/oauth/token`,
      ...form({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: fx.clientId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, kind: 'mcp' } })).toBe(0);
  });

  it('refuses userinfo too once the binding lapses', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'ui@example.com');
    const orgId = await org(fx.appId, `ui-${n}`, [[userId, 'OWNER']]);
    const { verifier, challenge } = pkce();
    const step1 = await signInStep(fx, 'ui@example.com', challenge, 'openid mcp:account');
    const step2 = await chooseStep(fx, consentTokenOf(step1.body), orgId, challenge, { scope: 'openid mcp:account' });
    const tokens = await redeem(fx, codeOf(step2), verifier);
    const userinfo = () =>
      app.inject({
        method: 'GET',
        url: `/api/v1/mcp/${fx.slug}/oauth/userinfo`,
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
    expect((await userinfo()).statusCode).toBe(200);
    await prisma.organizationMembership.deleteMany({ where: { organizationId: orgId, endUserId: userId } });
    const refused = await userinfo();
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: 'invalid_token' });
  });

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  it('in an org-billed Application every billing tool answers for the bound organization', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'tools@example.com');
    const orgId = await org(fx.appId, `tools-${n}`, [[userId, 'OWNER']]);
    await seedBilling(fx, userId, orgId);
    const pooled = await teammatePoolLicence(fx, orgId);
    const { access_token } = await connect(fx, 'tools@example.com', orgId);

    const profile = await tool<{ email: string; organization: Record<string, unknown> }>(fx, access_token, 'get_profile');
    expect(profile.email).toBe('tools@example.com');
    expect(profile.organization).toMatchObject({ id: orgId, name: `Org tools-${n}`, role: 'OWNER', baseRole: 'OWNER' });

    const sub = await tool<{ plan: { slug: string }; organizationId: string }>(fx, access_token, 'get_subscription');
    expect(sub.plan.slug).toBe('crew');
    expect(sub.organizationId).toBe(orgId);

    expect(await tool(fx, access_token, 'get_credits')).toEqual({ balance: 900, organizationId: orgId });

    // The caller's own licences (personal and the one they bought for the
    // team) plus the teammate's pooled one: what the REST route returns for a
    // session acting for the same organization.
    const lic = await tool<{ licenses: Array<{ id: string; seatsAllowed: number }>; organizationId: string }>(
      fx,
      access_token,
      'list_licenses',
    );
    expect(lic.licenses.map((l) => l.seatsAllowed)).toEqual([5, 25, 1]);
    expect(lic.licenses.map((l) => l.id)).toContain(pooled);
    expect(lic.organizationId).toBe(orgId);
    expect(lic.licenses.map((l) => l.id)).toEqual(await restLicenceIds(fx, 'tools@example.com', orgId));
    expect(JSON.stringify(lic)).not.toContain('keyHash');
    expect(lic).toMatchObject({ truncated: false });

    // Devices belong to a person, whatever the connection acts for.
    expect(await tool(fx, access_token, 'list_my_devices')).toEqual({ devices: [] });
  });

  it('in a user-billed Application the billing tools stay personal; get_profile still names the organization', async () => {
    const fx = await bootstrap({ billingSubject: 'user' });
    const userId = await endUser(fx, 'userbilled@example.com');
    const orgId = await org(fx.appId, `ub-${n}`, [[userId, 'OWNER']]);
    await seedBilling(fx, userId, orgId);
    const pooled = await teammatePoolLicence(fx, orgId);
    const { access_token } = await connect(fx, 'userbilled@example.com', orgId);

    expect(oidOf(access_token)).toBe(orgId);
    expect((await tool<{ organization: { id: string } }>(fx, access_token, 'get_profile')).organization.id).toBe(orgId);
    const sub = await tool<{ plan: { slug: string }; organizationId: null }>(fx, access_token, 'get_subscription');
    expect(sub.plan.slug).toBe('solo');
    expect(sub.organizationId).toBeNull();
    expect(await tool(fx, access_token, 'get_credits')).toEqual({ balance: 7, organizationId: null });
    // Only the caller's own licences; the teammate's pooled one is not theirs
    // in a user-billed Application, as on the REST route.
    const lic = await tool<{ licenses: Array<{ id: string }>; organizationId: null }>(fx, access_token, 'list_licenses');
    expect(lic.organizationId).toBeNull();
    expect(lic.licenses.map((l) => l.id)).not.toContain(pooled);
    expect(lic.licenses).toHaveLength(2);
    expect(lic.licenses.map((l) => l.id)).toEqual(await restLicenceIds(fx, 'userbilled@example.com', orgId));
  });

  it('a MEMBER-tier user reads the organization, as the HTTP billing reads allow any member to', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const owner = await endUser(fx, 'owner@example.com');
    const member = await endUser(fx, 'member@example.com');
    const orgId = await org(fx.appId, `m-${n}`, [
      [owner, 'OWNER'],
      [member, 'MEMBER'],
    ]);
    await prisma.creditBalance.create({
      data: { applicationId: fx.appId, organizationId: orgId, subjectKey: `o:${orgId}`, balance: 42 },
    });
    const { access_token } = await connect(fx, 'member@example.com', orgId);
    const profile = await tool<{ organization: { role: string; baseRole: string } }>(fx, access_token, 'get_profile');
    expect(profile.organization).toMatchObject({ role: 'MEMBER', baseRole: 'MEMBER' });
    expect(await tool(fx, access_token, 'get_credits')).toEqual({ balance: 42, organizationId: orgId });
  });

  // -------------------------------------------------------------------------
  // Lapse: fail closed
  // -------------------------------------------------------------------------

  it('leaving the organization stops the access token and fails the refresh, leaving the chain intact', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'leaver@example.com');
    const orgId = await org(fx.appId, `leave-${n}`, [[userId, 'OWNER']]);
    const tokens = await connect(fx, 'leaver@example.com', orgId);
    expect((await callToolRaw(fx, tokens.access_token, 'get_credits')).statusCode).toBe(200);

    await prisma.organizationMembership.deleteMany({ where: { organizationId: orgId, endUserId: userId } });

    const live = await callToolRaw(fx, tokens.access_token, 'get_credits');
    expect(live.statusCode).toBe(401);
    expect(live.json()).toMatchObject({ error: 'invalid_token' });
    expect(await introspect(fx, tokens.access_token)).toEqual({ active: false });

    const refused = await refresh(fx, tokens.refresh_token);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: 'invalid_grant' });
    expect(refused.json().error_description).toContain('no longer act for');

    // Refused before rotation: nothing was revoked, so rejoining resumes.
    await prisma.organizationMembership.create({ data: { organizationId: orgId, endUserId: userId, role: 'MEMBER' } });
    const resumed = await refresh(fx, tokens.refresh_token);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(oidOf((resumed.json() as Tokens).access_token)).toBe(orgId);
  });

  it('a deleted organization fails the refresh rather than turning the grant personal', async () => {
    const fx = await bootstrap({ billingSubject: 'org' });
    const userId = await endUser(fx, 'deleted@example.com');
    const orgId = await org(fx.appId, `del-${n}`, [[userId, 'OWNER']]);
    const tokens = await connect(fx, 'deleted@example.com', orgId);
    await prisma.organization.delete({ where: { id: orgId } });
    const row = await prisma.refreshToken.findFirstOrThrow({ where: { endUserId: userId, kind: 'mcp' } });
    expect(row.grantOrganizationId).toBe(orgId);
    expect((await refresh(fx, tokens.refresh_token)).json()).toMatchObject({ error: 'invalid_grant' });
  });

  // -------------------------------------------------------------------------
  // Grants made before the binding existed
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // App-authorised session handoff
  // -------------------------------------------------------------------------

  describe('session handoff', () => {
    async function session(fx: Fixture, email: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: { authorization: `Bearer ${fx.liveKey}` },
        payload: { email, password: PASSWORD },
      });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().data as { accessToken: string }).accessToken;
    }

    function handoff(fx: Fixture, userToken: string, challenge: string, extra: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: `/api/v1/mcp/${fx.slug}/oauth/authorize/grant`,
        headers: { authorization: `Bearer ${fx.liveKey}`, 'x-rekey-user-token': userToken },
        payload: {
          client_id: fx.clientId,
          redirect_uri: REDIRECT,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:account',
          ...extra,
        },
      });
    }

    it('binds only an explicit organization_id; omitted or null is personal even with an active organization', async () => {
      const fx = await bootstrap({ billingSubject: 'org' });
      const userId = await endUser(fx, 'h@example.com');
      const orgId = await org(fx.appId, `h-${n}`, [[userId, 'OWNER']]);
      const plain = await session(fx, 'h@example.com');

      const explicit = pkce();
      const r1 = await handoff(fx, plain, explicit.challenge, { organization_id: orgId });
      expect(r1.statusCode, r1.body).toBe(200);
      const t1 = await redeem(fx, (r1.json() as { code: string }).code, explicit.verifier);
      expect(oidOf(t1.access_token)).toBe(orgId);

      const switched = await app.inject({
        method: 'POST',
        url: `/api/v1/users/me/organizations/${orgId}/switch`,
        headers: { authorization: `Bearer ${fx.liveKey}`, 'x-rekey-user-token': plain },
      });
      expect(switched.statusCode, switched.body).toBe(200);
      const acting = (switched.json().data as { accessToken: string }).accessToken;

      // The session acts for the organization, and still an omitted field is
      // personal: an integration written before the binding must not start
      // acting for a team without asking for it.
      expect(oidOf(acting)).toBe(orgId);
      const omitted = pkce();
      const r2 = await handoff(fx, acting, omitted.challenge, {});
      expect(r2.statusCode, r2.body).toBe(200);
      const t2 = await redeem(fx, (r2.json() as { code: string }).code, omitted.verifier);
      expect(oidOf(t2.access_token)).toBeUndefined();
      const code2 = await prisma.oAuthAuthCode.findFirstOrThrow({
        where: { applicationId: fx.appId },
        orderBy: { createdAt: 'desc' },
      });
      expect(code2.organizationId).toBeNull();

      const personal = pkce();
      const r3 = await handoff(fx, acting, personal.challenge, { organization_id: null });
      const t3 = await redeem(fx, (r3.json() as { code: string }).code, personal.verifier);
      expect(oidOf(t3.access_token)).toBeUndefined();
    });

    it('refuses an organization the user is not in, one from another Application, and a non-MCP grant', async () => {
      const fx = await bootstrap({ billingSubject: 'org' });
      const other = await bootstrap({ billingSubject: 'org' });
      const userId = await endUser(fx, 'hx@example.com');
      const stranger = await endUser(fx, 'hs@example.com');
      const mine = await org(fx.appId, `hm-${n}`, [[userId, 'OWNER']]);
      const notMine = await org(fx.appId, `hn-${n}`, [[stranger, 'OWNER']]);
      const otherOwner = await endUser(other, 'ho@example.com');
      const elsewhere = await org(other.appId, `he-${n}`, [[otherOwner, 'OWNER']]);
      const token = await session(fx, 'hx@example.com');

      for (const target of [notMine, elsewhere]) {
        const res = await handoff(fx, token, pkce().challenge, { organization_id: target });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
      }
      const oidcOnly = await handoff(fx, token, pkce().challenge, { organization_id: mine, scope: 'openid' });
      expect(oidcOnly.statusCode).toBe(400);
      expect(oidcOnly.json().error.code).toBe('INVALID_GRANT_REQUEST');
      expect(await prisma.oAuthAuthCode.count({ where: { applicationId: fx.appId } })).toBe(0);
    });
  });
});
