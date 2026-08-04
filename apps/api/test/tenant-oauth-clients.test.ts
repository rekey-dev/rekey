/**
 * Listing and revoking the OAuth clients registered against an Application.
 *
 * Registration is unauthenticated by design (RFC 7591) and on by default,
 * because MCP clients self-register. Until these routes an operator could
 * neither see what had registered nor remove it — open registration nobody can
 * audit. What matters here is less the happy path than the boundary: a client
 * id is a public value, so "revoke by id" must not reach across Applications.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('registered OAuth clients', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** An operator with one Application that is acting as an OIDC provider. */
  async function fixture(slug: string) {
    const token = await app
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
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    return { token, applicationId };
  }

  const list = (token: string, applicationId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/oauth-clients`,
      headers: { authorization: `Bearer ${token}` },
    });

  it('lists what registered, and returns no secret because none exists', async () => {
    const { token, applicationId } = await fixture('oc-list');
    const client = await prisma.oAuthClient.create({
      data: {
        applicationId,
        clientName: 'Some MCP client',
        redirectUris: ['https://client.example/callback'],
      },
    });

    const res = await list(token, applicationId);
    expect(res.statusCode).toBe(200);
    // Paged, not a bare array: registrations accumulate, so a caller needs
    // `total` to know the list is not truncated.
    const page = res.json().data as { items: Array<Record<string, unknown>>; page: { total: number } };
    expect(page.page.total).toBe(1);
    const rows = page.items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientId: client.id,
      clientName: 'Some MCP client',
      redirectUris: ['https://client.example/callback'],
    });
    // Registration mints PUBLIC clients — PKCE, no secret. Anything that looks
    // like one appearing here would mean the model had changed underneath.
    expect(JSON.stringify(rows[0])).not.toMatch(/secret/i);
  });

  it('revokes a client, and it stops being listed', async () => {
    const { token, applicationId } = await fixture('oc-revoke');
    const client = await prisma.oAuthClient.create({
      data: { applicationId, clientName: 'Doomed', redirectUris: [] },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${applicationId}/oauth-clients/${client.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { revoked: boolean }).revoked).toBe(true);

    const after = (await list(token, applicationId)).json().data as {
      items: unknown[];
      page: { total: number };
    };
    expect(after.items).toHaveLength(0);
    expect(after.page.total).toBe(0);
    expect(await prisma.oAuthClient.findUnique({ where: { id: client.id } })).toBeNull();
  });

  it('cannot revoke a client belonging to another Application', async () => {
    // The reason the delete takes applicationId in the same statement rather
    // than looking the client up first: a client id is a public value, so
    // "delete by id" alone would be a cross-tenant write to anyone who has
    // seen one.
    const mine = await fixture('oc-mine');
    const theirs = await fixture('oc-theirs');
    const victim = await prisma.oAuthClient.create({
      data: { applicationId: theirs.applicationId, clientName: 'Not yours', redirectUris: [] },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${mine.applicationId}/oauth-clients/${victim.id}`,
      headers: { authorization: `Bearer ${mine.token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('OAUTH_CLIENT_NOT_FOUND');
    // Still there — a 404 that deleted the row anyway would be worse than a 200.
    expect(await prisma.oAuthClient.findUnique({ where: { id: victim.id } })).not.toBeNull();
  });

  it('answers 404 for a client id that does not exist at all', async () => {
    const { token, applicationId } = await fixture('oc-missing');
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${applicationId}/oauth-clients/does-not-exist`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to list for someone with no access to the Application', async () => {
    const mine = await fixture('oc-acl-a');
    const other = await fixture('oc-acl-b');
    const res = await list(other.token, mine.applicationId);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('closes open registration through the auth-config patch', async () => {
    const { token, applicationId } = await fixture('oc-toggle');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: { authorization: `Bearer ${token}` },
      payload: { dynamicClientRegistration: false },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    expect((row.authConfig as { dynamicClientRegistration?: boolean }).dynamicClientRegistration)
      .toBe(false);
  });
});
