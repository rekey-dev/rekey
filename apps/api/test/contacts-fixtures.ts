/**
 * Shared fixtures for the lists and contacts tests: a workspace with one
 * Application, a list, and the keys to call it with.
 */

import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';

export interface ContactsWorld {
  ownerToken: string;
  tenantId: string;
  appId: string;
  publicKey: string;
  tag: string;
}

export interface InjectedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
  json: () => any;
}

export function contactsHarness(getApp: () => FastifyInstance, prefix: string) {
  let n = 0;
  let ip = `10.${prefix}.0.1`;
  const inject = (opts: Record<string, unknown>): Promise<InjectedResponse> =>
    getApp().inject({ remoteAddress: ip, ...opts } as never) as unknown as Promise<InjectedResponse>;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function world(): Promise<ContactsWorld> {
    ip = `10.${prefix}.${++n}.1`;
    const tag = `cl${prefix}-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Lists Co' },
    });
    expect(su.statusCode, su.body).toBe(201);
    const data = su.json().data as { accessToken: string; activeTenantId: string };
    const created = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(data.accessToken),
      payload: { name: 'Acme', slug: tag },
    });
    expect(created.statusCode, created.body).toBe(201);
    const appRow = created.json().data as { id: string; publicKey: string };
    return {
      ownerToken: data.accessToken,
      tenantId: data.activeTenantId,
      appId: appRow.id,
      publicKey: appRow.publicKey,
      tag,
    };
  }

  const base = (w: ContactsWorld) => `/api/v1/tenant/applications/${w.appId}`;

  async function createList(w: ContactsWorld, body: Record<string, unknown> = {}) {
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/lists`,
      headers: auth(w.ownerToken),
      payload: { key: 'newsletter', name: 'Newsletter', ...body },
    });
    return res;
  }

  async function mintKey(w: ContactsWorld, scopes: string[] = ['*']): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/api-keys`,
      headers: auth(w.ownerToken),
      payload: { name: `k-${scopes.join('+')}`, scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { rawKey: string }).rawKey;
  }

  /** A second operator who accepted an invitation to the workspace with `role`. */
  async function invited(w: ContactsWorld, email: string, role: 'ADMIN' | 'MEMBER'): Promise<string> {
    const invitee = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName: 'Own Co' },
    });
    const inviteeToken = (invitee.json().data as { accessToken: string }).accessToken;
    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: auth(w.ownerToken),
      payload: { email, role },
    });
    const token = (inv.json().data as { token: string }).token;
    const acc = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: auth(inviteeToken),
      payload: { token },
    });
    expect(acc.statusCode, acc.body).toBe(200);
    return (acc.json().data as { accessToken: string }).accessToken;
  }

  const adminOf = (w: ContactsWorld): Promise<string> => invited(w, `admin-${w.tag}@example.com`, 'ADMIN');

  /** A second operator in the workspace, as a MEMBER holding `role` on the Application. */
  async function memberWith(
    w: ContactsWorld,
    role: 'APP_ADMIN' | 'APP_VIEWER' | 'APP_BILLING',
  ): Promise<string> {
    const email = `member-${w.tag}-${role.toLowerCase()}@example.com`;
    const memberToken = await invited(w, email, 'MEMBER');
    const members = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: auth(w.ownerToken),
    });
    const membershipId = (
      members.json().data as { items: Array<{ membershipId: string; email: string }> }
    ).items.find((m) => m.email === email)!.membershipId;
    const g = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(w.ownerToken),
      payload: { applicationId: w.appId, role },
    });
    expect(g.statusCode, g.body).toBe(200);
    return memberToken;
  }

  return { inject, auth, world, base, createList, mintKey, memberWith, adminOf, setIp: (next: string) => (ip = next) };
}
