/**
 * Email pipeline tests:
 *
 *   - Event registry rendering with HTML escape (XSS guard).
 *   - Template overrides win over built-in defaults.
 *   - `describeTransport` reports BYO / default / none correctly.
 *   - Email-verification flow: send → consume → emailVerified=true; stale
 *     token rejected after email-change.
 *
 * Transport selection is tested without actually hitting Resend, the
 * default env doesn't set RESEND_DEFAULT_API_KEY in tests, so a no-creds
 * Application gets `kind: 'no_transport'` and the auth flow returns the
 * raw token. That keeps existing customers' legacy contract intact and
 * is the codepath used by 99% of self-hosters today.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { describeTransport } from '../src/lib/email-transport.js';
import { renderTemplate } from '../src/modules/email/render.js';
import { brandFromApplication, defaultTemplate } from '../src/modules/email/defaults/index.js';
import { EMAIL_EVENTS, type EmailEventKey } from '../src/modules/email/events.js';

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('Email pipeline', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const tenantSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-email-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: `App ${slug}`, slug: `email-${slug}` },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      tenantAccess: tenantSession.accessToken,
    };
  }

  // ---------- Render pipeline ----------

  it('renderTemplate HTML-escapes substituted values (XSS guard)', () => {
    const out = renderTemplate(
      '<p>Hi {{name}}</p>',
      { name: '<script>alert(1)</script>' },
      { escape: true },
    );
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('unknown {{vars}} render as empty strings, not the literal token', () => {
    const out = renderTemplate('Hello {{missing}}.', {}, { escape: true });
    expect(out).toBe('Hello .');
  });

  // ---------- Template overrides ----------

  it('built-in default is used when no override exists', async () => {
    const b = await bootstrap('def');
    const rendered = await emailService.renderForEvent(b.applicationId, 'password_reset', {
      userEmail: 'alice@example.com',
      resetUrl: 'https://example.com/r',
      expiresAtIso: '2026-01-01T00:00:00Z',
    });
    expect(rendered.customised).toBe(false);
    expect(rendered.subject).toBe('Reset your App def password');
    expect(rendered.html).toContain('alice@example.com');
    expect(rendered.html).toContain('https://example.com/r');
  });

  it('a customised template wins over the built-in default', async () => {
    const b = await bootstrap('cus');
    await emailService.setTemplate({
      applicationId: b.applicationId,
      eventKey: 'password_reset',
      subject: 'Custom subject for {{userEmail}}',
      designJson: { source: 'unlayer-export-here' },
      bodyHtml: '<p>Custom body for {{userEmail}} at {{resetUrl}}</p>',
    });
    const rendered = await emailService.renderForEvent(b.applicationId, 'password_reset', {
      userEmail: 'bob@example.com',
      resetUrl: 'https://example.com/r2',
      expiresAtIso: 'whatever',
    });
    expect(rendered.customised).toBe(true);
    expect(rendered.subject).toBe('Custom subject for bob@example.com');
    expect(rendered.html).toContain('Custom body for bob@example.com');
    expect(rendered.html).toContain('https://example.com/r2');
  });

  it("the built-in default wears the Application's portal branding", async () => {
    const b = await bootstrap('brand');
    await prisma.application.update({
      where: { id: b.applicationId },
      data: {
        portalBranding: {
          displayName: 'Acme',
          logoUrl: 'https://cdn.example.com/acme.png',
          primaryColor: '#e11d48',
          supportEmail: 'help@acme.example',
        },
      },
    });
    const rendered = await emailService.renderForEvent(b.applicationId, 'password_reset', {
      userEmail: 'alice@example.com',
      resetUrl: 'https://example.com/r',
      expiresAtIso: '2026-01-01T00:00:00Z',
    });
    expect(rendered.subject).toBe('Reset your Acme password');
    expect(rendered.html).toContain('<img src="https://cdn.example.com/acme.png" alt="Acme"');
    expect(rendered.html).toContain('background-color:#e11d48');
    expect(rendered.html).toContain('href="mailto:help@acme.example"');
    expect(rendered.html).not.toContain('Rekey');
    expect(rendered.text).toContain('Reset password:\nhttps://example.com/r');
    expect(rendered.text).toContain('Need help? Contact help@acme.example.');
    expect(rendered.text).not.toMatch(/<[a-z]/i);
  });

  it('branding never reaches a customised template, which is sent exactly as saved', async () => {
    const b = await bootstrap('brand-cus');
    await emailService.setTemplate({
      applicationId: b.applicationId,
      eventKey: 'welcome',
      subject: 'Custom welcome',
      designJson: {},
      bodyHtml: '<p>Custom body for {{userEmail}}</p>',
    });
    await prisma.application.update({
      where: { id: b.applicationId },
      data: { portalBranding: { displayName: 'Acme', primaryColor: '#e11d48' } },
    });
    const rendered = await emailService.renderForEvent(b.applicationId, 'welcome', { userEmail: 'c@example.com' });
    expect(rendered.customised).toBe(true);
    expect(rendered.subject).toBe('Custom welcome');
    expect(rendered.html).toBe('<p>Custom body for c@example.com</p>');
  });

  it("workspace mail keeps Rekey's name, whatever the Application is called", async () => {
    const b = await bootstrap('brand-sys');
    await prisma.application.update({
      where: { id: b.applicationId },
      data: { portalBranding: { displayName: 'Acme' } },
    });
    const rendered = await emailService.renderForEvent(b.applicationId, 'workspace_invitation', {
      inviterName: 'Alex',
      workspaceName: 'Acme Inc',
      inviteeEmail: 'x@example.com',
      inviteUrl: 'https://panel.example.com/accept',
      expiresAtIso: 'later',
    });
    expect(rendered.subject).toBe('Alex invited you to Acme Inc on Rekey');
    expect(rendered.html).not.toContain('>Acme<');
  });

  describe('Secured by Rekey attribution, from the workspace limits', () => {
    const vars = { userEmail: 'd@example.com', appUrl: 'https://app.example.com' };

    async function withLimits(slug: string, limits: unknown): Promise<string> {
      const b = await bootstrap(slug);
      const { tenantId } = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
      await prisma.tenant.update({ where: { id: tenantId }, data: { limits: limits as never } });
      return b.applicationId;
    }

    it('appears on an end-user default when the workspace has emailAttribution', async () => {
      const id = await withLimits('attr-on', { maxProductionApps: 1, emailAttribution: true });
      const rendered = await emailService.renderForEvent(id, 'welcome', vars);
      expect(rendered.html).toContain('>Secured by Rekey</a>');
      expect(rendered.text).toContain('Secured by Rekey: https://rekey.dev');
    });

    it('is off with no limits, with the flag false, and with limits that fail to parse', async () => {
      for (const [slug, limits] of [
        ['attr-none', null],
        ['attr-false', { emailAttribution: false }],
        ['attr-bad', { emailAttribution: 'yes' }],
      ] as const) {
        const id = await withLimits(slug, limits);
        const rendered = await emailService.renderForEvent(id, 'welcome', vars);
        expect(rendered.html, slug).not.toContain('Secured by Rekey');
        expect(rendered.text, slug).not.toContain('Secured by Rekey');
      }
    });

    it('is never added to a customised template', async () => {
      const id = await withLimits('attr-cus', { emailAttribution: true });
      await emailService.setTemplate({
        applicationId: id,
        eventKey: 'welcome',
        subject: 'Hi',
        designJson: {},
        bodyHtml: '<p>Custom {{userEmail}}</p>',
        bodyText: 'Custom {{userEmail}}',
      });
      const rendered = await emailService.renderForEvent(id, 'welcome', vars);
      expect(rendered.html).toBe('<p>Custom d@example.com</p>');
      expect(rendered.text).toBe('Custom d@example.com');
    });

    it('is not added to workspace mail, which Rekey already signs', async () => {
      const id = await withLimits('attr-sys', { emailAttribution: true });
      const rendered = await emailService.renderForEvent(id, 'workspace_invitation', {
        inviterName: 'Alex',
        workspaceName: 'W',
        inviteeEmail: 'x@example.com',
        inviteUrl: 'https://panel.example.com/accept',
        expiresAtIso: '2026-09-27T14:50:00.000Z',
      });
      expect(rendered.html).not.toContain('Secured by Rekey');
    });
  });

  // ---------- Transport selection ----------

  it('describeTransport returns `none` when no BYO creds + no env default', async () => {
    const b = await bootstrap('none');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const t = describeTransport(application);
    expect(t.via).toBe('none');
    expect(t.fromAddress).toBeNull();
  });

  it('describeTransport returns `byo_resend` after creds are set', async () => {
    const b = await bootstrap('byo');
    await emailService.setCredentials({
      applicationId: b.applicationId,
      credentials: { provider: 'resend', apiKey: 're_byo_test_key' },
      fromAddress: 'support@example.com',
      fromName: 'Support',
    });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const t = describeTransport(application);
    expect(t.via).toBe('byo_resend');
    expect(t.provider).toBe('resend');
    expect(t.fromAddress).toBe('support@example.com');
  });

  it('describeTransport returns `byo_smtp` after SMTP creds are set', async () => {
    const b = await bootstrap('smtp');
    await emailService.setCredentials({
      applicationId: b.applicationId,
      credentials: {
        provider: 'smtp',
        host: 'smtp.postmarkapp.com',
        port: 587,
        secure: false,
        user: 'pm-user',
        pass: 'pm-pass',
      },
      fromAddress: 'smtp-from@example.com',
    });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const t = describeTransport(application);
    expect(t.via).toBe('byo_smtp');
    expect(t.provider).toBe('smtp');
    expect(t.fromAddress).toBe('smtp-from@example.com');
  });

  it('legacy { resend: { apiKey } } ciphertext is read as a Resend transport', async () => {
    const b = await bootstrap('legacy');
    // Write the pre-discriminator shape directly (as older rows have it).
    const { encryptJson } = await import('../src/lib/secrets.js');
    await prisma.application.update({
      where: { id: b.applicationId },
      data: {
        emailCredentialsCiphertext: encryptJson({ resend: { apiKey: 're_legacy_key' } }),
        emailConfig: { fromAddress: 'legacy@example.com' },
      },
    });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    const t = describeTransport(application);
    expect(t.via).toBe('byo_resend');
    expect(t.provider).toBe('resend');
  });

  // ---------- Tenant routes ----------

  it('GET /email-templates lists every registry event with customised flag', async () => {
    const b = await bootstrap('list');
    await emailService.setTemplate({
      applicationId: b.applicationId,
      eventKey: 'welcome',
      subject: 'hi',
      designJson: {},
      bodyHtml: '<p>hi</p>',
    });
    const r = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/email-templates`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(r.statusCode).toBe(200);
    const events = r.json().data as Array<{ key: string; customised: boolean }>;
    expect(events.find((e) => e.key === 'welcome')?.customised).toBe(true);
    expect(events.find((e) => e.key === 'password_reset')?.customised).toBe(false);
  });

  it('DELETE /email-templates/:eventKey reverts to the built-in default', async () => {
    const b = await bootstrap('revert');
    await emailService.setTemplate({
      applicationId: b.applicationId,
      eventKey: 'password_reset',
      subject: 'override',
      designJson: {},
      bodyHtml: '<p>override</p>',
    });
    const before = await emailService.renderForEvent(
      b.applicationId,
      'password_reset',
      EMAIL_SAMPLE_VARS,
    );
    expect(before.customised).toBe(true);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/email-templates/password_reset`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });

    const after = await emailService.renderForEvent(
      b.applicationId,
      'password_reset',
      EMAIL_SAMPLE_VARS,
    );
    expect(after.customised).toBe(false);
    expect(after.subject).toBe('Reset your App revert password');

    // The editor reopens on the default, not on the reverted override or on
    // an empty canvas.
    const tpl = await emailService.getTemplate(b.applicationId, 'password_reset');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId } });
    expect(tpl?.designJson).toEqual(defaultTemplate('password_reset', brandFromApplication(application)).design);
  });

  it('GET /email-templates/:eventKey hands the editor a design for every uncustomised event', async () => {
    const b = await bootstrap('design');
    for (const key of Object.keys(EMAIL_EVENTS) as EmailEventKey[]) {
      const r = await app.inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/email-templates/${key}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(r.statusCode).toBe(200);
      const data = r.json().data as { customised: boolean; designJson: { body?: { rows?: unknown[] } } | null };
      expect(data.customised).toBe(false);
      expect(data.designJson?.body?.rows?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('a customised template returns its saved design, not the default', async () => {
    const b = await bootstrap('saved-design');
    const saved = { body: { rows: [{ id: 'mine' }] } };
    await emailService.setTemplate({
      applicationId: b.applicationId,
      eventKey: 'welcome',
      subject: 'hi',
      designJson: saved,
      bodyHtml: '<p>hi</p>',
    });
    const tpl = await emailService.getTemplate(b.applicationId, 'welcome');
    expect(tpl?.customised).toBe(true);
    expect(tpl?.designJson).toEqual(saved);
  });

  // ---------- Verify-email flow ----------

  it('send-verification → verify-email flips emailVerified to true', async () => {
    const b = await bootstrap('verify');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'verify-me@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string; emailVerified: boolean } });
    expect(eu.endUser.emailVerified).toBe(false);

    const send = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/send-verification',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': eu.accessToken,
      },
      // No `{token}` placeholder, the route's `format: uri` schema
      // rejects strings with curly braces. The service falls back to its
      // built-in placeholder URL when verifyUrl is omitted.
      payload: {},
    });
    expect(send.statusCode).toBe(200);
    const sendData = send.json().data as { emailSent: boolean; verificationToken: string | null };
    // No transport configured in tests, token returned to caller.
    expect(sendData.emailSent).toBe(false);
    expect(sendData.verificationToken).toBeTruthy();

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: sendData.verificationToken },
    });
    expect(verify.statusCode).toBe(200);
    const verifyData = verify.json().data as { ok: true; endUser: { emailVerified: boolean } };
    expect(verifyData.endUser.emailVerified).toBe(true);

    // Re-use of the same token is refused.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: sendData.verificationToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_USED');
  });

  it('verify-email refuses tokens that belong to a different Application', async () => {
    const b = await bootstrap('xapp-a');
    const otherApp = await bootstrap('xapp-b');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'xverify@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string });
    const send = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/send-verification',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': eu.accessToken,
        },
        payload: {},
      })
      .then((r) => r.json().data as { verificationToken: string });

    // Present it to a different Application's secret key.
    const cross = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${otherApp.liveKey}` },
      payload: { token: send.verificationToken },
    });
    expect(cross.statusCode).toBe(401);
    expect(cross.json().error.code).toBe('EMAIL_VERIFICATION_TOKEN_WRONG_APPLICATION');
  });

  it('verify-email refuses if the user changed email after the token was minted', async () => {
    const b = await bootstrap('stale');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'stale-a@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    const send = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/send-verification',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-rekey-user-token': eu.accessToken,
        },
        payload: {},
      })
      .then((r) => r.json().data as { verificationToken: string });

    // Simulate an email change.
    await prisma.endUser.update({
      where: { id: eu.endUser.id },
      data: { email: 'stale-b@example.com' },
    });

    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { token: send.verificationToken },
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('EMAIL_VERIFICATION_STALE');
  });

  it('send-verification refuses when emailVerified is already true', async () => {
    const b = await bootstrap('already');
    const eu = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { email: 'already@example.com', password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });
    await prisma.endUser.update({
      where: { id: eu.endUser.id },
      data: { emailVerified: true },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/send-verification',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-rekey-user-token': eu.accessToken,
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EMAIL_ALREADY_VERIFIED');
  });

  afterAll(async () => {
    await prisma.endUser.deleteMany({
      where: { email: { contains: '@example.com' } },
    });
  });
});

const EMAIL_SAMPLE_VARS = {
  userEmail: 'sample@example.com',
  resetUrl: 'https://example.com/r',
  expiresAtIso: '2026-01-01T00:00:00Z',
};
