/**
 * A workspace with an owner, one Application and a MEMBER holding a grant on
 * it, for tests that walk the role and scope matrix of an operator route.
 */

import { expect } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

export type GrantRole = 'APP_ADMIN' | 'APP_BILLING' | 'APP_VIEWER';

export interface OperatorWorld {
  ownerToken: string;
  memberToken: string;
  membershipId: string;
  appId: string;
  secretKey: string;
  inject: (opts: Record<string, unknown>) => Promise<LightMyRequestResponse>;
  /** Replace the member's grant on the Application. */
  grant: (role: GrantRole) => Promise<void>;
  /** Restrict the member to these scopes, or lift the restriction with null. */
  setScopes: (scopes: string[] | null) => Promise<void>;
  /** Make the member a workspace ADMIN. */
  promoteToAdmin: () => Promise<void>;
}

let counter = 0;

export const bearer = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

/**
 * @example
 *   const w = await operatorWorld(app, 'APP_VIEWER');
 *   await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/stats`, headers: bearer(w.memberToken) });
 */
export async function operatorWorld(app: FastifyInstance, role: GrantRole = 'APP_VIEWER'): Promise<OperatorWorld> {
  const ip = `10.${60 + (counter % 30)}.${(++counter % 250) + 1}.1`;
  const inject = (opts: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    app.inject({ remoteAddress: ip, ...opts } as never);
  const tag = `ow-${counter}-${Math.random().toString(36).slice(2, 7)}`;
  const signUp = async (email: string, ws: string): Promise<string> => {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: ws },
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json().data as { accessToken: string }).accessToken;
  };
  const ownerToken = await signUp(`owner-${tag}@example.com`, 'World Co');
  const created = await inject({
    method: 'POST',
    url: '/api/v1/tenant/applications',
    headers: bearer(ownerToken),
    payload: { name: tag, slug: tag },
  });
  expect(created.statusCode, created.body).toBe(201);
  const appId = (created.json().data as { id: string }).id;
  const key = await inject({
    method: 'POST',
    url: `/api/v1/tenant/applications/${appId}/api-keys`,
    headers: bearer(ownerToken),
    payload: { name: 'k', mode: 'live' },
  });
  const secretKey = (key.json().data as { rawKey: string }).rawKey;

  const inviteeToken = await signUp(`member-${tag}@example.com`, 'Member Own Co');
  const inv = await inject({
    method: 'POST',
    url: '/api/v1/tenant/workspace/invitations',
    headers: bearer(ownerToken),
    payload: { email: `member-${tag}@example.com`, role: 'MEMBER' },
  });
  expect(inv.statusCode, inv.body).toBe(201);
  const acc = await inject({
    method: 'POST',
    url: '/api/v1/tenant/invitations/accept',
    headers: bearer(inviteeToken),
    payload: { token: (inv.json().data as { token: string }).token },
  });
  expect(acc.statusCode, acc.body).toBe(200);
  const memberToken = (acc.json().data as { accessToken: string }).accessToken;
  const members = await inject({ method: 'GET', url: '/api/v1/tenant/workspace/members', headers: bearer(ownerToken) });
  const membershipId = (
    members.json().data as { items: Array<{ membershipId: string; role: string }> }
  ).items.find((m) => m.role === 'MEMBER')!.membershipId;

  const grant = async (r: GrantRole): Promise<void> => {
    const g = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: bearer(ownerToken),
      payload: { applicationId: appId, role: r },
    });
    expect(g.statusCode, g.body).toBe(200);
  };
  await grant(role);

  return {
    ownerToken,
    memberToken,
    membershipId,
    appId,
    secretKey,
    inject,
    grant,
    setScopes: async (scopes) => {
      const r = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/workspace/members/${membershipId}`,
        headers: bearer(ownerToken),
        payload: { scopes },
      });
      expect(r.statusCode, r.body).toBe(200);
    },
    promoteToAdmin: async () => {
      const r = await inject({
        method: 'PATCH',
        url: `/api/v1/tenant/workspace/members/${membershipId}`,
        headers: bearer(ownerToken),
        payload: { role: 'ADMIN' },
      });
      expect(r.statusCode, r.body).toBe(200);
    },
  };
}
