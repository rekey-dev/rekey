/**
 * A workspace, an Application with a webhook endpoint subscribed to
 * everything, and the calls the support mode suites repeat.
 */

import { expect } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { prisma } from '../src/lib/prisma.js';

export const PASSWORD = 'pw-one-two-three';
/** Distinctive on purpose: the leak tests search serialised rows for it. */
export const REASON = 'zebra-quartz-ticket-7781 customer cannot export logs';

export type Json = Record<string, unknown>;
export interface Session {
  accessToken: string;
  refreshToken: string;
  deviceId: string | null;
}

export interface SupportWorld {
  operator: string;
  operatorId: string;
  tenantId: string;
  appId: string;
  pubKey: string;
  liveKey: string;
  op: (token?: string) => { authorization: string };
  sk: () => { authorization: string };
  pk: () => { authorization: string };
  appBase: string;
  base: (euid: string) => string;
  capability: (name: string, description?: string) => Promise<LightMyRequestResponse>;
  makeUser: (email: string) => Promise<string>;
  signIn: (email: string, fingerprint?: string) => Promise<Session>;
  support: (accessToken: string) => Promise<Json>;
  open: (euid: string, body?: Json) => Promise<LightMyRequestResponse>;
  patch: (euid: string, body: Json) => Promise<LightMyRequestResponse>;
  end: (euid: string) => Promise<LightMyRequestResponse>;
  read: (euid: string) => Promise<{ open: Json | null; history: Json[]; events: Json[] }>;
}

export const codeOf = (res: LightMyRequestResponse): unknown => (res.json().error as Json | undefined)?.code;

export async function supportWorld(app: FastifyInstance, tag: string): Promise<SupportWorld> {
  const slug = `${tag}-${Math.random().toString(36).slice(2, 8)}`;
  const signedUp = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
    })
    .then((r) => r.json().data as { accessToken: string; user: { id: string } });
  const operator = signedUp.accessToken;
  const op = (token = operator) => ({ authorization: `Bearer ${token}` });
  const created = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: op(),
      payload: { name: 'Support', slug, enableBilling: true },
    })
    .then((r) => r.json().data as { id: string; publicKey: string });
  const appId = created.id;
  const liveKey = await app
    .inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/api-keys`,
      headers: op(),
      payload: { name: 'k', mode: 'live', scopes: ['*'] },
    })
    .then((r) => (r.json().data as { rawKey: string }).rawKey);
  const endpoint = await app.inject({
    method: 'POST',
    url: `/api/v1/tenant/applications/${appId}/webhooks`,
    headers: op(),
    payload: { url: 'http://127.0.0.1:9/never', events: ['*'] },
  });
  expect(endpoint.statusCode, endpoint.body).toBe(201);
  const { tenantId } = await prisma.application.findUniqueOrThrow({ where: { id: appId } });

  const appBase = `/api/v1/tenant/applications/${appId}`;
  const base = (euid: string) => `${appBase}/end-users/${euid}`;
  const sk = () => ({ authorization: `Bearer ${liveKey}` });
  const pk = () => ({ authorization: `Bearer ${created.publicKey}` });

  return {
    operator,
    operatorId: signedUp.user.id,
    tenantId,
    appId,
    pubKey: created.publicKey,
    liveKey,
    op,
    sk,
    pk,
    appBase,
    base,
    capability: (name, description) =>
      app.inject({
        method: 'POST',
        url: `${appBase}/support-capabilities`,
        headers: op(),
        payload: { name, ...(description !== undefined && { description }) },
      }),
    makeUser: async (email) => {
      const r = await app.inject({
        method: 'POST',
        url: `${appBase}/end-users`,
        headers: op(),
        payload: { email, password: PASSWORD },
      });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json().data as { id: string }).id;
    },
    signIn: async (email, fingerprint) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        headers: pk(),
        payload: { email, password: PASSWORD, ...(fingerprint !== undefined && { device: { fingerprint } }) },
      });
      expect(r.statusCode, r.body).toBe(200);
      const data = r.json().data as Session;
      return { accessToken: data.accessToken, refreshToken: data.refreshToken, deviceId: data.deviceId ?? null };
    },
    support: async (accessToken) => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me?include=support',
        headers: { 'x-rekey-user-token': accessToken },
      });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json().data as { support: Json }).support;
    },
    open: (euid, body = {}) =>
      app.inject({
        method: 'POST',
        url: `${base(euid)}/support`,
        headers: op(),
        payload: { capabilities: ['diagnostics.debug'], reason: REASON, ...body },
      }),
    patch: (euid, body) =>
      app.inject({ method: 'PATCH', url: `${base(euid)}/support`, headers: op(), payload: body }),
    end: (euid) => app.inject({ method: 'POST', url: `${base(euid)}/support/end`, headers: op() }),
    read: async (euid) => {
      const r = await app.inject({ method: 'GET', url: `${base(euid)}/support`, headers: op() });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().data as { open: Json | null; history: Json[]; events: Json[] };
    },
  };
}
