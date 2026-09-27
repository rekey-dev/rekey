/**
 * Custom email templates: registered first, sent by key through
 * `POST /api/v1/email/send`. Error codes: docs/errors.md, "Email: custom templates".
 *
 * The shared pool is CONFIGURED in this file on purpose. With no pool, "never
 * falls back to the pool" would pass because there is nothing to fall back to.
 * Resend is replaced by a recorder, so every assertion about what was sent is
 * about the call the transport really made, and a pool send is visible as a
 * call made with the pool's key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    env: { ...actual.env, RESEND_DEFAULT_API_KEY: 're_pool_shared_key', RESEND_DEFAULT_FROM: 'pool@rekey.test' },
  };
});

const h = vi.hoisted(() => {
  type Payload = {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
    headers?: Record<string, string>;
  };
  const state = {
    sends: [] as Array<{ apiKey: string; payload: Payload }>,
    delayMs: 0,
    fail: null as string | null,
  };
  return state;
});

vi.mock('resend', () => ({
  Resend: class {
    private readonly apiKey: string;
    readonly emails: { send: (payload: never) => Promise<unknown> };
    constructor(apiKey: string) {
      this.apiKey = apiKey;
      this.emails = {
        send: async (payload: never) => {
          h.sends.push({ apiKey: this.apiKey, payload });
          if (h.delayMs > 0) await new Promise((r) => setTimeout(r, h.delayMs));
          if (h.fail !== null) return { data: null, error: { message: h.fail } };
          return { data: { id: `re_msg_${h.sends.length}` }, error: null };
        },
      };
    }
  },
}));

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { sendEmail } = await import('../src/lib/email-transport.js');

const BYO_KEY = 're_byo_app_key';
const POOL_KEY = 're_pool_shared_key';

interface World {
  ownerToken: string;
  ownerEmail: string;
  appId: string;
  tag: string;
}

describe('custom email templates', () => {
  let app: FastifyInstance;
  let n = 0;
  let ip = '10.77.0.1';
  const inject = (opts: Record<string, unknown>) => app.inject({ remoteAddress: ip, ...opts } as never);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    h.sends.length = 0;
    h.delayMs = 0;
    h.fail = null;
  });

  async function world(opts: { byo?: boolean } = {}): Promise<World> {
    ip = `10.77.${++n}.1`;
    const tag = `cet-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const ownerEmail = `owner-${tag}@example.com`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: ownerEmail, password: 'pw-one-two-three', workspaceName: 'Mail Co' },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;
    const created = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: auth(ownerToken),
      payload: { name: 'Acme', slug: tag },
    });
    expect(created.statusCode).toBe(201);
    const appId = (created.json().data as { id: string }).id;
    const w = { ownerToken, ownerEmail, appId, tag };
    if (opts.byo !== false) await connectResend(w, 'hello@acme.test');
    return w;
  }

  const base = (w: World) => `/api/v1/tenant/applications/${w.appId}`;

  async function connectResend(w: World, fromAddress: string): Promise<void> {
    const res = await inject({
      method: 'PUT',
      url: `${base(w)}/email-credentials`,
      headers: auth(w.ownerToken),
      payload: { provider: 'resend', apiKey: BYO_KEY, fromAddress, fromName: 'Acme' },
    });
    expect(res.statusCode).toBe(200);
  }

  async function mintKey(w: World, scopes: string[]): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/api-keys`,
      headers: auth(w.ownerToken),
      payload: { name: `k-${scopes.join('+')}`, scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { rawKey: string }).rawKey;
  }

  const ORDER_TEMPLATE = {
    key: 'order_shipped',
    name: 'Order shipped',
    category: 'notification',
    subject: 'Order {{orderNumber}} shipped',
    bodyHtml:
      '<p>Hi {{name}}, order {{orderNumber}} is on its way.</p><a href="{{trackingUrl}}">Track it</a>' +
      '{{#if shippedOn}}<p>Shipped {{shippedOn}}</p>{{/if}}',
    variableSchema: [
      { name: 'orderNumber', type: 'string', required: true, maxLength: 16 },
      { name: 'name', type: 'string' },
      { name: 'trackingUrl', type: 'url', required: true },
      { name: 'shippedOn', type: 'date' },
      { name: 'itemCount', type: 'number' },
    ],
    linkDomains: ['track.acme.test'],
  };

  const GOOD_VARS = { orderNumber: 'A-1042', name: 'Sam', trackingUrl: 'https://track.acme.test/A-1042' };

  async function createTemplate(w: World, overrides: Record<string, unknown> = {}) {
    return inject({
      method: 'POST',
      url: `${base(w)}/custom-email-templates`,
      headers: auth(w.ownerToken),
      payload: { ...ORDER_TEMPLATE, ...overrides },
    });
  }

  async function publish(w: World, key = 'order_shipped') {
    return inject({
      method: 'POST',
      url: `${base(w)}/custom-email-templates/${key}/publish`,
      headers: auth(w.ownerToken),
    });
  }

  /** A world with `order_shipped` published and a key holding `email:send`. */
  async function ready(overrides: Record<string, unknown> = {}): Promise<World & { key: string }> {
    const w = await world();
    expect((await createTemplate(w, overrides)).statusCode).toBe(201);
    const pub = await publish(w, (overrides.key as string | undefined) ?? 'order_shipped');
    expect(pub.statusCode, pub.body).toBe(200);
    return { ...w, key: await mintKey(w, ['email:send']) };
  }

  const send = (key: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    inject({ method: 'POST', url: '/api/v1/email/send', headers: { ...auth(key), ...headers }, payload });

  const byoSends = () => h.sends.filter((s) => s.apiKey === BYO_KEY);
  const poolSends = () => h.sends.filter((s) => s.apiKey === POOL_KEY);

  describe('the send', () => {
    it('renders the latest published version through the application provider', async () => {
      const w = await ready();
      h.sends.length = 0;
      const res = await send(w.key, {
        template: 'order_shipped',
        to: 'Buyer@Example.com',
        variables: { ...GOOD_VARS, name: '<b>Sam</b>', shippedOn: '2026-09-26' },
      });
      expect(res.statusCode, res.body).toBe(202);
      const data = res.json().data;
      expect(data).toMatchObject({ status: 'sent', template: 'order_shipped', version: 1, messageId: 're_msg_1' });

      expect(poolSends()).toHaveLength(0);
      expect(byoSends()).toHaveLength(1);
      const sent = byoSends()[0]!.payload;
      expect(sent.from).toBe('Acme <hello@acme.test>');
      expect(sent.subject).toBe('Order A-1042 shipped');
      expect(sent.html).toContain('&lt;b&gt;Sam&lt;/b&gt;');
      expect(sent.html).not.toContain('<b>Sam</b>');
      expect(sent.html).toContain('href="https://track.acme.test/A-1042"');
      expect(sent.html).toContain('Shipped 2026-09-26');
      expect(sent.text).toContain('Track it (https://track.acme.test/A-1042)');

      const row = await prisma.emailLog.findUniqueOrThrow({ where: { id: data.id } });
      expect(row).toMatchObject({
        status: 'sent',
        via: 'byo_resend',
        customTemplateKey: 'order_shipped',
        customTemplateVersion: 1,
        toAddress: 'buyer@example.com',
        eventKey: null,
      });
    });

    it('uses the template fromName over the application one', async () => {
      const w = await ready({ fromName: 'Acme Orders' });
      h.sends.length = 0;
      await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(byoSends()[0]!.payload.from).toBe('Acme Orders <hello@acme.test>');
    });

    it('refuses a subject, HTML or anything else the body does not take, and sends nothing', async () => {
      const w = await ready();
      h.sends.length = 0;
      for (const extra of [{ subject: 'hi' }, { html: '<p>x</p>' }, { from: 'x@evil.test' }]) {
        const res = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
        expect(res.json().error.code).toBe('VALIDATION_ERROR');
      }
      expect(h.sends).toHaveLength(0);
    });

    it('strips line breaks from the subject so a value cannot add a header', async () => {
      const w = await ready({
        variableSchema: [
          { name: 'orderNumber', type: 'string', required: true, maxLength: 200 },
          { name: 'name', type: 'string' },
          { name: 'trackingUrl', type: 'url', required: true },
          { name: 'shippedOn', type: 'date' },
        ],
      });
      h.sends.length = 0;
      const res = await send(w.key, {
        template: 'order_shipped',
        to: 'b@example.com',
        variables: { ...GOOD_VARS, orderNumber: 'A-1\r\nBcc: victim@example.com\nX: y' },
      });
      expect(res.statusCode, res.body).toBe(202);
      const subject = byoSends()[0]!.payload.subject;
      expect(subject).not.toMatch(/[\r\n]/);
      expect(subject).toBe('Order A-1 Bcc: victim@example.com X: y shipped');
    });

    it('sends a pinned version, and refuses one that does not exist', async () => {
      const w = await ready();
      const edit = await inject({
        method: 'PATCH',
        url: `${base(w)}/custom-email-templates/order_shipped`,
        headers: auth(w.ownerToken),
        payload: { subject: 'Shipped: {{orderNumber}}' },
      });
      expect(edit.json().data).toMatchObject({ version: 1, hasUnpublishedChanges: true });

      // The draft edit changes nothing that is sent until it is published.
      h.sends.length = 0;
      await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(byoSends()[0]!.payload.subject).toBe('Order A-1042 shipped');

      const pub = await publish(w);
      expect(pub.json().data).toMatchObject({ version: 2, hasUnpublishedChanges: false, status: 'published' });

      h.sends.length = 0;
      const latest = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      const pinned = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, version: 1 });
      expect(latest.json().data.version).toBe(2);
      expect(pinned.json().data.version).toBe(1);
      expect(byoSends().map((s) => s.payload.subject)).toEqual(['Shipped: A-1042', 'Order A-1042 shipped']);

      const missing = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, version: 9 });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toMatchObject({ code: 'EMAIL_TEMPLATE_NOT_FOUND' });
      expect(missing.json().error.fix).toContain('from 1 to 2');
    });

    it('answers EMAIL_TEMPLATE_NOT_FOUND and EMAIL_TEMPLATE_NOT_PUBLISHED', async () => {
      const w = await ready();
      expect((await createTemplate(w, { key: 'draft_only' })).statusCode).toBe(201);
      const unknown = await send(w.key, { template: 'no_such_template', to: 'b@example.com' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('EMAIL_TEMPLATE_NOT_FOUND');
      const draft = await send(w.key, { template: 'draft_only', to: 'b@example.com', variables: GOOD_VARS });
      expect(draft.statusCode).toBe(409);
      expect(draft.json().error.code).toBe('EMAIL_TEMPLATE_NOT_PUBLISHED');
    });

    it('sends nothing after the template is deleted', async () => {
      const w = await ready();
      const del = await inject({
        method: 'DELETE',
        url: `${base(w)}/custom-email-templates/order_shipped`,
        headers: auth(w.ownerToken),
      });
      expect(del.statusCode).toBe(200);
      h.sends.length = 0;
      const res = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(res.json().error.code).toBe('EMAIL_TEMPLATE_NOT_FOUND');
      expect(h.sends).toHaveLength(0);
    });
  });

  describe('the key scope', () => {
    it('refuses a * key and a publishable key: email:send is elevated', async () => {
      const w = await ready();
      const star = await mintKey(w, ['*']);
      const res = await send(star, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
      expect(res.json().error.fix).toContain('elevated');

      const application = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
      const pub = await send(application.publicKey, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(pub.statusCode).toBe(401);
      expect(h.sends).toHaveLength(0);
    });
  });

  describe('the own-transport gate', () => {
    it('lets a pool application draft, but not publish', async () => {
      const w = await world({ byo: false });
      expect((await createTemplate(w)).statusCode).toBe(201);
      const pub = await publish(w);
      expect(pub.statusCode).toBe(403);
      expect(pub.json().error.code).toBe('EMAIL_TRANSPORT_NOT_CUSTOM');
      expect(pub.json().error.message).toContain('shared pool');

      const settings = await inject({ method: 'GET', url: `${base(w)}/custom-email-settings`, headers: auth(w.ownerToken) });
      expect(settings.json().data).toMatchObject({ eligible: false, transport: 'default_resend' });
    });

    it('refuses at send once the credentials are removed, and never touches the pool', async () => {
      const w = await ready();
      const removed = await inject({ method: 'DELETE', url: `${base(w)}/email-credentials`, headers: auth(w.ownerToken) });
      expect(removed.statusCode).toBe(200);
      h.sends.length = 0;
      const res = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_TRANSPORT_NOT_CUSTOM');
      expect(h.sends).toHaveLength(0);
      expect(await prisma.emailLog.count({ where: { applicationId: w.appId, customTemplateKey: { not: null } } })).toBe(0);
    });

    it('the transport itself refuses the pool for a custom send', async () => {
      // Credentials removed between the route check and the send.
      const w = await world({ byo: false });
      const application = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
      const outcome = await sendEmail(
        application,
        { to: 'b@example.com', subject: 's', html: '<p>x</p>' },
        { requireCustomTransport: true, customTemplateKey: 'order_shipped' },
      );
      expect(outcome.kind).toBe('error');
      expect(poolSends()).toHaveLength(0);
      // Control: the same call without the flag does ride the pool.
      await sendEmail(application, { to: 'b@example.com', subject: 's', html: '<p>x</p>' });
      expect(poolSends()).toHaveLength(1);
    });

    it('refuses when the sending domain changed since publish', async () => {
      const w = await ready();
      await connectResend(w, 'hello@other-brand.test');
      const res = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_SENDER_DOMAIN_MISMATCH');
      expect(res.json().error.message).toContain('acme.test');
      expect((await publish(w)).statusCode).toBe(200);
      h.sends.length = 0;
      const again = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(again.statusCode).toBe(202);
      expect(byoSends()[0]!.payload.from).toContain('hello@other-brand.test');
    });
  });

  describe('variables', () => {
    const issuesOf = (body: string) =>
      (JSON.parse(body).error.details.issues as Array<{ path: string; message: string }>).map((i) => i.path);

    it('reports every problem at once, and sends nothing', async () => {
      const w = await ready();
      h.sends.length = 0;
      const res = await send(w.key, {
        template: 'order_shipped',
        to: 'b@example.com',
        variables: {
          orderNumber: 'X'.repeat(17),
          trackingUrl: 'http://track.acme.test/1',
          shippedOn: 'next tuesday',
          itemCount: '3',
          coupon: 'FREE',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('EMAIL_VARIABLES_INVALID');
      expect(issuesOf(res.body).sort()).toEqual(
        ['variables.coupon', 'variables.itemCount', 'variables.orderNumber', 'variables.shippedOn', 'variables.trackingUrl'].sort(),
      );
      expect(h.sends).toHaveLength(0);
    });

    it('requires required variables', async () => {
      const w = await ready();
      const res = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: { name: 'Sam' } });
      expect(res.json().error.code).toBe('EMAIL_VARIABLES_INVALID');
      expect(issuesOf(res.body).sort()).toEqual(['variables.orderNumber', 'variables.trackingUrl']);
    });

    it('holds url values to https on the link domains, without credentials', async () => {
      const w = await ready();
      for (const trackingUrl of [
        'https://evil.test/phish',
        'https://track.acme.test.evil.test/x',
        'https://user:pw@track.acme.test/x',
        'javascript:alert(1)',
        'track.acme.test/x',
      ]) {
        const res = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: { ...GOOD_VARS, trackingUrl } });
        expect(res.statusCode, trackingUrl).toBe(400);
        expect(issuesOf(res.body), trackingUrl).toEqual(['variables.trackingUrl']);
      }
      const upper = await send(w.key, {
        template: 'order_shipped',
        to: 'b@example.com',
        variables: { ...GOOD_VARS, trackingUrl: 'https://TRACK.acme.test/ok' },
      });
      expect(upper.statusCode).toBe(202);
    });

    it('accepts numbers as numbers and ISO date-times with an offset', async () => {
      const w = await ready();
      const res = await send(w.key, {
        template: 'order_shipped',
        to: 'b@example.com',
        variables: { ...GOOD_VARS, itemCount: 3, shippedOn: '2026-09-26T10:00:00+05:30' },
      });
      expect(res.statusCode, res.body).toBe(202);
    });
  });

  describe('publish rules', () => {
    it('refuses undeclared variables, a non-url variable starting a link, and url without link domains', async () => {
      const w = await world();
      const created = await createTemplate(w, {
        key: 'bad_template',
        subject: 'Hi {{firstName}}',
        bodyHtml: '<a href="{{name}}">x</a><img src="{{trackingUrl}}">{{#if coupon}}c{{/if}}',
        linkDomains: [],
      });
      expect(created.statusCode).toBe(201);
      const res = await publish(w, 'bad_template');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('EMAIL_TEMPLATE_INVALID');
      const messages = (res.json().error.details.issues as Array<{ message: string }>).map((i) => i.message).join('\n');
      expect(messages).toContain('{{firstName}}');
      expect(messages).toContain('{{coupon}}');
      expect(messages).toContain('uses {{name}} where it decides the scheme or host');
      expect(messages).not.toContain('uses {{trackingUrl}} where');
      expect(messages).toContain('needs at least one hostname');
    });

    it('refuses a built-in key, a malformed key, a duplicate key, and a From name that carries an address', async () => {
      const w = await world();
      for (const key of ['welcome', 'password_reset', 'Order', 'ab', '1abc']) {
        const res = await createTemplate(w, { key });
        expect(res.statusCode, key).toBe(400);
      }
      expect(await prisma.customEmailTemplate.count({ where: { applicationId: w.appId } })).toBe(0);
      expect((await createTemplate(w)).statusCode).toBe(201);
      const dup = await createTemplate(w);
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('EMAIL_TEMPLATE_KEY_TAKEN');
      for (const fromName of ['Acme <evil@x.test>', 'a@b', 'Acme\r\nBcc: x']) {
        const res = await createTemplate(w, { key: 'another_one', fromName });
        expect(res.statusCode, fromName).toBe(400);
      }
    });
  });

  describe('idempotency', () => {
    it('replays the first result under the same key and sends once', async () => {
      const w = await ready();
      h.sends.length = 0;
      const body = { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, idempotencyKey: 'ship-1' };
      const first = await send(w.key, body);
      const second = await send(w.key, body);
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(second.json().data).toEqual(first.json().data);
      expect(byoSends()).toHaveLength(1);

      // The header is the same key.
      const viaHeader = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS }, { 'idempotency-key': 'ship-1' });
      expect(viaHeader.json().data.id).toBe(first.json().data.id);
      expect(byoSends()).toHaveLength(1);
    });

    it('refuses the same key for a different send, and a header that disagrees with the body', async () => {
      const w = await ready();
      await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, idempotencyKey: 'k-1' });
      const other = await send(w.key, {
        template: 'order_shipped',
        to: 'someone-else@example.com',
        variables: GOOD_VARS,
        idempotencyKey: 'k-1',
      });
      expect(other.statusCode).toBe(409);
      expect(other.json().error.code).toBe('EMAIL_IDEMPOTENCY_KEY_REUSED');

      const mismatch = await send(
        w.key,
        { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, idempotencyKey: 'a' },
        { 'idempotency-key': 'b' },
      );
      expect(mismatch.statusCode).toBe(400);
    });

    it('eight concurrent sends with one key deliver exactly once', async () => {
      const w = await ready();
      h.sends.length = 0;
      h.delayMs = 150;
      const body = { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, idempotencyKey: 'race-1' };
      const results = await Promise.all(Array.from({ length: 8 }, () => send(w.key, body)));
      h.delayMs = 0;

      expect(byoSends()).toHaveLength(1);
      const accepted = results.filter((r) => r.statusCode === 202);
      const inFlight = results.filter((r) => r.statusCode === 409);
      expect(accepted.length).toBeGreaterThanOrEqual(1);
      // Proof the racers overlapped: without contention this test proves nothing.
      expect(inFlight.length).toBeGreaterThan(0);
      expect(accepted.length + inFlight.length).toBe(8);
      for (const r of inFlight) expect(r.json().error.code).toBe('EMAIL_SEND_IN_FLIGHT');
      expect(new Set(accepted.map((r) => r.json().data.id)).size).toBe(1);

      const after = await send(w.key, body);
      expect(after.json().data.id).toBe(accepted[0]!.json().data.id);
      expect(byoSends()).toHaveLength(1);
      expect(await prisma.emailLog.count({ where: { applicationId: w.appId, idempotencyKey: 'race-1' } })).toBe(1);
    });

    it('a failed send replays as failed and is not retried under the same key', async () => {
      const w = await ready();
      h.sends.length = 0;
      h.fail = 'The acme.test domain is not verified.';
      const body = { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, idempotencyKey: 'fail-1' };
      const first = await send(w.key, body);
      expect(first.statusCode).toBe(502);
      expect(first.json().error.code).toBe('EMAIL_DELIVERY_FAILED');
      expect(first.json().error.fix).toContain('new key');
      h.fail = null;
      const second = await send(w.key, body);
      expect(second.statusCode).toBe(502);
      expect(second.json().error.details.id).toBe(first.json().error.details.id);
      expect(byoSends()).toHaveLength(1);
      const row = await prisma.emailLog.findUniqueOrThrow({ where: { id: first.json().error.details.id } });
      expect(row).toMatchObject({ status: 'error', error: 'The acme.test domain is not verified.' });
    });
  });

  describe('caps', () => {
    it('refuses the eleventh send to one recipient in an hour, and the key stays usable', async () => {
      const w = await ready();
      for (let i = 0; i < 10; i++) {
        const ok = await send(w.key, { template: 'order_shipped', to: 'capped@example.com', variables: GOOD_VARS });
        expect(ok.statusCode, `send ${i}`).toBe(202);
      }
      h.sends.length = 0;
      const refused = await send(w.key, {
        template: 'order_shipped',
        to: 'capped@example.com',
        variables: GOOD_VARS,
        idempotencyKey: 'after-cap',
      });
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe('EMAIL_RATE_LIMITED');
      expect(refused.json().error.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.headers['retry-after']).toBeDefined();
      expect(h.sends).toHaveLength(0);
      expect(await prisma.emailLog.count({ where: { idempotencyKey: 'after-cap' } })).toBe(0);

      const other = await send(w.key, { template: 'order_shipped', to: 'free@example.com', variables: GOOD_VARS });
      expect(other.statusCode).toBe(202);
    });

    it('does not count replays or suppressed sends', async () => {
      const w = await ready();
      await inject({
        method: 'POST',
        url: `${base(w)}/email-suppressions`,
        headers: auth(w.ownerToken),
        payload: { address: 'gone@example.com', reason: 'bounce' },
      });
      for (let i = 0; i < 12; i++) {
        const res = await send(w.key, { template: 'order_shipped', to: 'gone@example.com', variables: GOOD_VARS });
        expect(res.json().data.status).toBe('suppressed');
      }
      const body = { template: 'order_shipped', to: 'r@example.com', variables: GOOD_VARS, idempotencyKey: 'rep' };
      for (let i = 0; i < 12; i++) expect((await send(w.key, body)).statusCode).toBe(202);
      const fresh = await send(w.key, { template: 'order_shipped', to: 'r@example.com', variables: GOOD_VARS });
      expect(fresh.statusCode).toBe(202);
    });
  });

  describe('suppression and unsubscribe', () => {
    it('answers suppressed for a suppressed address and for switched-off email, and logs it', async () => {
      const w = await ready();
      await inject({
        method: 'POST',
        url: `${base(w)}/email-suppressions`,
        headers: auth(w.ownerToken),
        payload: { address: 'Gone@Example.com', reason: 'complaint' },
      });
      h.sends.length = 0;
      const res = await send(w.key, { template: 'order_shipped', to: 'gone@example.com', variables: GOOD_VARS });
      expect(res.statusCode).toBe(202);
      expect(res.json().data).toMatchObject({ status: 'suppressed', template: 'order_shipped', version: 1 });
      expect(res.json().data.messageId).toBeUndefined();
      const row = await prisma.emailLog.findUniqueOrThrow({ where: { id: res.json().data.id } });
      expect(row.status).toBe('suppressed');

      await prisma.application.update({ where: { id: w.appId }, data: { emailsEnabled: false } });
      const off = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(off.json().data.status).toBe('suppressed');
      expect(h.sends).toHaveLength(0);
    });

    it('notification mail carries one-click unsubscribe that works; critical mail carries none', async () => {
      const w = await ready();
      expect((await createTemplate(w, { key: 'receipt', category: 'critical' })).statusCode).toBe(201);
      expect((await publish(w, 'receipt')).statusCode).toBe(200);
      h.sends.length = 0;
      await send(w.key, { template: 'receipt', to: 'reader@example.com', variables: GOOD_VARS });
      await send(w.key, { template: 'order_shipped', to: 'reader@example.com', variables: GOOD_VARS });
      const [critical, notification] = byoSends().map((s) => s.payload);
      expect(critical!.headers).toBeUndefined();
      expect(notification!.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      const url = new URL(notification!.headers!['List-Unsubscribe']!.replace(/^<|>$/g, ''));
      expect(url.pathname).toBe('/api/v1/email/unsubscribe');
      const path = `${url.pathname}${url.search}`;

      // Opening the link changes nothing: mail scanners follow links.
      const confirm = await inject({ method: 'GET', url: path });
      expect(confirm.statusCode).toBe(200);
      expect(confirm.headers['content-type']).toContain('text/html');
      expect(confirm.body).toContain('<form method="post"');
      expect(confirm.body).toContain('Notification emails from Acme stop');
      expect(confirm.body).toContain('password resets');
      expect(await prisma.emailSuppression.count({ where: { applicationId: w.appId } })).toBe(0);

      const oneClick = await inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
      expect(oneClick.statusCode).toBe(200);
      const suppression = await prisma.emailSuppression.findUniqueOrThrow({
        where: { applicationId_address: { applicationId: w.appId, address: 'reader@example.com' } },
      });
      expect(suppression).toMatchObject({ reason: 'unsubscribe', category: 'notification', createdBy: null });
      expect(oneClick.body).toContain('Notification emails from Acme stop');
      expect(oneClick.body).not.toContain('will no longer receive email');

      h.sends.length = 0;
      const after = await send(w.key, { template: 'order_shipped', to: 'reader@example.com', variables: GOOD_VARS });
      expect(after.json().data.status).toBe('suppressed');
      expect(h.sends).toHaveLength(0);
    });

    it('accepts a multipart one-click post, keeps an existing reason, and ignores a forged token', async () => {
      const w = await ready();
      h.sends.length = 0;
      await send(w.key, { template: 'order_shipped', to: 'bounced@example.com', variables: GOOD_VARS });
      const header = byoSends()[0]!.payload.headers!['List-Unsubscribe']!;
      const url = new URL(header.replace(/^<|>$/g, ''));
      const path = `${url.pathname}${url.search}`;
      await inject({
        method: 'POST',
        url: `${base(w)}/email-suppressions`,
        headers: auth(w.ownerToken),
        payload: { address: 'bounced@example.com', reason: 'bounce' },
      });

      const boundary = 'xYzBoundary';
      const multipart = await inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`,
      });
      expect(multipart.statusCode).toBe(200);
      const row = await prisma.emailSuppression.findUniqueOrThrow({
        where: { applicationId_address: { applicationId: w.appId, address: 'bounced@example.com' } },
      });
      expect(row.reason).toBe('bounce');

      const token = url.searchParams.get('token')!;
      const [keyId, payload, signature] = token.split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({ a: w.appId, e: 'someone-else@example.com', c: 'notification' }),
      ).toString('base64url');
      for (const forged of [
        `${keyId}.${forgedPayload}.${signature}`,
        `${keyId}.${payload}.AAAA`,
        `other.${payload}.${signature}`,
        `${payload}.${signature}`,
        'garbage',
      ]) {
        const res = await inject({ method: 'POST', url: `/api/v1/email/unsubscribe?token=${forged}` });
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('does not work');
      }
      expect(
        await prisma.emailSuppression.count({ where: { applicationId: w.appId, address: 'someone-else@example.com' } }),
      ).toBe(0);
    });
  });

  describe('recipients must be end users', () => {
    it('refuses an address that is not an end user when the setting is on', async () => {
      const w = await ready();
      await prisma.endUser.create({ data: { applicationId: w.appId, email: 'member@example.com' } });
      const on = await inject({
        method: 'PATCH',
        url: `${base(w)}/custom-email-settings`,
        headers: auth(w.ownerToken),
        payload: { recipientsMustBeEndUsers: true },
      });
      expect(on.json().data).toMatchObject({ recipientsMustBeEndUsers: true, eligible: true });
      const stranger = await send(w.key, { template: 'order_shipped', to: 'stranger@example.com', variables: GOOD_VARS });
      expect(stranger.statusCode).toBe(403);
      expect(stranger.json().error.code).toBe('EMAIL_RECIPIENT_NOT_END_USER');
      const member = await send(w.key, { template: 'order_shipped', to: 'Member@Example.com', variables: GOOD_VARS });
      expect(member.statusCode).toBe(202);
    });
  });

  describe('operator routes', () => {
    it('previews the draft with sample values and sends nothing', async () => {
      const w = await world();
      await createTemplate(w, {
        variableSchema: [
          { name: 'orderNumber', type: 'string', required: true, sample: '<A-1>' },
          { name: 'name', type: 'string' },
          { name: 'trackingUrl', type: 'url', required: true },
          { name: 'shippedOn', type: 'date' },
        ],
      });
      h.sends.length = 0;
      const res = await inject({
        method: 'POST',
        url: `${base(w)}/custom-email-templates/order_shipped/preview`,
        headers: auth(w.ownerToken),
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.subject).toBe('Order <A-1> shipped');
      expect(res.json().data.html).toContain('&lt;A-1&gt;');
      expect(res.json().data.html).toContain('href="https://track.acme.test/"');
      expect(res.json().data.undeclared).toEqual([]);
      expect(h.sends).toHaveLength(0);
    });

    it('shows an undeclared variable as its token and lists it, instead of rendering it empty', async () => {
      const w = await world();
      await createTemplate(w, {
        subject: 'Your order {{orderId}} shipped',
        bodyHtml: '<p>Order {{orderId}} for {{name}}</p>{{#if giftNote}}<p>gift</p>{{/if}}',
        variableSchema: [{ name: 'name', type: 'string', sample: 'Sam' }],
        linkDomains: [],
      });
      const res = await inject({
        method: 'POST',
        url: `${base(w)}/custom-email-templates/order_shipped/preview`,
        headers: auth(w.ownerToken),
        payload: {},
      });
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data.undeclared).toEqual(['orderId', 'giftNote']);
      expect(data.subject).toBe('Your order {{orderId}} shipped');
      expect(data.html).toContain('<p>Order {{orderId}} for Sam</p>');
    });

    it("test-sends the draft to the operator's own address only", async () => {
      const w = await world();
      await createTemplate(w);
      h.sends.length = 0;
      const res = await inject({
        method: 'POST',
        url: `${base(w)}/custom-email-templates/order_shipped/test-send`,
        headers: auth(w.ownerToken),
        payload: { to: 'somebody-else@example.com' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ kind: 'sent', to: w.ownerEmail });
      expect(byoSends()).toHaveLength(1);
      expect(byoSends()[0]!.payload.to).toBe(w.ownerEmail);
      expect(byoSends()[0]!.payload.subject).toMatch(/^\[TEST\] /);
    });

    it('test-send is refused without a custom transport', async () => {
      const w = await world({ byo: false });
      await createTemplate(w);
      h.sends.length = 0;
      const res = await inject({
        method: 'POST',
        url: `${base(w)}/custom-email-templates/order_shipped/test-send`,
        headers: auth(w.ownerToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('EMAIL_TRANSPORT_NOT_CUSTOM');
      expect(h.sends).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it("another workspace's key cannot send or read this application's templates", async () => {
      const a = await ready();
      const b = await world();
      const bKey = await mintKey(b, ['email:send']);
      h.sends.length = 0;
      const res = await send(bKey, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('EMAIL_TEMPLATE_NOT_FOUND');
      expect(h.sends).toHaveLength(0);

      for (const [method, path] of [
        ['GET', `${base(a)}/custom-email-templates`],
        ['GET', `${base(a)}/custom-email-templates/order_shipped`],
        ['POST', `${base(a)}/custom-email-templates/order_shipped/publish`],
        ['POST', `${base(a)}/custom-email-templates/order_shipped/test-send`],
        ['DELETE', `${base(a)}/custom-email-templates/order_shipped`],
      ] as const) {
        const cross = await inject({ method, url: path, headers: auth(b.ownerToken) });
        expect(cross.statusCode, `${method} ${path}`).toBe(404);
        expect(cross.json().error.code).toBe('APPLICATION_NOT_FOUND');
      }
      expect(await prisma.customEmailTemplate.count({ where: { applicationId: a.appId } })).toBe(1);
    });
  });

  describe('unsubscribe scope (review blocker)', () => {
    async function endUser(w: World, email: string): Promise<void> {
      const res = await inject({
        method: 'POST',
        url: `${base(w)}/end-users`,
        headers: auth(w.ownerToken),
        payload: { email, password: 'pw-one-two-three' },
      });
      expect(res.statusCode, res.body).toBe(201);
    }

    async function oneClickUnsubscribe(w: World & { key: string }, to: string): Promise<void> {
      h.sends.length = 0;
      await send(w.key, { template: 'order_shipped', to, variables: GOOD_VARS });
      const header = byoSends()[0]!.payload.headers!['List-Unsubscribe']!;
      const url = new URL(header.replace(/^<|>$/g, ''));
      const res = await inject({
        method: 'POST',
        url: `${url.pathname}${url.search}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
      expect(res.statusCode).toBe(200);
    }

    async function forgotPassword(w: World, email: string) {
      const liveKey = await mintKey(w, ['*']);
      return inject({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        headers: { authorization: `Bearer ${liveKey}` },
        payload: { email },
      });
    }

    it('after a one-click unsubscribe, password reset and critical mail still send; notification does not', async () => {
      const w = await ready();
      expect((await createTemplate(w, { key: 'receipt', category: 'critical' })).statusCode).toBe(201);
      expect((await publish(w, 'receipt')).statusCode).toBe(200);
      await endUser(w, 'reader@example.com');
      await oneClickUnsubscribe(w, 'reader@example.com');

      h.sends.length = 0;
      const reset = await forgotPassword(w, 'reader@example.com');
      expect(reset.statusCode, reset.body).toBe(200);
      const resetMail = byoSends().filter((s) => s.payload.to === 'reader@example.com');
      expect(resetMail).toHaveLength(1);
      const resetLog = await prisma.emailLog.findFirst({
        where: { applicationId: w.appId, eventKey: 'password_reset' },
        orderBy: { createdAt: 'desc' },
      });
      expect(resetLog?.status).toBe('sent');

      h.sends.length = 0;
      const notification = await send(w.key, { template: 'order_shipped', to: 'reader@example.com', variables: GOOD_VARS });
      expect(notification.json().data.status).toBe('suppressed');
      const critical = await send(w.key, { template: 'receipt', to: 'reader@example.com', variables: GOOD_VARS });
      expect(critical.json().data.status).toBe('sent');
      expect(byoSends().map((s) => s.payload.subject)).toEqual(['Order A-1042 shipped']);
    });

    it('an operator suppression still stops every email, and widens an unsubscribe', async () => {
      const w = await ready();
      expect((await createTemplate(w, { key: 'receipt', category: 'critical' })).statusCode).toBe(201);
      expect((await publish(w, 'receipt')).statusCode).toBe(200);
      await endUser(w, 'gone@example.com');
      await oneClickUnsubscribe(w, 'gone@example.com');
      const added = await inject({
        method: 'POST',
        url: `${base(w)}/email-suppressions`,
        headers: auth(w.ownerToken),
        payload: { address: 'gone@example.com', reason: 'manual' },
      });
      expect(added.json().data).toMatchObject({ reason: 'manual', category: null });

      h.sends.length = 0;
      const reset = await forgotPassword(w, 'gone@example.com');
      expect(reset.statusCode).toBe(200);
      const critical = await send(w.key, { template: 'receipt', to: 'gone@example.com', variables: GOOD_VARS });
      expect(critical.json().data.status).toBe('suppressed');
      expect(byoSends()).toHaveLength(0);
    });

    it('an unsubscribe does not narrow an existing bounce, and the list shows the category', async () => {
      const w = await ready();
      await oneClickUnsubscribe(w, 'news@example.com');
      await inject({
        method: 'POST',
        url: `${base(w)}/email-suppressions`,
        headers: auth(w.ownerToken),
        payload: { address: 'bounced@example.com', reason: 'bounce' },
      });
      const { createUnsubscribeToken } = await import('../src/modules/email/custom/unsubscribe-token.js');
      const token = createUnsubscribeToken(w.appId, 'bounced@example.com');
      expect((await inject({ method: 'POST', url: `/api/v1/email/unsubscribe?token=${token}` })).statusCode).toBe(200);
      const list = await inject({ method: 'GET', url: `${base(w)}/email-suppressions`, headers: auth(w.ownerToken) });
      const items = list.json().data.items as Array<{ address: string; reason: string; category: string | null }>;
      expect(items.find((i) => i.address === 'news@example.com')).toMatchObject({ reason: 'unsubscribe', category: 'notification' });
      expect(items.find((i) => i.address === 'bounced@example.com')).toMatchObject({ reason: 'bounce', category: null });
    });
  });

  describe('stuck sends (review high)', () => {
    it('a pending row past five minutes answers EMAIL_SEND_OUTCOME_UNKNOWN, a fresh one EMAIL_SEND_IN_FLIGHT', async () => {
      const w = await ready();
      const body = { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS, idempotencyKey: 'stuck-1' };
      const first = await send(w.key, body);
      const id = first.json().data.id as string;

      await prisma.emailLog.update({ where: { id }, data: { status: 'pending' } });
      h.sends.length = 0;
      const fresh = await send(w.key, body);
      expect(fresh.json().error.code).toBe('EMAIL_SEND_IN_FLIGHT');

      await prisma.emailLog.update({ where: { id }, data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) } });
      const stale = await send(w.key, body);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatchObject({ code: 'EMAIL_SEND_OUTCOME_UNKNOWN', details: { id } });
      expect(stale.json().error.fix).toContain('new idempotency key');
      expect((await prisma.emailLog.findUniqueOrThrow({ where: { id } })).status).toBe('unknown');
      const again = await send(w.key, body);
      expect(again.json().error.code).toBe('EMAIL_SEND_OUTCOME_UNKNOWN');
      expect(h.sends).toHaveLength(0);
    });

    it('the sweep resolves stale pending rows nobody replays, and leaves fresh ones', async () => {
      const w = await ready();
      const { resolveStalePendingSends } = await import('../src/modules/email/custom/custom-send.service.js');
      const old = await prisma.emailLog.create({
        data: {
          applicationId: w.appId, toAddress: 'x@example.com', subject: '[pending] order_shipped', via: 'none',
          status: 'pending', createdAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      });
      const young = await prisma.emailLog.create({
        data: { applicationId: w.appId, toAddress: 'y@example.com', subject: '[pending] order_shipped', via: 'none', status: 'pending' },
      });
      expect(await resolveStalePendingSends()).toBe(1);
      expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('unknown');
      expect((await prisma.emailLog.findUniqueOrThrow({ where: { id: young.id } })).status).toBe('pending');
    });
  });

  describe('link rule (review medium b)', () => {
    async function publishWith(bodyHtml: string) {
      const w = await world();
      await createTemplate(w, {
        key: 'link_rule',
        bodyHtml,
        variableSchema: [
          { name: 'orderNumber', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'trackingUrl', type: 'url' },
        ],
      });
      const res = await publish(w, 'link_rule');
      return res;
    }

    it('refuses a non-url variable anywhere it decides scheme or host', async () => {
      for (const html of [
        '<a href="https://{{name}}.acme.test/">x</a>',
        '<a href="https://acme.test{{name}}">x</a>',
        '<a href=\'{{name}}\'>x</a>',
        '<img srcset="https://acme.test/a.png 1x, {{name}} 2x">',
        '<td background="{{name}}"></td>',
        '<form action="{{name}}"></form>',
        '<div style="background-image:url({{name}})"></div>',
        '<style>.x{background:url("{{name}}")}</style>',
        '<a href="//{{name}}/x">x</a>',
      ]) {
        const res = await publishWith(html);
        expect(res.statusCode, html).toBe(400);
        expect(res.json().error.details.issues, html).toEqual([
          expect.objectContaining({ path: 'bodyHtml', message: expect.stringContaining('uses {{name}} where it decides') }),
        ]);
      }
    });

    it('allows a non-url variable after a fixed origin, and a url variable anywhere', async () => {
      for (const html of [
        '<a href="https://acme.test/orders/{{name}}">x</a>',
        '<a href="/orders/{{name}}">x</a>',
        '<a href="mailto:{{name}}">x</a>',
        '<a href="{{trackingUrl}}">x</a>',
        '<img srcset="{{trackingUrl}} 1x, https://acme.test/{{name}}.png 2x">',
        '<div style="background:url(https://acme.test/{{name}}.png)"></div>',
        '<a href="{{#if trackingUrl}}{{trackingUrl}}{{/if}}">x</a>',
      ]) {
        const res = await publishWith(html);
        expect(res.statusCode, `${html} ${res.body}`).toBe(200);
      }
    });
  });

  describe('workspace caps (review medium d)', () => {
    it('reads Tenant.limits, and counts every application in the workspace together', async () => {
      const a = await ready();
      const application = await prisma.application.findUniqueOrThrow({ where: { id: a.appId } });
      await prisma.tenant.update({
        where: { id: application.tenantId },
        data: { limits: { emailSendDailyCap: 3, emailSendRecipientHourlyCap: 2 } },
      });
      const settings = await inject({ method: 'GET', url: `${base(a)}/custom-email-settings`, headers: auth(a.ownerToken) });
      expect(settings.json().data.caps).toEqual({ daily: 3, recipientHourly: 2 });

      // Recipient cap, with +tags counted as one address.
      expect((await send(a.key, { template: 'order_shipped', to: 'r+1@example.com', variables: GOOD_VARS })).statusCode).toBe(202);
      expect((await send(a.key, { template: 'order_shipped', to: 'r+2@example.com', variables: GOOD_VARS })).statusCode).toBe(202);
      const tagged = await send(a.key, { template: 'order_shipped', to: 'R@example.com', variables: GOOD_VARS });
      expect(tagged.json().error.code).toBe('EMAIL_RATE_LIMITED');

      // A second application in the same workspace shares the daily cap.
      const second = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: auth(a.ownerToken),
        payload: { name: 'Acme two', slug: `${a.tag}-two` },
      });
      const b = { ...a, appId: (second.json().data as { id: string }).id };
      await connectResend(b, 'hello@acme.test');
      expect((await createTemplate(b)).statusCode).toBe(201);
      expect((await publish(b)).statusCode).toBe(200);
      const bKey = await mintKey(b, ['email:send']);
      expect((await send(bKey, { template: 'order_shipped', to: 's@example.com', variables: GOOD_VARS })).statusCode).toBe(202);
      const over = await send(bKey, { template: 'order_shipped', to: 't@example.com', variables: GOOD_VARS });
      expect(over.json().error.code).toBe('EMAIL_RATE_LIMITED');
      expect(over.json().error.message).toContain('3 custom emails per UTC day');
    });
  });

  describe('soft delete (review low)', () => {
    it('keeps versions, and a recreated key starts as a draft that continues the numbering', async () => {
      const w = await ready();
      const del = await inject({ method: 'DELETE', url: `${base(w)}/custom-email-templates/order_shipped`, headers: auth(w.ownerToken) });
      expect(del.statusCode).toBe(200);
      const list = await inject({ method: 'GET', url: `${base(w)}/custom-email-templates`, headers: auth(w.ownerToken) });
      expect(list.json().data.items).toHaveLength(0);
      expect(await prisma.customEmailTemplateVersion.count({ where: { applicationId: w.appId } })).toBe(1);

      const again = await createTemplate(w, { subject: 'Shipped again {{orderNumber}}' });
      expect(again.statusCode).toBe(201);
      expect(again.json().data).toMatchObject({ status: 'draft' });
      const draftSend = await send(w.key, { template: 'order_shipped', to: 'b@example.com', variables: GOOD_VARS });
      expect(draftSend.json().error.code).toBe('EMAIL_TEMPLATE_NOT_PUBLISHED');
      const pub = await publish(w);
      expect(pub.json().data.version).toBe(2);
      expect(await prisma.customEmailTemplateVersion.count({ where: { applicationId: w.appId } })).toBe(2);
    });
  });
});
