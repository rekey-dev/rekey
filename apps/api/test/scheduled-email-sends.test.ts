/**
 * Scheduled custom sends: `sendAt` on POST /api/v1/email/send, the poller
 * that fires them through the normal send, and cancelling before they fire.
 * Resend is a recorder, as in custom-email-templates.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const h = vi.hoisted(() => ({
  sends: [] as Array<{ to: string; subject: string; headers?: Record<string, string> }>,
}));

vi.mock('resend', () => ({
  Resend: class {
    readonly emails = {
      send: async (payload: { to: string; subject: string; headers?: Record<string, string> }) => {
        h.sends.push(payload);
        return { data: { id: `re_msg_${h.sends.length}` }, error: null };
      },
    };
  },
}));

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { setDeliveryScheduler } = await import('../src/modules/webhooks/webhook.service.js');
const { fireDueScheduledSends } = await import('../src/modules/email/custom/scheduled-sends.js');

interface World {
  ownerToken: string;
  appId: string;
  sendKey: string;
  readKey: string;
}

const VARS = { name: 'Sam' };

describe('scheduled custom sends', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.79.0.1';
  const inject = (opts: Record<string, unknown>) => app.inject({ remoteAddress: ip, ...opts } as never);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const base = (w: World) => `/api/v1/tenant/applications/${w.appId}`;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    h.sends.length = 0;
    setDeliveryScheduler(() => undefined);
  });
  afterEach(() => setDeliveryScheduler(null));

  async function mintKey(ownerToken: string, appId: string, scopes: string[]): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/api-keys`,
      headers: auth(ownerToken),
      payload: { name: `k-${scopes.join('+')}`, scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { rawKey: string }).rawKey;
  }

  async function template(w: World, key: string, extra: Record<string, unknown> = {}): Promise<void> {
    const created = await inject({
      method: 'POST',
      url: `${base(w)}/custom-email-templates`,
      headers: auth(w.ownerToken),
      payload: {
        key,
        name: key,
        category: 'notification',
        subject: `${key} for {{name}}`,
        bodyHtml: '<p>Hi {{name}}</p>',
        variableSchema: [{ name: 'name', type: 'string', required: true }],
        ...extra,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const published = await inject({
      method: 'POST',
      url: `${base(w)}/custom-email-templates/${key}/publish`,
      headers: auth(w.ownerToken),
    });
    expect(published.statusCode, published.body).toBe(200);
  }

  /** Two nudges sharing the `onboarding` topic, and `leads_ready` on its own key topic. */
  async function world(): Promise<World> {
    ip = `10.79.${++n}.1`;
    const tag = `sch-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `owner-${tag}@example.com`, password: 'pw-one-two-three', workspaceName: 'Leads Co' },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;
    const created = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(ownerToken),
      payload: { name: 'Leads', slug: tag },
    });
    const appId = (created.json().data as { id: string }).id;
    const creds = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/email-credentials`,
      headers: auth(ownerToken),
      payload: { provider: 'resend', apiKey: 're_byo', fromAddress: 'hello@leads.test', fromName: 'Leads' },
    });
    expect(creds.statusCode).toBe(200);
    const w = {
      ownerToken,
      appId,
      sendKey: await mintKey(ownerToken, appId, ['email:send']),
      readKey: await mintKey(ownerToken, appId, ['auth:read']),
    };
    await template(w, 'finish_setup', { topic: 'onboarding' });
    await template(w, 'first_search', { topic: 'onboarding' });
    await template(w, 'leads_ready');
    await template(w, 'receipt', { category: 'critical' });
    await prisma.webhookEndpoint.create({
      data: { applicationId: appId, url: 'https://127.0.0.1:1/never', secret: 'whsec_t', events: ['*'], enabled: true },
    });
    return w;
  }

  async function endUser(w: World, email: string, data: Record<string, unknown> = {}): Promise<string> {
    const row = await prisma.endUser.create({
      data: { applicationId: w.appId, email, emailVerified: true, ...data },
    });
    return row.id;
  }

  const send = (w: World, payload: Record<string, unknown>) =>
    inject({ method: 'POST', url: '/api/v1/email/send', headers: auth(w.sendKey), payload });

  const inHours = (h: number) => new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
  const later = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
  const schedule = (w: World, extra: Record<string, unknown> = {}) =>
    send(w, { template: 'leads_ready', to: 'sam@example.com', variables: VARS, sendAt: inHours(1), ...extra });
  const rowOf = (id: string) => prisma.emailLog.findUniqueOrThrow({ where: { id } });

  it('records a scheduled send, sends nothing until it is due, then sends it once', async () => {
    const w = await world();
    const res = await schedule(w);
    expect(res.statusCode, res.body).toBe(202);
    const { id, status, sendAt } = res.json().data;
    expect(status).toBe('scheduled');
    expect(sendAt).toBeDefined();
    expect(await fireDueScheduledSends()).toBe(0);
    expect(h.sends).toHaveLength(0);

    expect(await fireDueScheduledSends(later())).toBe(1);
    expect(h.sends.map((s) => s.to)).toEqual(['sam@example.com']);
    expect(await rowOf(id)).toMatchObject({ status: 'sent', scheduledRequest: null });
    expect(await fireDueScheduledSends(later())).toBe(0);
    expect(h.sends).toHaveLength(1);
  });

  it('checks again at fire time: an unsubscribe or a ban in between is logged suppressed', async () => {
    const w = await world();
    const id1 = (await schedule(w)).json().data.id as string;
    const userId = await endUser(w, 'kim@example.com');
    const id2 = (await schedule(w, { to: { endUserId: userId } })).json().data.id as string;
    await prisma.emailTopicOptOut.create({ data: { applicationId: w.appId, address: 'sam@example.com', topic: 'leads_ready' } });
    await prisma.endUser.update({ where: { id: userId }, data: { bannedAt: new Date() } });

    expect(await fireDueScheduledSends(later())).toBe(2);
    expect(h.sends).toHaveLength(0);
    expect((await rowOf(id1)).status).toBe('suppressed');
    expect(await rowOf(id2)).toMatchObject({ status: 'suppressed', error: expect.stringContaining('banned') });
  });

  it('cancels before it fires, refuses a second cancel, and a replay of its key answers canceled', async () => {
    const w = await world();
    const id = (await schedule(w, { idempotencyKey: 'nudge:1' })).json().data.id as string;
    const cancel = () => inject({ method: 'DELETE', url: `/api/v1/email/sends/${id}`, headers: auth(w.sendKey) });
    const first = await cancel();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.status).toBe('canceled');
    expect((await cancel()).json().error.code).toBe('EMAIL_SEND_NOT_SCHEDULED');
    expect(await fireDueScheduledSends(later())).toBe(0);
    expect(h.sends).toHaveLength(0);
    const replay = await schedule(w, { idempotencyKey: 'nudge:1', sendAt: (await rowOf(id)).sendAt!.toISOString() });
    expect(replay.json().data).toMatchObject({ id, status: 'canceled' });
  });

  it('sends each due row once when sixteen pollers race for them', async () => {
    const w = await world();
    const recipients = Array.from({ length: 20 }, (_, i) => `r${i}@example.com`);
    for (const to of recipients) await schedule(w, { to });
    const fired = await Promise.all(Array.from({ length: 16 }, () => fireDueScheduledSends(later())));
    expect(fired.reduce((a, b) => a + b, 0)).toBe(20);
    expect(h.sends.map((s) => s.to).sort()).toEqual([...recipients].sort());
  });

  it('waits out a send cap at fire time instead of dropping the send', async () => {
    const w = await world();
    const app_ = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    await prisma.tenant.update({ where: { id: app_.tenantId }, data: { limits: { emailSendRecipientHourlyCap: 1 } } });
    const first = (await schedule(w)).json().data.id as string;
    const second = (await schedule(w, { variables: { name: 'Again' } })).json().data.id as string;
    expect(await fireDueScheduledSends(later())).toBe(2);
    expect(h.sends).toHaveLength(1);
    const statuses = [(await rowOf(first)).status, (await rowOf(second)).status].sort();
    expect(statuses).toEqual(['scheduled', 'sent']);
    const waiting = await prisma.emailLog.findFirstOrThrow({ where: { id: { in: [first, second] }, status: 'scheduled' } });
    expect(waiting.sendAt!.getTime()).toBeGreaterThan(later().getTime() - 60_000);
    expect(waiting.scheduledRequest).not.toBeNull();
  });

  it('refuses a sendAt in the past or more than 30 days ahead', async () => {
    const w = await world();
    for (const sendAt of [inHours(-1), inHours(31 * 24)]) {
      const res = await schedule(w, { sendAt });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('EMAIL_SEND_AT_INVALID');
    }
  });

  it('erasing the recipient deletes their scheduled sends', async () => {
    const w = await world();
    const userId = await endUser(w, 'gone@example.com');
    await schedule(w, { to: { endUserId: userId } });
    const erased = await inject({
      method: 'DELETE',
      url: `${base(w)}/end-users/${userId}?erasure=true`,
      headers: auth(w.ownerToken),
    });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(await prisma.emailLog.count({ where: { applicationId: w.appId, status: 'scheduled' } })).toBe(0);
    expect(await fireDueScheduledSends(later())).toBe(0);
  });
});
