/**
 * Sender identity (`fromName`, `replyTo`, `supportEmail`), set on its own route
 * and kept apart from the transport credentials.
 *
 * The shared pool is configured here and Resend is replaced by a recorder, so
 * every assertion is about the payload the transport really handed over.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      RESEND_DEFAULT_API_KEY: 're_pool_shared_key',
      RESEND_DEFAULT_FROM: 'pool@rekey.test',
      RESEND_DEFAULT_FROM_NAME: 'Rekey',
    },
  };
});

const h = vi.hoisted(() => ({
  sends: [] as Array<{ apiKey: string; payload: { from: string; replyTo?: string } }>,
}));

vi.mock('resend', () => ({
  Resend: class {
    readonly emails: { send: (payload: never) => Promise<unknown> };
    constructor(apiKey: string) {
      this.emails = {
        send: async (payload: never) => {
          h.sends.push({ apiKey, payload });
          return { data: { id: `re_${h.sends.length}` }, error: null };
        },
      };
    }
  },
}));

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { sendEmail } = await import('../src/lib/email-transport.js');

describe('email sender identity', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    n += 1;
    h.sends.length = 0;
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${n}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${n}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Acme', slug: `sender-${n}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
  });

  function patchSender(payload: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/email-sender`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  function putCredentials(payload: Record<string, unknown>) {
    return app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/email-credentials`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  async function storedConfig() {
    const row = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    return row.emailConfig as Record<string, unknown> | null;
  }

  async function send() {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    return sendEmail(application, { to: 'user@example.com', subject: 'Hi', html: '<p>Hi</p>' });
  }

  it('stores the three fields and reads them back on email-config', async () => {
    const res = await patchSender({
      fromName: 'Acme Support',
      replyTo: 'Help@Acme.test ',
      supportEmail: 'support@acme.test',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.sender).toEqual({
      fromName: 'Acme Support',
      replyTo: 'Help@Acme.test',
      supportEmail: 'support@acme.test',
    });
    const cfg = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appId}/email-config`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cfg.json().data.emailConfig).toMatchObject({
      fromName: 'Acme Support',
      replyTo: 'Help@Acme.test',
      supportEmail: 'support@acme.test',
    });
  });

  it('omitted fields are left alone and null clears one', async () => {
    await patchSender({ fromName: 'Acme Support', replyTo: 'help@acme.test' });
    expect((await patchSender({ supportEmail: 'support@acme.test' })).statusCode).toBe(200);
    expect(await storedConfig()).toEqual({
      fromName: 'Acme Support',
      replyTo: 'help@acme.test',
      supportEmail: 'support@acme.test',
    });
    expect((await patchSender({ replyTo: null })).statusCode).toBe(200);
    expect(await storedConfig()).toEqual({ fromName: 'Acme Support', supportEmail: 'support@acme.test' });
  });

  it('the shared pool sets Reply-To and keeps the (via ...) suffix on a custom name', async () => {
    await patchSender({ fromName: 'Acme Support', replyTo: 'help@acme.test' });
    const outcome = await send();
    expect(outcome.kind).toBe('sent');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.apiKey).toBe('re_pool_shared_key');
    expect(h.sends[0]!.payload.replyTo).toBe('help@acme.test');
    expect(h.sends[0]!.payload.from).toBe('"Acme Support (via Rekey)" <pool@rekey.test>');
  });

  it('a name that claims the deployment itself still carries the suffix on the pool', async () => {
    await patchSender({ fromName: 'Rekey' });
    await send();
    expect(h.sends[0]!.payload.from).toBe('"Rekey (via Rekey)" <pool@rekey.test>');
  });

  it('BYO credentials send under the name verbatim and honour Reply-To', async () => {
    expect(
      (await putCredentials({ provider: 'resend', apiKey: 're_byo', fromAddress: 'no-reply@acme.test' }))
        .statusCode,
    ).toBe(200);
    await patchSender({ fromName: 'Acme Support', replyTo: 'help@acme.test' });
    await send();
    expect(h.sends[0]!.apiKey).toBe('re_byo');
    expect(h.sends[0]!.payload.replyTo).toBe('help@acme.test');
    expect(h.sends[0]!.payload.from).toBe('Acme Support <no-reply@acme.test>');
  });

  it('saving credentials keeps the sender fields', async () => {
    await patchSender({ fromName: 'Acme Support', replyTo: 'help@acme.test', supportEmail: 'support@acme.test' });
    const res = await putCredentials({ provider: 'resend', apiKey: 're_byo', fromAddress: 'no-reply@acme.test' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await storedConfig()).toEqual({
      fromAddress: 'no-reply@acme.test',
      fromName: 'Acme Support',
      replyTo: 'help@acme.test',
      supportEmail: 'support@acme.test',
    });
  });

  it('concurrent credential and sender saves keep every key (8 racers)', async () => {
    const racers = [
      ...[1, 2, 3, 4].map((i) =>
        putCredentials({ provider: 'resend', apiKey: `re_${i}`, fromAddress: `no-reply-${i}@acme.test` }),
      ),
      patchSender({ fromName: 'Acme Support' }),
      patchSender({ replyTo: 'help@acme.test' }),
      patchSender({ supportEmail: 'support@acme.test' }),
      patchSender({ fromName: 'Acme Support' }),
    ];
    const results = await Promise.all(racers);
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    const cfg = await storedConfig();
    expect(cfg).toMatchObject({
      fromName: 'Acme Support',
      replyTo: 'help@acme.test',
      supportEmail: 'support@acme.test',
    });
    expect(String(cfg?.fromAddress)).toMatch(/^no-reply-[1-4]@acme\.test$/);
  });

  it('saving credentials with sender fields still overrides them', async () => {
    await patchSender({ fromName: 'Old', replyTo: 'old@acme.test' });
    await putCredentials({
      provider: 'resend',
      apiKey: 're_byo',
      fromAddress: 'no-reply@acme.test',
      fromName: 'New',
      replyTo: 'new@acme.test',
    });
    expect(await storedConfig()).toMatchObject({ fromName: 'New', replyTo: 'new@acme.test' });
  });

  it.each([
    ['CRLF', 'Acme\r\nBcc: victim@example.com'],
    ['bare LF', 'Acme\nBcc: victim@example.com'],
    ['bare CR', 'Acme\rBcc: victim@example.com'],
    ['TAB', 'Acme\tSupport'],
  ])('refuses a header-injection attempt in fromName (%s)', async (_label, fromName) => {
    const res = await patchSender({ fromName });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EMAIL_FROM_NAME_INVALID');
    expect(await storedConfig()).toEqual({});
  });

  it('refuses a header-injection attempt through the credentials route too', async () => {
    const res = await putCredentials({
      provider: 'resend',
      apiKey: 're_byo',
      fromAddress: 'no-reply@acme.test',
      fromName: 'Acme\r\nBcc: victim@example.com',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EMAIL_FROM_NAME_INVALID');
  });

  it('refuses a malformed reply-to and support address', async () => {
    const replyTo = await patchSender({ replyTo: 'not-an-address' });
    expect(replyTo.statusCode).toBe(400);
    expect(replyTo.json().error.code).toBe('EMAIL_REPLY_TO_INVALID');
    const crlf = await patchSender({ replyTo: 'a@acme.test\r\nBcc: victim@example.com' });
    expect(crlf.json().error.code).toBe('EMAIL_REPLY_TO_INVALID');
    const support = await patchSender({ supportEmail: 'support at acme' });
    expect(support.statusCode).toBe(400);
    expect(support.json().error.code).toBe('EMAIL_SUPPORT_EMAIL_INVALID');
  });

  it('refuses an empty body and unknown keys', async () => {
    expect((await patchSender({})).statusCode).toBe(400);
    expect((await patchSender({ fromAddress: 'x@acme.test' })).statusCode).toBe(400);
  });

  it('exposes supportEmail on the Application a key resolves to', async () => {
    await patchSender({ supportEmail: 'support@acme.test' });
    const rawKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me/',
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(me.json().data.supportEmail).toBe('support@acme.test');
  });
});

describe('support contact precedence in built-in emails', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    n += 1;
    h.sends.length = 0;
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `prec-${n}@example.com`, password: 'pw-one-two-three', workspaceName: `P ${n}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Acme', slug: `support-prec-${n}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
  });

  async function setPortalSupport(supportEmail: string) {
    await prisma.application.update({ where: { id: appId }, data: { portalBranding: { supportEmail } } });
  }

  async function setSenderSupport(supportEmail: string | null) {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/email-sender`,
      headers: { authorization: `Bearer ${token}` },
      payload: { supportEmail },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function preview() {
    const { emailService } = await import('../src/modules/email/email.service.js');
    return emailService.previewWithSamples(appId, 'password_reset');
  }

  it('the sender supportEmail wins over the portal branding one', async () => {
    await setPortalSupport('portal-help@acme.test');
    await setSenderSupport('sender-help@acme.test');
    const { html, text } = await preview();
    expect(html).toContain('mailto:sender-help@acme.test');
    expect(text).toContain('sender-help@acme.test');
    expect(html).not.toContain('portal-help@acme.test');
    expect(text).not.toContain('portal-help@acme.test');
  });

  it('falls back to the portal branding supportEmail when the sender has none', async () => {
    await setPortalSupport('portal-help@acme.test');
    const { html } = await preview();
    expect(html).toContain('mailto:portal-help@acme.test');
  });

  it('clearing the sender supportEmail falls back to the portal one', async () => {
    await setPortalSupport('portal-help@acme.test');
    await setSenderSupport('sender-help@acme.test');
    await setSenderSupport(null);
    const { html } = await preview();
    expect(html).toContain('mailto:portal-help@acme.test');
  });

  it('shows no support line when neither is set', async () => {
    const { html, text } = await preview();
    expect(html).not.toContain('Need help?');
    expect(text).not.toContain('Need help?');
  });

  it('the dispatched mail uses the same precedence', async () => {
    await setPortalSupport('portal-help@acme.test');
    await setSenderSupport('sender-help@acme.test');
    const { dispatch } = await import('../src/modules/email/email.service.js');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const outcome = await dispatch({
      application,
      eventKey: 'password_reset',
      to: 'user@example.com',
      variables: {
        userEmail: 'user@example.com',
        resetUrl: 'https://app.acme.test/reset?t=x',
        expiresAtIso: new Date().toISOString(),
      },
    });
    expect(outcome.kind).toBe('sent');
    const payload = h.sends.at(-1)!.payload as unknown as { html: string };
    expect(payload.html).toContain('mailto:sender-help@acme.test');
    expect(payload.html).not.toContain('portal-help@acme.test');
  });

  it('a stored sender value that fails the mailto check falls back rather than rendering', async () => {
    const { brandFromApplication } = await import('../src/modules/email/defaults/index.js');
    const brand = brandFromApplication({
      name: 'Acme',
      portalBranding: { supportEmail: 'portal-help@acme.test' },
      emailConfig: { supportEmail: 'a@b.test?bcc=victim@example.com' },
    });
    expect(brand.supportEmail).toBe('portal-help@acme.test');
  });
});
