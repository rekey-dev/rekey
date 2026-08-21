import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  authConfigVisible,
  portalDomainUnverified,
  signInReachable,
} from '../src/lib/auth-config';
import { ApplicationStatusBadges } from '../src/components/ApplicationStatusBadges';

/**
 * Rendered through `createElement` rather than JSX so this file stays `.ts` and
 * inside the suite's `test/**\/*.test.ts` glob. Naming it `.tsx` silently drops
 * it from the run, which reads as a passing suite.
 */

const live = (over: Record<string, unknown> = {}): never =>
  ({
    authConfig: { methods: ['password'] },
    oauthConfig: {},
    disabledAt: null,
    disabledReason: null,
    hostedPortalEnabled: false,
    portalDomain: null,
    portalDomainVerifiedAt: null,
    ...over,
  }) as never;

describe('authConfigVisible', () => {
  it('is true for a real config, including an OAuth-only one', () => {
    expect(authConfigVisible(live())).toBe(true);
    expect(authConfigVisible(live({ authConfig: { methods: [] } }))).toBe(true);
  });

  // An APP_BILLING operator gets `authConfig: {}` from
  // `redactApplicationForBilling`. Redacted and "configured with nothing" are
  // identical on the wire apart from this, and treating the first as the second
  // reports every healthy application in the workspace as broken.
  it('is false when the config was redacted away', () => {
    expect(authConfigVisible(live({ authConfig: {} }))).toBe(false);
  });
});

describe('signInReachable', () => {
  it('is true for a primary method', () => {
    expect(signInReachable(live())).toBe(true);
  });

  // `AuthConfigSchema` documents empty `methods` as an OAuth-only application.
  it('is true for OAuth only', () => {
    expect(
      signInReachable(live({ authConfig: { methods: [] }, oauthConfig: { google: {} } })),
    ).toBe(true);
  });

  it('is false only when both halves are empty', () => {
    expect(signInReachable(live({ authConfig: { methods: [] } }))).toBe(false);
  });
});

describe('portalDomainUnverified', () => {
  it('fires for an enabled portal on an unverified custom domain', () => {
    expect(
      portalDomainUnverified(
        live({ hostedPortalEnabled: true, portalDomain: 'portal.acme.example' }),
      ),
    ).toBe(true);
  });

  it('does not fire once verified', () => {
    expect(
      portalDomainUnverified(
        live({
          hostedPortalEnabled: true,
          portalDomain: 'portal.acme.example',
          portalDomainVerifiedAt: '2026-08-20T12:00:00.000Z',
        }),
      ),
    ).toBe(false);
  });

  // The default path: portal on, no custom domain, served on the shared host.
  it('does not fire without a custom domain', () => {
    expect(portalDomainUnverified(live({ hostedPortalEnabled: true }))).toBe(false);
  });

  it('does not fire when the portal is off', () => {
    expect(portalDomainUnverified(live({ portalDomain: 'portal.acme.example' }))).toBe(false);
  });
});

describe('ApplicationStatusBadges', () => {
  const render = (app: unknown): string =>
    renderToStaticMarkup(createElement(ApplicationStatusBadges, { app: app as never }));

  it('renders nothing for a healthy application', () => {
    expect(render(live())).toBe('');
  });

  // Configuration is not a fault. Both of these are whole-workspace postures
  // and would chip every row, so neither earns a badge.
  it('renders nothing for invite-only or secret-key-only sign-up', () => {
    expect(render(live({ authConfig: { methods: ['password'], signupMode: 'invite_only' } }))).toBe('');
    expect(render(live({ authConfig: { methods: ['password'], signupMode: 'secret_only' } }))).toBe('');
    // Including the legacy encoding that predates `signupMode`.
    expect(render(live({ authConfig: { methods: ['password'], signupEnabled: false } }))).toBe('');
  });

  it('renders nothing when the config was redacted for a billing manager', () => {
    expect(render(live({ authConfig: {}, oauthConfig: {} }))).toBe('');
  });

  it('warns when nobody can sign in', () => {
    expect(render(live({ authConfig: { methods: [] } }))).toContain('No sign-in');
  });

  it('does not warn on an OAuth-only application', () => {
    expect(render(live({ authConfig: { methods: [] }, oauthConfig: { google: {} } }))).toBe('');
  });

  it('reports a frozen application, and nothing else', () => {
    const html = render(
      live({
        authConfig: { methods: [] },
        disabledAt: '2026-08-20T12:00:00.000Z',
        hostedPortalEnabled: true,
        portalDomain: 'portal.acme.example',
      }),
    );
    expect(html).toContain('Disabled');
    // Both others would otherwise fire; stacking chips buries the one that matters.
    expect(html).not.toContain('No sign-in');
    expect(html).not.toContain('Portal domain unverified');
  });

  // `redactApplicationForBilling` blanks authConfig/oauthConfig and nothing
  // else, so the freeze must survive the guard that silences the rest.
  it('shows the freeze to a billing manager, whose authConfig was redacted', () => {
    expect(render(live({ authConfig: {}, disabledAt: '2026-08-20T12:00:00.000Z' }))).toContain(
      'Disabled',
    );
  });

  it('carries the operator note as a tooltip, not as visible copy', () => {
    // `DisableAppBody` allows 500 characters. Rendered as badge text that blows
    // the row out, so asserting the bare string cannot tell the two apart.
    expect(
      render(
        live({ disabledAt: '2026-08-20T12:00:00.000Z', disabledReason: 'Migrating workspace' }),
      ),
    ).toContain('title="Migrating workspace"');
  });

  it('flags an unverified portal domain on a live application', () => {
    expect(
      render(live({ hostedPortalEnabled: true, portalDomain: 'portal.acme.example' })),
    ).toContain('Portal domain unverified');
  });
});
