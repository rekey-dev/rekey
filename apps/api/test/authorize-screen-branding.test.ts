/**
 * The sign-in screen carries the Application's own branding.
 *
 * That branding is operator-authored JSON with no schema at rest, and it now
 * reaches two places where a raw value would be dangerous: `logoUrl` lands in
 * an `<img src>`, and `primaryColor` lands inside a `<style>` block. This is
 * the sign-in page — the single worst place in the product to execute
 * attacker-controlled script, because it is where people type passwords.
 *
 * An operator branding their own Application is not the threat. The threat is
 * an operator branding an Application whose end-users are somebody else's
 * customers, and a stored value that survives from a settings form to every
 * customer's credential prompt.
 *
 * So: only http(s) URLs and only plain hex colours survive; anything else
 * degrades to the unbranded screen rather than being interpolated.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('authorize screen branding', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** An OIDC-enabled Application with a registered client, plus branding. */
  async function fixture(slug: string, branding: Record<string, unknown>) {
    const token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/auth-config`,
      headers: { authorization: `Bearer ${token}` },
      payload: { oidcEnabled: true },
    });
    await prisma.application.update({
      where: { id: applicationId },
      data: { portalBranding: branding as never },
    });

    const client = await prisma.oAuthClient.create({
      data: {
        applicationId,
        clientName: 'Test client',
        redirectUris: ['https://client.test/cb'],
      },
    });
    return { slug, clientId: client.id };
  }

  const authorize = (slug: string, clientId: string) =>
    app.inject({
      method: 'GET',
      url:
        `/api/v1/mcp/${slug}/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent('https://client.test/cb')}` +
        `&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&scope=openid`,
    });

  it('shows the Application display name and logo', async () => {
    const f = await fixture('brand-ok', {
      displayName: 'Acme Industries',
      logoUrl: 'https://cdn.example.com/acme.png',
      primaryColor: '#ff5533',
    });
    const res = await authorize(f.slug, f.clientId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Acme Industries');
    expect(res.body).toContain('https://cdn.example.com/acme.png');
    expect(res.body).toContain('#ff5533');
  });

  it('drops a javascript: logo rather than rendering it', async () => {
    // The one that matters. A stored `javascript:` URL in an <img src> is
    // script execution on a password prompt.
    const f = await fixture('brand-js', { logoUrl: 'javascript:alert(1)' });
    const res = await authorize(f.slug, f.clientId);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('javascript:');
    expect(res.body).not.toContain('alert(1)');
  });

  it('drops a data: logo too', async () => {
    const f = await fixture('brand-data', {
      logoUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    });
    const res = await authorize(f.slug, f.clientId);
    expect(res.body).not.toContain('data:text/html');
  });

  it('refuses a colour that is not a plain hex value', async () => {
    // Anything else would be interpolated straight into a <style> block.
    const f = await fixture('brand-css', {
      primaryColor: 'red;} body{display:none} .x{color:red',
    });
    const res = await authorize(f.slug, f.clientId);
    expect(res.body).not.toContain('display:none');
    // Falls back to the default accent rather than dropping styling entirely.
    expect(res.body).toContain('#0d9488');
  });

  it("sends a CSP whose form-action allows the client's redirect origin", async () => {
    // The bug this exists for: the deployment-wide policy is
    // `form-action 'self'`, and browsers enforce form-action ACROSS the
    // redirect a submission triggers. This page is served by the API and must
    // redirect to the relying party's origin, so the browser silently refused
    // the navigation — a correct 302 that went nowhere, with nothing in any
    // server log. Every headless test passed throughout, because curl and
    // `app.inject` do not enforce CSP. Hence this test asserts the HEADER
    // rather than the behaviour.
    const f = await fixture('brand-csp', {});
    const res = await authorize(f.slug, f.clientId);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp, 'the page must send its own policy').toBeTruthy();
    expect(csp).toContain("form-action 'self' https://client.test");
    // The logo is a remote https image; the default policy's `img-src 'self'
    // data:` would drop it.
    expect(csp).toContain('img-src');
    expect(csp).toMatch(/img-src[^;]*https:/);
    // The inline script that acknowledges a click needs its nonce.
    const nonce = /script-src[^;]*'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, 'script-src must carry a nonce').toBeTruthy();
    expect(res.body).toContain(`nonce="${nonce}"`);
  });

  it('renders the plain screen when there is no branding at all', async () => {
    const f = await fixture('brand-none', {});
    const res = await authorize(f.slug, f.clientId);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('App brand-none');
    expect(res.body).not.toContain('<img class="logo"');
  });
});
