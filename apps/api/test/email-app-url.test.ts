/**
 * Links in transactional emails must resolve, or not render.
 *
 * The bug this file locks down: the welcome email's "Get started" button
 * pointed at `https://your-app.example.com`, a placeholder domain, for every
 * customer who didn't pass `appUrl` through the SDK. The obvious fix is a
 * trap — `renderTemplate` substitutes an unknown `{{var}}` with the empty
 * string, so simply dropping the fallback produces `href=""`, which is the
 * same broken button with a quieter failure mode.
 *
 * So there are two properties under test:
 *
 *   1. The resolution chain — caller > per-Application `authConfig.appUrl` >
 *      origin of `redirectUrls[0]` > `DEFAULT_APP_URL` env > nothing.
 *   2. Nothing resolvable ⇒ NO anchor in the rendered HTML at all. Not a
 *      placeholder, not an empty href, not a bare `<a>`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { emailService } from '../src/modules/email/email.service.js';
import { renderTemplate, stripEmptyHrefAnchors } from '../src/modules/email/render.js';
import { resolveAppUrl, buildTokenUrl } from '../src/lib/app-url.js';

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  tenantAccess: string;
}

/** Every `href="…"` value in a rendered body, in document order. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href\s*=\s*"([^"]*)"/gi)].map((m) => m[1]!);
}

describe('Email app URL resolution', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await prisma.endUser.deleteMany({ where: { email: { contains: 'appurl' } } });
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const tenantSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-appurl-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS appurl ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: `App appurl ${slug}`, slug: `appurl-${slug}` },
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

  /** Set authConfig fields straight on the row, bypassing the HTTP layer. */
  async function setAuthConfig(
    applicationId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const row = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    await prisma.application.update({
      where: { id: applicationId },
      data: { authConfig: { ...(row.authConfig as object), ...patch } as object },
    });
  }

  async function load(applicationId: string): Promise<{ authConfig: unknown }> {
    return prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
  }

  // ---------- 1. Resolution order ----------

  it('resolveAppUrl prefers the caller-supplied URL over every configured source', async () => {
    const b = await bootstrap('caller');
    await setAuthConfig(b.applicationId, {
      appUrl: 'https://configured.example.com',
      redirectUrls: ['https://redirect.example.com/callback'],
    });
    const application = await load(b.applicationId);
    expect(resolveAppUrl(application as never, 'https://from-caller.example.com')).toBe(
      'https://from-caller.example.com',
    );
  });

  it('resolveAppUrl falls back to the per-Application authConfig.appUrl', async () => {
    const b = await bootstrap('perapp');
    await setAuthConfig(b.applicationId, {
      appUrl: 'https://configured.example.com',
      redirectUrls: ['https://redirect.example.com/callback'],
    });
    const application = await load(b.applicationId);
    expect(resolveAppUrl(application as never)).toBe('https://configured.example.com');
  });

  it('resolveAppUrl infers the origin of the first redirect URL when no appUrl is set', async () => {
    const b = await bootstrap('inferred');
    await setAuthConfig(b.applicationId, {
      redirectUrls: ['https://redirect.example.com/auth/callback?next=/home'],
    });
    const application = await load(b.applicationId);
    // Origin only — the callback path is not where a welcome email should land.
    expect(resolveAppUrl(application as never)).toBe('https://redirect.example.com');
  });

  it('resolveAppUrl skips a junk redirect entry rather than emitting it', async () => {
    const b = await bootstrap('junkredirect');
    await setAuthConfig(b.applicationId, {
      redirectUrls: ['not-a-url', 'https://second.example.com/cb'],
    });
    const application = await load(b.applicationId);
    expect(resolveAppUrl(application as never)).toBe('https://second.example.com');
  });

  it('resolveAppUrl refuses a non-http scheme in authConfig and moves down the chain', async () => {
    const b = await bootstrap('badscheme');
    await setAuthConfig(b.applicationId, {
      // eslint-disable-next-line no-script-url -- exactly what must never reach an href
      appUrl: 'javascript:alert(1)',
      redirectUrls: ['https://safe.example.com/cb'],
    });
    const application = await load(b.applicationId);
    expect(resolveAppUrl(application as never)).toBe('https://safe.example.com');
  });

  it('resolveAppUrl returns null when nothing is configured (no placeholder domain)', async () => {
    const b = await bootstrap('nothing');
    await setAuthConfig(b.applicationId, { redirectUrls: [] });
    const application = await load(b.applicationId);
    // DEFAULT_APP_URL is unset in the test env, so this exercises the last rung.
    expect(resolveAppUrl(application as never)).toBeNull();
  });

  it('resolveAppUrl never yields the old placeholder domain from any input', async () => {
    const b = await bootstrap('noplaceholder');
    await setAuthConfig(b.applicationId, { redirectUrls: [] });
    const application = await load(b.applicationId);
    expect(resolveAppUrl(application as never) ?? '').not.toContain('your-app.example.com');
  });

  it('buildTokenUrl returns the empty string when no base resolved', () => {
    expect(buildTokenUrl(null, '/reset', 'tok')).toBe('');
    expect(buildTokenUrl('https://app.example.com', '/reset', 'a b')).toBe(
      'https://app.example.com/reset?token=a%20b',
    );
  });

  // ---------- 2. Unresolvable ⇒ no button, and never href="" ----------

  it('welcome email renders NO anchor when the app URL is unresolvable', async () => {
    const b = await bootstrap('nobutton');
    await setAuthConfig(b.applicationId, { redirectUrls: [] });
    const rendered = await emailService.renderForEvent(b.applicationId, 'welcome', {
      userEmail: 'nobutton-appurl@example.com',
      appUrl: '',
    });
    expect(rendered.html).not.toContain('href=""');
    expect(rendered.html).not.toContain('your-app.example.com');
    expect(rendered.html).not.toContain('<a ');
    expect(rendered.html).not.toContain('Get started');
    // The rest of the email still arrives intact.
    expect(rendered.html).toContain('nobutton-appurl@example.com');
    expect(rendered.html).toContain('Thanks for signing up');
  });

  it('welcome email renders the button once the app URL resolves', async () => {
    const b = await bootstrap('withbutton');
    await setAuthConfig(b.applicationId, { appUrl: 'https://app.example.com' });
    const application = await load(b.applicationId);
    const rendered = await emailService.renderForEvent(b.applicationId, 'welcome', {
      userEmail: 'withbutton-appurl@example.com',
      appUrl: resolveAppUrl(application as never) ?? '',
    });
    expect(hrefs(rendered.html)).toContain('https://app.example.com');
    expect(rendered.html).toContain('Get started');
  });

  it('no default template can emit an empty href for any of its URL variables', async () => {
    const b = await bootstrap('allevents');
    const urlVars: Record<string, string> = {
      password_reset: 'resetUrl',
      email_verification: 'verifyUrl',
      magic_link_signin: 'signInUrl',
      workspace_invitation: 'inviteUrl',
      welcome: 'appUrl',
    };
    for (const eventKey of Object.keys(urlVars)) {
      const rendered = await emailService.renderForEvent(b.applicationId, eventKey, {
        // Deliberately supply NOTHING — every variable resolves to ''.
      });
      expect(hrefs(rendered.html), `${eventKey} emitted an href`).toEqual([]);
      expect(rendered.html, `${eventKey} kept a placeholder domain`).not.toContain('example.com/');
    }
  });

  it('the plain-text alternative carries no dead link either', async () => {
    const b = await bootstrap('plaintext');
    const rendered = await emailService.renderForEvent(b.applicationId, 'welcome', {
      userEmail: 'plaintext-appurl@example.com',
    });
    expect(rendered.text).not.toContain('your-app.example.com');
    expect(rendered.text).not.toContain('href');
  });

  // ---------- 3. The render engine itself ----------

  it('{{#if var}} keeps the section when the variable has a value', () => {
    const out = renderTemplate(
      '{{#if url}}<a href="{{url}}">go</a>{{/if}}',
      { url: 'https://app.example.com' },
      { escape: true },
    );
    expect(out).toBe('<a href="https://app.example.com">go</a>');
  });

  it('{{#if var}} drops the section when the variable is empty or absent', () => {
    expect(
      renderTemplate('before{{#if url}}<a href="{{url}}">go</a>{{/if}}after', { url: '' }, { escape: true }),
    ).toBe('beforeafter');
    expect(
      renderTemplate('before{{#if url}}<a href="{{url}}">go</a>{{/if}}after', {}, { escape: true }),
    ).toBe('beforeafter');
    // Whitespace-only is not a URL.
    expect(
      renderTemplate('{{#if url}}yes{{/if}}', { url: '   ' }, { escape: true }),
    ).toBe('');
  });

  it('an unmatched {{#if}} is left verbatim instead of swallowing the document', () => {
    const out = renderTemplate('{{#if url}}tail of the email', { url: 'x' }, { escape: false });
    expect(out).toContain('tail of the email');
  });

  it('stripEmptyHrefAnchors rescues a saved custom template that still uses a bare {{appUrl}}', () => {
    // Templates operators saved BEFORE {{#if}} existed keep their stored HTML
    // verbatim; no new syntax retroactively edits an EmailTemplate row. The
    // post-render sweep is what stops those rows shipping `href=""`.
    const out = renderTemplate(
      '<p>Hi</p><a href="{{appUrl}}" class="btn">Get started</a><p>Bye</p>',
      { appUrl: '' },
      { escape: true },
    );
    expect(out).toContain('href=""');
    const swept = stripEmptyHrefAnchors(out);
    expect(swept).not.toContain('href=""');
    expect(swept).not.toContain('<a ');
    // The label survives as plain text — the sentence still reads.
    expect(swept).toBe('<p>Hi</p>Get started<p>Bye</p>');
  });

  it('a saved custom template with a bare {{appUrl}} emits no dead link end-to-end', async () => {
    const b = await bootstrap('savedcustom');
    await emailService.setTemplate({
      applicationId: b.applicationId,
      eventKey: 'welcome',
      subject: 'Welcome aboard',
      designJson: {},
      bodyHtml: '<p>Hi {{userEmail}}</p><a href="{{appUrl}}">Get started</a>',
    });
    const rendered = await emailService.renderForEvent(b.applicationId, 'welcome', {
      userEmail: 'savedcustom-appurl@example.com',
      appUrl: '',
    });
    expect(rendered.customised).toBe(true);
    expect(rendered.html).not.toContain('href=""');
    expect(hrefs(rendered.html)).toEqual([]);
    expect(rendered.html).toContain('savedcustom-appurl@example.com');
  });

  it('the empty-href sweep cannot be triggered by a hostile variable value', () => {
    // A value can't forge an href boundary: quotes are escaped before the
    // sweep runs, so the surrounding anchor stays intact.
    const out = renderTemplate(
      '<a href="https://app.example.com">{{name}}</a>',
      { name: '" onclick="alert(1)' },
      { escape: true },
    );
    const swept = stripEmptyHrefAnchors(out);
    expect(swept).toContain('href="https://app.example.com"');
    expect(swept).not.toContain('onclick="alert(1)"');
  });

  // ---------- 4. Panel-facing write path ----------

  it('PATCH /auth-config stores appUrl and clears it with an empty string', async () => {
    const b = await bootstrap('patch');
    const set = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { appUrl: 'https://patched.example.com' },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json().data.authConfig as { appUrl?: string }).appUrl).toBe(
      'https://patched.example.com',
    );

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { appUrl: '' },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json().data.authConfig as { appUrl?: string }).appUrl).toBeUndefined();
  });

  it('PATCH /auth-config rejects a non-URL appUrl', async () => {
    const b = await bootstrap('badpatch');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { appUrl: 'app.example.com' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const application = await load(b.applicationId);
    expect((application.authConfig as { appUrl?: string }).appUrl).toBeUndefined();
  });

  it('an unrelated auth-config patch leaves a stored appUrl alone', async () => {
    const b = await bootstrap('preserve');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { appUrl: 'https://preserved.example.com' },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { passwordMinLength: 12 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data.authConfig as { appUrl?: string }).appUrl).toBe(
      'https://preserved.example.com',
    );
  });

  // ---------- 5. The live sign-up path ----------

  it('sign-up sends a welcome email whose link comes from the resolution chain', async () => {
    const b = await bootstrap('signup');
    await setAuthConfig(b.applicationId, { appUrl: 'https://signup-app.example.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'signup-appurl@example.com', password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);

    // The send itself is fire-and-forget with no transport in tests, so assert
    // on what the resolver hands the template rather than on delivery.
    const application = await load(b.applicationId);
    const rendered = await emailService.renderForEvent(b.applicationId, 'welcome', {
      userEmail: 'signup-appurl@example.com',
      appUrl: resolveAppUrl(application as never) ?? '',
    });
    expect(hrefs(rendered.html)).toEqual(['https://signup-app.example.com']);
  });
});
