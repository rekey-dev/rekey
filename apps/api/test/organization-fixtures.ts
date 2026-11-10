/**
 * An Application with organizations on, an owner who has created one, and
 * helpers to add members through the real invite and accept routes.
 */

import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma.js';

export interface OrgApp {
  applicationId: string;
  key: string;
  operatorToken: string;
  owner: { id: string; access: string; email: string };
  organizationId: string;
}

export async function orgApp(app: FastifyInstance, tag: string, opts: { billing?: boolean } = {}): Promise<OrgApp> {
  const operator = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `op-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${tag}` },
    })
    .then((r) => r.json().data as { accessToken: string });
  const application = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${operator.accessToken}` },
      payload: { name: `App ${tag}`, slug: `app-${tag}`, ...(opts.billing && { enableBilling: true }) },
    })
    .then((r) => r.json().data as { id: string });
  await prisma.application.update({
    where: { id: application.id },
    data: {
      authConfig: {
        methods: ['password'],
        passwordMinLength: 8,
        redirectUrls: [],
        organizationsEnabled: true,
        signupEnabled: true,
        passwordBreachCheckEnabled: false,
      } as never,
    },
  });
  const key = await app
    .inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${application.id}/api-keys`,
      headers: { authorization: `Bearer ${operator.accessToken}` },
      payload: { name: 'k', mode: 'live' },
    })
    .then((r) => r.json().data as { rawKey: string });
  const base = { applicationId: application.id, key: key.rawKey, operatorToken: operator.accessToken };
  const owner = await endUser(app, base, `owner-${tag}@example.com`);
  const org = await app
    .inject({
      method: 'POST',
      url: '/api/v1/users/me/organizations/',
      headers: as(base, owner),
      payload: { name: `Org ${tag}`, slug: `org-${tag}` },
    })
    .then((r) => r.json().data as { organization: { id: string } });
  return { ...base, owner, organizationId: org.organization.id };
}

export async function endUser(
  app: FastifyInstance,
  base: { key: string },
  email: string,
): Promise<{ id: string; access: string; email: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-up',
    headers: { authorization: `Bearer ${base.key}` },
    payload: { email, password: 'pw-one-two-three' },
  });
  const data = res.json().data as { accessToken: string; endUser: { id: string } };
  return { id: data.endUser.id, access: data.accessToken, email };
}

export function as(base: { key: string }, user: { access: string }): Record<string, string> {
  return { authorization: `Bearer ${base.key}`, 'x-rekey-user-token': user.access };
}

export async function invite(
  app: FastifyInstance,
  o: OrgApp,
  by: { access: string },
  email: string,
  role = 'MEMBER',
  organizationId = o.organizationId,
): Promise<{ token: string; invitation: { id: string } }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/users/me/organizations/${organizationId}/invitations`,
    headers: as(o, by),
    payload: { email, role },
  });
  if (res.statusCode !== 201) throw new Error(`invite failed: ${res.body}`);
  return res.json().data as { token: string; invitation: { id: string } };
}

/** A signed-up end user who joined the organization at `role`. */
export async function member(
  app: FastifyInstance,
  o: OrgApp,
  email: string,
  role = 'MEMBER',
): Promise<{ id: string; access: string; email: string }> {
  const user = await endUser(app, o, email);
  const { token } = await invite(app, o, o.owner, email, role);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/organizations/accept-invitation',
    headers: as(o, user),
    payload: { token },
  });
  if (res.statusCode !== 200) throw new Error(`accept failed: ${res.body}`);
  return user;
}
