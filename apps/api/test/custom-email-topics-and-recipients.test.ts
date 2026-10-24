/**
 * Who receives custom email and how a sender finds out: notification topics
 * and the one-click unsubscribe, the email-preferences API, the
 * `email.unsubscribed` webhook, sending by end-user id, dry runs, and reading
 * a send back. Resend is a recorder, as in custom-email-templates.test.ts.
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
const { createUnsubscribeToken } = await import('../src/modules/email/custom/unsubscribe-token.js');

interface World {
  ownerToken: string;
  appId: string;
  sendKey: string;
  readKey: string;
}

const VARS = { name: 'Sam' };

describe('custom email topics and recipients', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.78.0.1';
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
    ip = `10.78.${++n}.1`;
    const tag = `ctr-${n}-${Math.random().toString(36).slice(2, 7)}`;
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

  /** Send, then post the List-Unsubscribe link the mail carried, as a mailbox does. Returns the link. */
  async function oneClick(w: World, template: string, to: string, scope?: 'all'): Promise<string> {
    h.sends.length = 0;
    expect((await send(w, { template, to, variables: VARS })).json().data.status).toBe('sent');
    const header = h.sends[0]!.headers!['List-Unsubscribe']!;
    const url = new URL(header.replace(/^<|>$/g, ''));
    const link = `${url.pathname}${url.search}${scope === 'all' ? '&scope=all' : ''}`;
    await postLink(link);
    return link;
  }

  async function postLink(link: string): Promise<void> {
    const res = await inject({
      method: 'POST',
      url: link,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200);
  }

  const statusOf = async (w: World, template: string, to: string) =>
    (await send(w, { template, to, variables: VARS })).json().data.status as string;

  const unsubscribedEvents = (appId: string) =>
    prisma.webhookDelivery.findMany({ where: { applicationId: appId, eventType: 'email.unsubscribed' } });

  describe('topics', () => {
    it('leaving a topic stops only that topic; other notification and critical mail keep arriving', async () => {
      const w = await world();
      await endUser(w, 'sam@example.com');
      await oneClick(w, 'finish_setup', 'sam@example.com');

      expect(await statusOf(w, 'finish_setup', 'sam@example.com')).toBe('suppressed');
      expect(await statusOf(w, 'first_search', 'sam@example.com')).toBe('suppressed');
      expect(await statusOf(w, 'leads_ready', 'sam@example.com')).toBe('sent');
      expect(await statusOf(w, 'receipt', 'sam@example.com')).toBe('sent');
      const log = await prisma.emailLog.findFirst({
        where: { applicationId: w.appId, status: 'suppressed' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log?.error).toContain('this topic');
    });

    it('the second button leaves every notification email, critical mail still arrives', async () => {
      const w = await world();
      await oneClick(w, 'leads_ready', 'pat@example.com', 'all');
      expect(await statusOf(w, 'leads_ready', 'pat@example.com')).toBe('suppressed');
      expect(await statusOf(w, 'finish_setup', 'pat@example.com')).toBe('suppressed');
      expect(await statusOf(w, 'receipt', 'pat@example.com')).toBe('sent');
      expect(
        await prisma.emailSuppression.findFirst({ where: { applicationId: w.appId, address: 'pat@example.com' } }),
      ).toMatchObject({ reason: 'unsubscribe', category: 'notification' });
    });

    it('the topic is the version published, so retagging the draft changes nothing until publish', async () => {
      const w = await world();
      const patched = await inject({
        method: 'PATCH',
        url: `${base(w)}/custom-email-templates/leads_ready`,
        headers: auth(w.ownerToken),
        payload: { topic: 'onboarding' },
      });
      expect(patched.json().data.topic).toBe('onboarding');
      await oneClick(w, 'leads_ready', 'kim@example.com');
      expect(
        await prisma.emailTopicOptOut.findMany({ where: { applicationId: w.appId }, select: { topic: true } }),
      ).toEqual([{ topic: 'leads_ready' }]);

      const published = await inject({
        method: 'POST',
        url: `${base(w)}/custom-email-templates/leads_ready/publish`,
        headers: auth(w.ownerToken),
      });
      expect(published.statusCode).toBe(200);
      expect(await statusOf(w, 'leads_ready', 'kim@example.com')).toBe('suppressed');
    });

    it('a token whose topic was tampered with or malformed does not verify', async () => {
      const w = await world();
      const good = createUnsubscribeToken(w.appId, 'a@example.com', 'onboarding');
      const [keyId, , signature] = good.split('.');
      const swapped = Buffer.from(
        JSON.stringify({ a: w.appId, e: 'a@example.com', c: 'notification', t: 'leads_ready' }),
      ).toString('base64url');
      const res = await inject({ method: 'POST', url: `/api/v1/email/unsubscribe?token=${keyId}.${swapped}.${signature}` });
      expect(res.body).toContain('does not work');
      const malformed = createUnsubscribeToken(w.appId, 'a@example.com', 'Not A Topic!');
      expect((await inject({ method: 'POST', url: `/api/v1/email/unsubscribe?token=${malformed}` })).body).toContain(
        'does not work',
      );
      expect(await prisma.emailTopicOptOut.count({ where: { applicationId: w.appId } })).toBe(0);
    });
  });

  describe('email preferences', () => {
    const prefs = (w: World, id: string, key = w.readKey) =>
      inject({ method: 'GET', url: `/api/v1/users/${id}/email-preferences`, headers: auth(key) });
    const patch = (w: World, id: string, topics: Record<string, string>, key = w.sendKey) =>
      inject({ method: 'PATCH', url: `/api/v1/users/${id}/email-preferences`, headers: auth(key), payload: { topics } });

    it('lists every published notification topic and agrees with the one-click link', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      expect((await prefs(w, id)).json().data).toEqual({
        allNotifications: 'subscribed',
        topics: { leads_ready: 'subscribed', onboarding: 'subscribed' },
      });
      await oneClick(w, 'first_search', 'sam@example.com');
      expect((await prefs(w, id)).json().data.topics).toEqual({ leads_ready: 'subscribed', onboarding: 'unsubscribed' });
    });

    it('PATCH unsubscribes and resubscribes a topic; the change reaches sends', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      const off = await patch(w, id, { leads_ready: 'unsubscribed' });
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json().data.topics.leads_ready).toBe('unsubscribed');
      expect(await statusOf(w, 'leads_ready', 'sam@example.com')).toBe('suppressed');
      const on = await patch(w, id, { leads_ready: 'subscribed' });
      expect(on.json().data.topics.leads_ready).toBe('subscribed');
      expect(await statusOf(w, 'leads_ready', 'sam@example.com')).toBe('sent');
    });

    it('resubscribing a topic never lifts "stop all" or an operator suppression', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      await oneClick(w, 'leads_ready', 'sam@example.com', 'all');
      const res = await patch(w, id, { leads_ready: 'subscribed' });
      expect(res.json().data).toEqual({
        allNotifications: 'unsubscribed',
        topics: { leads_ready: 'unsubscribed', onboarding: 'unsubscribed' },
      });
      expect(await statusOf(w, 'leads_ready', 'sam@example.com')).toBe('suppressed');
    });

    it('refuses an unknown topic, a default key on PATCH, and a user of another application', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      const unknown = await patch(w, id, { receipt: 'unsubscribed' });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error.code).toBe('EMAIL_TOPIC_UNKNOWN');
      const star = await mintKey(w.ownerToken, w.appId, ['*']);
      expect((await patch(w, id, { onboarding: 'subscribed' }, star)).json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
      const other = await world();
      expect((await prefs(other, id)).statusCode).toBe(404);
    });
  });

  describe('email.unsubscribed webhook', () => {
    it('fires once per change with the topic, the end user, and no topic when they left everything', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      const link = await oneClick(w, 'finish_setup', 'sam@example.com');
      await postLink(link);
      await oneClick(w, 'leads_ready', 'sam@example.com', 'all');
      await oneClick(w, 'leads_ready', 'stranger@example.com');
      const events = (await unsubscribedEvents(w.appId)).map((d) => (d.payload as { data: unknown }).data);
      expect(events).toHaveLength(3);
      expect(events).toContainEqual({ address: 'sam@example.com', endUserId: id, category: 'notification', topic: 'onboarding' });
      expect(events).toContainEqual({ address: 'sam@example.com', endUserId: id, category: 'notification' });
      expect(events).toContainEqual({ address: 'stranger@example.com', category: 'notification', topic: 'leads_ready' });

      const patched = await inject({
        method: 'PATCH',
        url: `/api/v1/users/${id}/email-preferences`,
        headers: auth(w.sendKey),
        payload: { topics: { leads_ready: 'unsubscribed' } },
      });
      expect(patched.statusCode).toBe(200);
      expect(await unsubscribedEvents(w.appId)).toHaveLength(3);
    });
  });

  describe('erasure', () => {
    it('deletes the topic opt-outs of an erased end user', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      await oneClick(w, 'leads_ready', 'sam@example.com');
      const erased = await inject({
        method: 'DELETE',
        url: `${base(w)}/end-users/${id}?erasure=true`,
        headers: auth(w.ownerToken),
      });
      expect(erased.statusCode, erased.body).toBe(200);
      expect(await prisma.emailTopicOptOut.count({ where: { applicationId: w.appId } })).toBe(0);
    });
  });

  describe('sending by end-user id', () => {
    it('sends to the verified address of a live end user', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      const res = await send(w, { template: 'receipt', to: { endUserId: id }, variables: VARS });
      expect(res.statusCode, res.body).toBe(202);
      expect(h.sends.map((s) => s.to)).toEqual(['sam@example.com']);
    });

    it('refuses unknown, erased, banned and unverified users with their codes and sends nothing', async () => {
      const w = await world();
      const other = await world();
      const cases: Array<[string, number, string]> = [
        ['missing', 404, 'EMAIL_RECIPIENT_NOT_FOUND'],
        [await endUser(other, 'theirs@example.com'), 404, 'EMAIL_RECIPIENT_NOT_FOUND'],
        [await endUser(w, 'erased@example.com', { erasedAt: new Date() }), 404, 'EMAIL_RECIPIENT_NOT_FOUND'],
        [await endUser(w, 'banned@example.com', { bannedAt: new Date() }), 409, 'EMAIL_RECIPIENT_BANNED'],
        [await endUser(w, 'new@example.com', { emailVerified: false }), 409, 'EMAIL_RECIPIENT_UNVERIFIED'],
      ];
      h.sends.length = 0;
      for (const [endUserId, status, code] of cases) {
        const res = await send(w, { template: 'receipt', to: { endUserId }, variables: VARS, idempotencyKey: `k-${endUserId}` });
        expect(res.statusCode, endUserId).toBe(status);
        expect(res.json().error.code).toBe(code);
      }
      expect(h.sends).toHaveLength(0);
      expect(await prisma.emailLog.count({ where: { applicationId: w.appId, customTemplateKey: 'receipt' } })).toBe(0);
    });

    it('a keyed send by id replays after the user changes address', async () => {
      const w = await world();
      const id = await endUser(w, 'old@example.com');
      const first = await send(w, { template: 'receipt', to: { endUserId: id }, variables: VARS, idempotencyKey: 'welcome:1' });
      await prisma.endUser.update({ where: { id }, data: { email: 'new@example.com' } });
      const again = await send(w, { template: 'receipt', to: { endUserId: id }, variables: VARS, idempotencyKey: 'welcome:1' });
      expect(again.statusCode, again.body).toBe(202);
      expect(again.json().data.id).toBe(first.json().data.id);
      expect(h.sends).toHaveLength(1);
    });
  });

  describe('dry run', () => {
    it('renders and reports, and sends, logs, counts and keys nothing', async () => {
      const w = await world();
      const id = await endUser(w, 'sam@example.com');
      const res = await send(w, { template: 'leads_ready', to: { endUserId: id }, variables: VARS, dryRun: true, idempotencyKey: 'dry' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ dryRun: true, status: 'would_send', subject: 'leads_ready for Sam' });
      expect(h.sends).toHaveLength(0);
      expect(await prisma.emailLog.count({ where: { applicationId: w.appId, customTemplateKey: 'leads_ready' } })).toBe(0);
      const real = await send(w, { template: 'leads_ready', to: { endUserId: id }, variables: VARS, idempotencyKey: 'dry' });
      expect(real.json().data.status).toBe('sent');
    });

    it('answers the refusals a real send answers, and suppressed for an opted-out recipient', async () => {
      const w = await world();
      const bad = await send(w, { template: 'leads_ready', to: 'a@example.com', variables: {}, dryRun: true });
      expect(bad.json().error.code).toBe('EMAIL_VARIABLES_INVALID');
      await oneClick(w, 'leads_ready', 'a@example.com');
      const dry = await send(w, { template: 'leads_ready', to: 'a@example.com', variables: VARS, dryRun: true });
      expect(dry.json().data.status).toBe('suppressed');
    });
  });

  describe('reading a send back', () => {
    it('by id and by idempotency key, only within the application and with email:send', async () => {
      const w = await world();
      const sent = await send(w, { template: 'receipt', to: 'a@example.com', variables: VARS, idempotencyKey: 'search:42' });
      const id = sent.json().data.id as string;
      const byId = await inject({ method: 'GET', url: `/api/v1/email/sends/${id}`, headers: auth(w.sendKey) });
      expect(byId.statusCode, byId.body).toBe(200);
      expect(byId.json().data).toMatchObject({ id, status: 'sent', toAddress: 'a@example.com', customTemplateKey: 'receipt' });
      const byKey = await inject({ method: 'GET', url: '/api/v1/email/sends?idempotencyKey=search:42', headers: auth(w.sendKey) });
      expect(byKey.json().data.id).toBe(id);

      const other = await world();
      const foreign = await inject({ method: 'GET', url: `/api/v1/email/sends/${id}`, headers: auth(other.sendKey) });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json().error.code).toBe('EMAIL_SEND_NOT_FOUND');
      const noScope = await inject({ method: 'GET', url: `/api/v1/email/sends/${id}`, headers: auth(w.readKey) });
      expect(noScope.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    });

    it('the operator log filters by template, recipient and time', async () => {
      const w = await world();
      await send(w, { template: 'receipt', to: 'A@example.com', variables: VARS });
      await send(w, { template: 'leads_ready', to: 'a@example.com', variables: VARS });
      await send(w, { template: 'receipt', to: 'b@example.com', variables: VARS });
      const logs = async (q: string) =>
        (await inject({ method: 'GET', url: `${base(w)}/email-logs?${q}`, headers: auth(w.ownerToken) })).json().data;
      expect((await logs('customTemplateKey=receipt')).page.total).toBe(2);
      expect((await logs('toAddress=A%40Example.com')).page.total).toBe(2);
      expect((await logs('customTemplateKey=receipt&toAddress=a%40example.com')).page.total).toBe(1);
      expect((await logs(`since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).page.total).toBe(0);
    });
  });
});
