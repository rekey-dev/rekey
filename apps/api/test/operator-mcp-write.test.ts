/**
 * Operator MCP write tools (phase 1).
 *
 * Load-bearing security cases:
 *   - a read-only credential never SEES the write tools and is refused if it
 *     calls one anyway (no silent execution);
 *   - a write credential held by an OWNER/ADMIN can create + modify workspace
 *     config, and the change really lands;
 *   - write tools re-scope by tenant — another workspace's applicationId is
 *     indistinguishable from a non-existent one (no cross-tenant write);
 *   - role gating: write scope alone is not enough; the role must clear the
 *     tool's minimum (MEMBER is refused).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { handleOperatorMcpMessage } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

interface OperatorSession {
  accessToken: string;
  tenantId: string;
  userId: string;
}

describe('Operator MCP write tools', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function makeOperator(slug: string): Promise<OperatorSession> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `mcpw-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: `WS ${slug}`,
      },
    });
    const data = res.json().data as {
      accessToken: string;
      activeTenantId: string;
      user: { id: string };
    };
    return { accessToken: data.accessToken, tenantId: data.activeTenantId, userId: data.user.id };
  }

  async function mintPat(session: OperatorSession, scopes: string[]): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { name: 'mcp-agent', scopes },
    });
    expect(res.statusCode).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
  }

  /** POST a single JSON-RPC message to the operator MCP endpoint with a Bearer. */
  async function rpc(token: string, method: string, params?: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    });
    return res;
  }

  /** Parse a tools/call reply into { isError, data }. */
  function readToolResult(body: string): { isError: boolean; data: unknown } {
    const parsed = JSON.parse(body) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    return {
      isError: parsed.result.isError === true,
      data: JSON.parse(parsed.result.content[0]!.text),
    };
  }

  it('a read-only PAT does not see the write tools and is refused if it calls one', async () => {
    const op = await makeOperator('ro');
    const token = await mintPat(op, ['read']);

    const list = await rpc(token, 'tools/list');
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('list_applications'); // read tool present
    expect(names).not.toContain('create_application'); // write tool hidden

    const call = await rpc(token, 'tools/call', {
      name: 'create_application',
      arguments: { name: 'Nope', slug: 'ro-nope' },
    });
    const { isError, data } = readToolResult(call.body);
    expect(isError).toBe(true);
    expect((data as { error: string }).error).toMatch(/write access/i);

    // Nothing was created.
    const found = await prisma.application.findUnique({ where: { slug: 'ro-nope' } });
    expect(found).toBeNull();
  });

  it('an agent can build a plan that actually grants something, and read it back', async () => {
    // The gap this closes: create_plan could only make a priced plan, and the
    // tool named update_plan patches Plan columns rather than the entitlement
    // table. So an agent could produce a plan, be told it succeeded, and have
    // it gate nothing — discovered only when a real user hit a locked feature.
    const op = await makeOperator('ent');
    const token = await mintPat(op, ['read', 'applications:write']);

    const app = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'create_application',
        arguments: { name: 'Ent App', slug: `ent-${Date.now()}` },
      })).body,
    );
    const applicationId = (app.data as { id: string }).id;

    await rpc(token, 'tools/call', {
      name: 'create_plan',
      arguments: { applicationId, slug: 'pro', name: 'Pro', amount: 2900 },
    });

    const put = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'put_plan_entitlement',
        arguments: {
          applicationId,
          planSlug: 'pro',
          kind: 'FEATURE',
          key: 'advanced_reporting',
          valueType: 'BOOL',
          value: 'true',
        },
      })).body,
    );
    expect(put.isError).toBe(false);

    const listed = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'list_plan_entitlements',
        arguments: { applicationId, planSlug: 'pro' },
      })).body,
    );
    expect(listed.isError).toBe(false);
    expect((listed.data as { entitlements: unknown[] }).entitlements).toHaveLength(1);
  });

  it('mint_api_key is admin-tier, so a write-only PAT cannot mint a live credential', async () => {
    // The REST twin requires the `keys:mint` scope. MCP write access derives
    // from `applications:write` alone, so without the admin gate this token
    // would mint over MCP what it is refused over REST.
    const op = await makeOperator('mint');
    const token = await mintPat(op, ['read', 'applications:write']);

    const list = await rpc(token, 'tools/list');
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).not.toContain('mint_api_key');

    const res = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'mint_api_key',
        arguments: { applicationId: 'anything', name: 'nope' },
      })).body,
    );
    expect(res.isError).toBe(true);
  });

  it('a write PAT held by an OWNER can create + configure an application', async () => {
    const op = await makeOperator('rw');
    const token = await mintPat(op, ['read', 'applications:write']);

    const list = await rpc(token, 'tools/list');
    const names = (list.json().result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('create_application');

    // create_application
    const created = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'create_application',
        arguments: { name: 'MCP Made', slug: 'rw-made' },
      })).body,
    );
    expect(created.isError).toBe(false);
    const appId = (created.data as { id: string }).id;
    const row = await prisma.application.findUnique({ where: { id: appId } });
    expect(row?.tenantId).toBe(op.tenantId);

    // update_auth_config — flip mcpEnabled on
    const updated = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'update_auth_config',
        arguments: { applicationId: appId, mcpEnabled: true },
      })).body,
    );
    expect(updated.isError).toBe(false);
    expect((updated.data as { authConfig: { mcpEnabled: boolean } }).authConfig.mcpEnabled).toBe(
      true,
    );

    // create_plan
    const plan = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'create_plan',
        arguments: { applicationId: appId, slug: 'pro', name: 'Pro', amount: 1500 },
      })).body,
    );
    expect(plan.isError).toBe(false);
    expect((plan.data as { amount: number }).amount).toBe(1500);

    // create_webhook_endpoint — secret shown once
    const hook = readToolResult(
      (await rpc(token, 'tools/call', {
        name: 'create_webhook_endpoint',
        arguments: { applicationId: appId, url: 'https://example.com/hook', events: ['*'] },
      })).body,
    );
    expect(hook.isError).toBe(false);
    expect(typeof (hook.data as { secret: string }).secret).toBe('string');

    // A security event was logged for the create. Fire-and-forget, so wait.
    const events = await waitForSecurityEvents({ tenantId: op.tenantId, type: 'app.created' });
    expect((events[0]!.metadata as { via?: string }).via).toBe('operator_mcp');
  });

  it("cannot write to another workspace's application (cross-tenant guard)", async () => {
    const victim = await makeOperator('victim');
    const victimToken = await mintPat(victim, ['read', 'applications:write']);
    const created = readToolResult(
      (await rpc(victimToken, 'tools/call', {
        name: 'create_application',
        arguments: { name: 'Victim', slug: 'victim-app' },
      })).body,
    );
    const victimAppId = (created.data as { id: string }).id;

    const attacker = await makeOperator('attacker');
    const attackerToken = await mintPat(attacker, ['read', 'applications:write']);

    const attempt = readToolResult(
      (await rpc(attackerToken, 'tools/call', {
        name: 'update_auth_config',
        arguments: { applicationId: victimAppId, mcpEnabled: true },
      })).body,
    );
    expect(attempt.isError).toBe(true);
    expect((attempt.data as { error: string }).error).toMatch(/not found in this workspace/i);

    // Victim app untouched.
    const row = await prisma.application.findUnique({ where: { id: victimAppId } });
    const cfg = row?.authConfig as { mcpEnabled?: boolean };
    expect(cfg.mcpEnabled ?? false).toBe(false);
  });

  it("cannot update another workspace's webhook endpoint by passing your own appId", async () => {
    // Vector: attacker owns appId A (clears loadAppInTenant) but targets a
    // victim endpointId from app B. The endpoint write must be scoped by
    // (id, applicationId), so the mismatch resolves to not-found.
    const victim = await makeOperator('hook-victim');
    const vToken = await mintPat(victim, ['read', 'applications:write']);
    const vApp = (
      readToolResult(
        (await rpc(vToken, 'tools/call', {
          name: 'create_application',
          arguments: { name: 'HV', slug: 'hook-victim-app' },
        })).body,
      ).data as { id: string }
    ).id;
    const vHook = readToolResult(
      (await rpc(vToken, 'tools/call', {
        name: 'create_webhook_endpoint',
        arguments: { applicationId: vApp, url: 'https://victim.example/hook', events: ['*'] },
      })).body,
    ).data as { id: string };

    const attacker = await makeOperator('hook-attacker');
    const aToken = await mintPat(attacker, ['read', 'applications:write']);
    const aApp = (
      readToolResult(
        (await rpc(aToken, 'tools/call', {
          name: 'create_application',
          arguments: { name: 'HA', slug: 'hook-attacker-app' },
        })).body,
      ).data as { id: string }
    ).id;

    const attempt = readToolResult(
      (await rpc(aToken, 'tools/call', {
        name: 'update_webhook_endpoint',
        arguments: { applicationId: aApp, endpointId: vHook.id, enabled: false },
      })).body,
    );
    expect(attempt.isError).toBe(true);

    // Victim endpoint untouched (still enabled).
    const row = await prisma.webhookEndpoint.findUnique({ where: { id: vHook.id } });
    expect(row?.enabled).toBe(true);
  });

  it('role gating: write scope is not enough — MEMBER is refused (direct dispatch)', async () => {
    // Exercise the dispatcher's role gate without provisioning a second-seat
    // MEMBER: a token CAN carry write scope while the operator is only a MEMBER.
    const memberCtx = {
      tenantUserId: 'tu_member',
      tenantId: 't_member',
      role: 'MEMBER' as const,
      canWrite: true,
    };
    const list = (await handleOperatorMcpMessage(memberCtx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).not.toContain('create_application');

    const call = (await handleOperatorMcpMessage(memberCtx, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_application', arguments: { name: 'x', slug: 'x' } },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(call.result.isError).toBe(true);
    expect(JSON.parse(call.result.content[0]!.text).error).toMatch(/role/i);
  });

  describe('the READ tools that live in this file are grant-scoped, like their REST twins', () => {
    // `list_plans`, `list_plan_entitlements`, `list_usage_meters` and
    // `list_api_keys` are declared here, next to the writes, but they carry
    // neither `write` nor `admin` nor a `minRole` — so the dispatcher's role
    // gate does not apply to them and any MEMBER may call them. They resolved
    // their Application through a helper that checked the WORKSPACE and not the
    // caller's per-application grants, so a MEMBER with zero grants could read
    // the plan and pricing catalogue, and API-key metadata, for every
    // Application in the workspace. The REST routes enforce grants; the
    // read-tool set in operator-tools.ts enforces grants; this file was the
    // seam between them.
    async function memberWithoutGrants(slug: string): Promise<{
      ctx: { tenantUserId: string; tenantId: string; role: 'MEMBER'; canWrite: boolean;
             tenantMembershipId: string };
      applicationId: string;
      membershipId: string;
      ownerToken: string;
      memberUserId: string;
    }> {
      const owner = await makeOperator(slug);
      const appRes = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: `App ${slug}`, slug: `app-${slug}` },
      });
      expect(appRes.statusCode).toBe(201);
      const applicationId = (appRes.json().data as { id: string }).id;

      // A second seat in the SAME workspace, with no ApplicationGrant rows.
      const memberUser = await prisma.tenantUser.create({
        data: { email: `member-${slug}@example.com`, passwordHash: 'x' },
        select: { id: true },
      });
      const membership = await prisma.tenantMembership.create({
        data: { tenantUserId: memberUser.id, tenantId: owner.tenantId, role: 'MEMBER' },
        select: { id: true },
      });
      return {
        ctx: {
          tenantUserId: memberUser.id,
          tenantId: owner.tenantId,
          role: 'MEMBER' as const,
          canWrite: false,
          tenantMembershipId: membership.id,
        },
        applicationId,
        membershipId: membership.id,
        ownerToken: owner.accessToken,
        memberUserId: memberUser.id,
      };
    }

    async function callTool(
      ctx: Record<string, unknown>,
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; text: string }> {
      const res = (await handleOperatorMcpMessage(ctx as never, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name, arguments: args },
      })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      return { isError: res.result.isError === true, text: res.result.content[0]!.text };
    }

    it.each(['list_plans', 'list_plan_entitlements', 'list_usage_meters', 'list_api_keys'])(
      'refuses %s on an Application the MEMBER holds no grant for',
      async (tool) => {
        const { ctx, applicationId, ownerToken } = await memberWithoutGrants(
          `ng${tool.replace(/_/g, '').slice(4, 10)}`,
        );
        // A REAL plan, so `list_plan_entitlements` reaches the grant check
        // instead of dying on PLAN_NOT_FOUND. Without it that one case passed
        // for the wrong reason: unfixed it still set `isError`, and only the
        // error WORDING separated pass from fail — reword the service's
        // message and the test silently stops testing anything.
        await app.inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${applicationId}/plans`,
          headers: { authorization: `Bearer ${ownerToken}` },
          payload: { slug: 'real', name: 'Real', amount: 100 },
        });

        const out = await callTool(ctx, tool, {
          applicationId,
          ...(tool === 'list_plan_entitlements' ? { planSlug: 'real' } : {}),
        });

        expect(out.isError).toBe(true);
        // Asserted on the CODE, not the prose. Same answer as an Application in
        // another workspace: a denied id must not be distinguishable from an
        // absent one.
        expect(JSON.parse(out.text).code ?? JSON.parse(out.text).error).toMatch(
          /APPLICATION_NOT_FOUND|not found in this workspace/i,
        );
      },
    );

    it('threads the grant through the REAL auth path, not just direct dispatch', async () => {
      // The cases above hand-build the tool context, which means they set
      // `tenantMembershipId` themselves — the very field the grant check needs.
      // `accessibleApplicationIds` fails CLOSED without it, so a regression in
      // how `bearer-auth.ts` or `tenant-mcp.routes.ts` populate it would deny
      // every granted MEMBER in production while those tests stayed green.
      // This one goes over HTTP with a real PAT so that threading is pinned.
      const owner = await makeOperator('thread-owner');
      const appRes = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: 'Threaded', slug: `threaded-${Date.now()}` },
      });
      const applicationId = (appRes.json().data as { id: string }).id;

      // A real operator with their own workspace, then seated in the owner's.
      const member = await makeOperator('thread-member');
      const membership = await prisma.tenantMembership.create({
        data: { tenantUserId: member.userId, tenantId: owner.tenantId, role: 'MEMBER' },
        select: { id: true },
      });
      await prisma.applicationGrant.create({
        data: { tenantMembershipId: membership.id, applicationId, role: 'APP_VIEWER' },
      });

      // A PAT is scoped to the ACTIVE workspace and gated by the role held
      // THERE, so this member has to switch into the owner's workspace before a
      // PAT would be of any use against it — and once switched, the mint is
      // refused: `operator-tokens.routes.ts` allows only OWNER/ADMIN.
      //
      // That leaves OAuth as the only credential a MEMBER can bring to MCP, and
      // therefore the only path by which the bug this fixes was ever reachable.
      // Worth pinning: it narrows the original exposure, and if PAT minting is
      // ever opened to MEMBERs this assertion says so out loud.
      const switched = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/switch-workspace',
        headers: { authorization: `Bearer ${member.accessToken}` },
        payload: { tenantId: owner.tenantId },
      });
      expect(switched.statusCode, switched.body).toBe(200);
      const inOwnersWorkspace = (switched.json().data as { accessToken: string }).accessToken;
      const patAttempt = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/api-tokens',
        headers: { authorization: `Bearer ${inOwnersWorkspace}` },
        payload: { name: 'member-pat', scopes: ['read'] },
      });
      expect(patAttempt.statusCode).toBe(403);

      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
      const clientId = await app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/mcp/oauth/register',
          payload: { redirect_uris: [redirectUri], client_name: 'Claude' },
        })
        .then((r) => (r.json() as { client_id: string }).client_id);

      // The member consents for the OWNER's workspace, which they are a member
      // of. `grantScopes` hands out write on request regardless of role — the
      // dispatcher's role gate is what stops them using it.
      const grant = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp/oauth/grant',
        headers: { authorization: `Bearer ${member.accessToken}` },
        payload: {
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          scope: 'mcp:operator:read mcp:operator:write',
          state: 'st',
          tenant_id: owner.tenantId,
          approve: true,
        },
      });
      expect(grant.statusCode, grant.body).toBe(200);
      const code = new URL(
        (grant.json() as { data: { redirect: string } }).data.redirect,
      ).searchParams.get('code');

      const memberMcpToken = await app
        .inject({
          method: 'POST',
          url: '/api/v1/tenant/mcp/oauth/token',
          payload: {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            client_id: clientId,
          },
        })
        .then((r) => (r.json() as { access_token: string }).access_token);

      const granted = readToolResult(
        (await rpc(memberMcpToken, 'tools/call', {
          name: 'list_plans',
          arguments: { applicationId },
        })).body,
      );
      expect(granted.isError, JSON.stringify(granted.data)).toBe(false);

      // And the negative half over the same path: a SECOND application in the
      // same workspace, which this member holds no grant for.
      const otherRes = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: 'Ungranted', slug: `ungranted-${Date.now()}` },
      });
      const otherId = (otherRes.json().data as { id: string }).id;
      const refused = readToolResult(
        (await rpc(memberMcpToken, 'tools/call', {
          name: 'list_plans',
          arguments: { applicationId: otherId },
        })).body,
      );
      expect(refused.isError).toBe(true);
    });

    it('allows the same read once the MEMBER is granted that Application', async () => {
      // The positive half. Without it, a change that refused every MEMBER
      // everywhere would leave the four cases above green while breaking the
      // feature grants exist to provide.
      const { ctx, applicationId, membershipId } = await memberWithoutGrants('granted');
      await prisma.applicationGrant.create({
        data: { tenantMembershipId: membershipId, applicationId, role: 'APP_VIEWER' },
      });

      const out = await callTool(ctx, 'list_plans', { applicationId });

      expect(out.isError).toBe(false);
      expect(JSON.parse(out.text)).toHaveProperty('plans');
    });
  });

  describe('register_plan_with_provider leaves the same audit trail as every other write tool', () => {
    // This tool had no test at all, and nothing anywhere asserted on `via`,
    // which is how its audit call drifted. It wrote the security event by
    // hand instead of through this file's `audit` helper, so the one entry
    // recording that an agent minted a LIVE price at a payment provider was
    // also the only one that could not be traced to a request: no `ip`, no
    // `userAgent`, and `via: 'mcp'` where every other tool writes
    // `via: 'operator_mcp'`, which silently drops it out of any query
    // filtering on that.

    it('records ip, userAgent and via: operator_mcp', async () => {
      const op = await makeOperator('regaudit');
      const token = await mintPat(op, ['read', 'applications:write']);

      const appId = (
        readToolResult(
          (
            await rpc(token, 'tools/call', {
              name: 'create_application',
              arguments: { name: 'RegAudit', slug: 'reg-audit', enableBilling: true },
            })
          ).body,
        ).data as { id: string }
      ).id;

      // registerWithProvider dials the provider, so the Application needs
      // credentials. test/setup.ts swaps in a fake, so nothing is reached.
      await configureSandboxStripe(appId);

      readToolResult(
        (
          await rpc(token, 'tools/call', {
            name: 'create_plan',
            arguments: { applicationId: appId, slug: 'pro', name: 'Pro', amount: 2900 },
          })
        ).body,
      );

      // Sent with an explicit User-Agent, because the assertion is that the
      // request context reaches the audit row, and `inject` sends none by
      // default.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenant/mcp',
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'probe-agent/1.0' },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'register_plan_with_provider',
            arguments: { applicationId: appId, planSlug: 'pro' },
          },
        },
      });
      expect(readToolResult(res.body).isError).toBe(false);

      const events = await waitForSecurityEvents({
        tenantId: op.tenantId,
        type: 'app.plan_updated',
      });
      const event = events[0]!;
      expect((event.metadata as { via?: string }).via).toBe('operator_mcp');
      expect((event.metadata as { planSlug?: string }).planSlug).toBe('pro');
      expect(event.applicationId).toBe(appId);
      // The three the hand-rolled call dropped.
      expect(event.ip).not.toBeNull();
      expect(event.userAgent).toBe('probe-agent/1.0');
    });
  });
});
