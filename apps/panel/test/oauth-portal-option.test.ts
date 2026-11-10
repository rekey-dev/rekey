/**
 * Offering a sign-in provider in the hosted portal: the choice and the portal
 * page to register appear only while the portal is on, and a saved choice
 * survives a save made while it is off.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OAuthPortalOption } from '../src/components/OAuthPortalOption';
import { portalSignInUrls } from '../src/lib/oauth-portal';

const APP = {
  slug: 'acme',
  hostedPortalEnabled: true,
  portalDomain: null,
  portalDomainVerifiedAt: null,
  portalBaseUrl: 'https://portal.example',
};

const render = (props: Partial<Parameters<typeof OAuthPortalOption>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(OAuthPortalOption, {
      providerLabel: 'Google',
      portalUrls: portalSignInUrls(APP),
      offered: false,
      singleCallbackHost: false,
      ...props,
    }),
  );

describe('the portal sign-in pages to register', () => {
  it('names the shared host page, and the custom domain page once that domain is verified', () => {
    expect(portalSignInUrls(APP)).toEqual(['https://portal.example/acme/oauth/callback']);
    expect(portalSignInUrls({ ...APP, portalDomain: 'billing.acme.test' })).toHaveLength(1);
    expect(portalSignInUrls({ ...APP, portalDomain: 'billing.acme.test', portalDomainVerifiedAt: '2026-11-01T00:00:00Z' })).toEqual([
      'https://portal.example/acme/oauth/callback',
      'https://billing.acme.test/oauth/callback',
    ]);
  });

  it('names none while the portal is off', () => {
    expect(portalSignInUrls({ ...APP, hostedPortalEnabled: false })).toEqual([]);
  });
});

describe('the "Offer in the hosted portal" choice', () => {
  it('with the portal on, is a checkbox beside the page to register, with a copy button', () => {
    const html = render({ offered: true });
    expect(html).toMatch(/<input type="checkbox" name="hostedPortal" checked=""\/>Offer in the hosted portal/);
    expect(html).toContain('https://portal.example/acme/oauth/callback');
    expect(html).toContain('Copy');
  });

  it('with the portal off, is not shown, and carries a saved choice through the form', () => {
    const off = { portalUrls: portalSignInUrls({ ...APP, hostedPortalEnabled: false }) };
    expect(render(off)).toBe('');
    expect(render({ ...off, offered: true })).toBe('<input type="hidden" name="hostedPortal" value="on"/>');
  });

  it('warns that a single-callback-host app cannot serve the portal too', () => {
    expect(render({ providerLabel: 'GitHub', singleCallbackHost: true })).toContain('allows a single callback host');
    expect(render()).not.toContain('single callback host');
  });
});
