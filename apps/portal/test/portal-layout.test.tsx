/**
 * Every page under /<slug> sits in one main landmark, after the header. The
 * header carries the brand, and for a signed-in customer the account sections,
 * their address and sign out.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state: {
  user: { user: { email: string }; accessToken: string } | null;
  config: Record<string, unknown>;
  pathname: string;
} = { user: null, config: {}, pathname: '/acme' };

vi.mock('@/lib/session', () => ({
  getPortalConfigOrRefresh: async () => state.config,
  getPortalUser: async () => state.user,
}));
vi.mock('@/lib/actions', () => ({ signOutAction: async () => undefined }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT FOUND');
  },
  usePathname: () => state.pathname,
}));

const { default: SlugLayout } = await import('@/app/(portal)/[slug]/layout');

async function render(): Promise<string> {
  const element = await SlugLayout({ children: <p>page body</p>, params: Promise.resolve({ slug: 'acme' }) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  state.user = null;
  state.pathname = '/acme';
  state.config = { name: 'Acme', branding: {}, auth: { devices: false } };
});

describe('the portal layout', () => {
  it('puts the page in exactly one main landmark, outside the header', async () => {
    const html = await render();
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html).toContain('<main><p>page body</p></main>');
    expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('<main'));
  });

  it('shows only the brand to a signed-out visitor', async () => {
    const html = await render();
    expect(html).toContain('Acme');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('Sign out');
  });

  it('gives a signed-in customer the sections they can use, the current one marked', async () => {
    state.user = { user: { email: 'pat@example.com' }, accessToken: 'at' };
    let html = await render();
    expect(html).toContain('<a aria-current="page"');
    expect(html).toMatch(/aria-current="page"[^>]*>Overview</);
    expect(html).not.toContain('Devices');

    state.config = { ...state.config, auth: { devices: true } };
    state.pathname = '/acme/devices';
    html = await render();
    expect(html).toMatch(/aria-current="page"[^>]*>Devices</);
    expect(html).not.toMatch(/aria-current="page"[^>]*>Overview</);
  });

  it('keeps the signed-in address visible at every width, truncated rather than hidden', async () => {
    state.user = { user: { email: 'pat@example.com' }, accessToken: 'at' };
    const html = await render();
    const email = /<span class="([^"]*)" title="pat@example.com">pat@example.com<\/span>/.exec(html);
    expect(email?.[1]).toContain('truncate');
    expect(email?.[1]).not.toContain('hidden');
  });

  it('follows the dark preference only when the operator chose no colour', async () => {
    expect(await render()).toContain('data-scheme="auto"');
    state.config = { name: 'Acme', auth: {}, branding: { primaryColor: '#0f766e' } };
    const html = await render();
    expect(html).toContain('data-scheme="light"');
    expect(html).toContain('--color-primary-hover:color-mix(in srgb, #0f766e 85%, black)');
  });

  it('links the terms and privacy pages the operator set, and only valid ones', async () => {
    let html = await render();
    expect(html).not.toContain('<footer');
    state.config = {
      name: 'Acme',
      auth: {},
      branding: { termsUrl: 'https://acme.test/terms', privacyUrl: 'javascript:alert(1)' },
    };
    html = await render();
    expect(html).toContain('href="https://acme.test/terms"');
    expect(html).not.toContain('Privacy');
  });
});
