/**
 * Who may mint a key carrying an elevated scope.
 *
 * `credits:grant` mints credits, so a key holding it needs the authority of
 * the panel credit grant (billing-write access plus the `billing:write`
 * operator scope), not just the `developer:write` that minting a key needs.
 * The case this exists for: a MEMBER with APP_ADMIN whose scopes an owner
 * narrowed to exclude billing is refused the panel grant, and must not be
 * able to mint themselves a key that grants anyway. Every path that sets key
 * scopes is covered: the tenant route, the operator PAT route and the MCP
 * `mint_api_key` tool.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorWriteTools } from '../src/modules/tenant-mcp/operator-write-tools.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { ALL_SCOPES, UNRESTRICTED, type Scope } from '../src/lib/operator-scopes.js';

describe('minting a key with an elevated scope', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let ip = '10.98.0.1';
  const inject = (opts: Record<string, unknown>) => app.inject({ remoteAddress: ip, ...opts } as never);
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  /** Every operator scope except billing:write. */
  const NO_BILLING_WRITE = ALL_SCOPES.filter((s) => s !== 'billing:write');

  interface World {
    ownerToken: string;
    ownerUserId: string;
    tenantId: string;
    memberToken: string;
    memberUserId: string;
    membershipId: string;
    appId: string;
    endUserId: string;
  }

  async function world(): Promise<World> {
    ip = `10.98.${++n}.1`;
    const tag = `esm-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Esm Co' },
    });
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;
    const appId = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(ownerToken),
      payload: { name: tag, slug: tag, enableBilling: true },
    }).then((r) => (r.json().data as { id: string }).id);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });

    const invitee = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `member-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Member Co' },
    });
    const inviteeToken = (invitee.json().data as { accessToken: string }).accessToken;
    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(ownerToken),
      payload: { email: `member-${tag}@example.com`, role: 'MEMBER' },
    });
    const acc = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(inviteeToken),
      payload: { token: (inv.json().data as { token: string }).token },
    });
    const memberToken = (acc.json().data as { accessToken: string }).accessToken;
    const members = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: auth(ownerToken) });
    const membershipId = (
      members.json().data as { items: Array<{ membershipId: string; role: string }> }
    ).items.find((m) => m.role === 'MEMBER')!.membershipId;
    await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(ownerToken),
      payload: { applicationId: appId, role: 'APP_ADMIN' },
    });
    const membership = await prisma.tenantMembership.findUniqueOrThrow({ where: { id: membershipId } });
    const ownerMembership = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantId: application.tenantId, role: 'OWNER' },
    });
    const endUserId = (
      await prisma.endUser.create({ data: { applicationId: appId, email: `eu-${tag}@example.com` } })
    ).id;
    return {
      ownerToken,
      ownerUserId: ownerMembership.tenantUserId,
      tenantId: application.tenantId,
      memberToken,
      memberUserId: membership.tenantUserId,
      membershipId,
      appId,
      endUserId,
    };
  }

  const restrict = (w: World, scopes: string[] | null) =>
    inject({
      method: 'PATCH',
      url: `/api/v1/tenant/workspace/members/${w.membershipId}`,
      headers: auth(w.ownerToken),
      payload: { scopes },
    });

  const mint = (w: World, token: string, scopes: string[]) =>
    inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.appId}/api-keys`,
      headers: auth(token),
      payload: { name: `k-${scopes.join('+')}`, scopes },
    });

  describe('tenant route', () => {
    it('refuses a MEMBER who is refused the panel credit grant, and mints nothing', async () => {
      const w = await world();
      expect((await restrict(w, NO_BILLING_WRITE)).statusCode).toBe(200);

      // The authority being mirrored: the panel grant refuses this member.
      const panelGrant = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${w.appId}/end-users/${w.endUserId}/credits/grant`,
        headers: auth(w.memberToken),
        payload: { amount: 10 },
      });
      expect(panelGrant.statusCode).toBe(403);

      // They can still mint an ordinary key (developer:write is intact)...
      expect((await mint(w, w.memberToken, ['billing:read'])).statusCode).toBe(201);
      // ...but not one that grants credits, alone or alongside `*`.
      for (const scopes of [['credits:grant'], ['*', 'credits:grant']]) {
        const res = await mint(w, w.memberToken, scopes);
        expect(res.statusCode, JSON.stringify(scopes)).toBe(403);
        expect(res.json().error.code).toBe('SCOPE_INSUFFICIENT');
      }
      const minted = await prisma.apiKey.findMany({ where: { applicationId: w.appId } });
      expect(minted.some((k) => k.scopes.includes('credits:grant'))).toBe(false);
    });

    it('allows a MEMBER who holds billing:write, and the owner', async () => {
      const w = await world();
      expect((await mint(w, w.memberToken, ['credits:grant'])).statusCode).toBe(201);
      expect((await mint(w, w.ownerToken, ['*', 'credits:grant'])).statusCode).toBe(201);
    });
  });

  describe('MCP mint_api_key', () => {
    const tool = operatorWriteTools.find((t) => t.name === 'mint_api_key')!;
    const memberCtx = (w: World, scopes: ReadonlySet<Scope>): OperatorToolContext => ({
      tenantUserId: w.memberUserId,
      tenantId: w.tenantId,
      role: 'MEMBER',
      tenantMembershipId: w.membershipId,
      scopes,
      canWrite: true,
      canAdmin: true,
    });

    it('refuses the same MEMBER, and allows one with billing:write', async () => {
      const w = await world();
      await expect(
        tool.handler(memberCtx(w, new Set(NO_BILLING_WRITE)), {
          applicationId: w.appId,
          name: 'mcp-grant',
          scopes: ['credits:grant'],
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_INSUFFICIENT' });
      const ok = (await tool.handler(memberCtx(w, UNRESTRICTED), {
        applicationId: w.appId,
        name: 'mcp-grant-ok',
        scopes: ['credits:grant'],
      })) as { scopes: string[] };
      expect(ok.scopes).toEqual(['credits:grant']);
    });
  });

  describe('operator PAT route', () => {
    const mintPat = async (w: World, scopes: string[]) =>
      inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/api-tokens',
        headers: auth(w.ownerToken),
        payload: { name: `pat-${scopes.join('+')}`, scopes },
      }).then((r) => (r.json().data as { rawToken: string }).rawToken);

    const patMint = (w: World, pat: string, scopes: string[]) =>
      inject({
        method: 'POST',
        url: `/api/v1/tenant/operator/applications/${w.appId}/api-keys`,
        headers: auth(pat),
        payload: { name: 'via-pat', scopes },
      });

    it('a keys:mint-only PAT cannot mint an elevated key, even for the owner', async () => {
      const w = await world();
      const pat = await mintPat(w, ['keys:mint']);
      const plain = await patMint(w, pat, ['billing:read']);
      expect(plain.statusCode, plain.body).toBe(201);
      const elevated = await patMint(w, pat, ['credits:grant']);
      expect(elevated.statusCode).toBe(403);
      expect(elevated.json().error.code).toBe('SCOPE_INSUFFICIENT');
    });

    it('a PAT that also carries applications:write (billing:write) can', async () => {
      const w = await world();
      const pat = await mintPat(w, ['keys:mint', 'applications:write']);
      expect((await patMint(w, pat, ['credits:grant'])).statusCode).toBe(201);
    });
  });
});
