/**
 * `<SignIn>` / `<SignUp>` render the Application's enabled OAuth providers
 * (#463) when no `oauthProviders` prop is given and a start target is. The
 * contract: the prop always wins, no start target means no request (what every
 * existing integration renders today), and a failed or impossible fetch
 * renders the card without buttons rather than breaking it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { RekeyProvider } from '../src/context.js';
import { SignIn, SignUp } from '../src/auth-components.js';

const API = 'https://api.example.test';
const PUB = 'rp_pub_test_key';

function stubProviders(providers: Array<{ id: string; name: string }>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ success: true, data: { providers } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// A fresh provider per test: the provider list is cached per client instance,
// and each <RekeyProvider> mount makes its own client.
const wrap = (node: React.ReactNode, publishableKey: string | null = PUB) => (
  <RekeyProvider apiUrl={API} {...(publishableKey !== null && { publishableKey })}>
    {node}
  </RekeyProvider>
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OAuth providers fetched for <SignIn>', () => {
  it('fetches the enabled providers with the publishable key and links each to the start URL', async () => {
    const fetchMock = stubProviders([
      { id: 'google', name: 'Google' },
      { id: 'github', name: 'GitHub' },
    ]);
    render(wrap(<SignIn action={vi.fn()} oauthStartUrl="/api/auth/oauth/{provider}/start" />));

    const google = await screen.findByText('Continue with Google');
    expect(google.getAttribute('href')).toBe('/api/auth/oauth/google/start');
    expect(screen.getByText('Continue with GitHub').getAttribute('href')).toBe('/api/auth/oauth/github/start');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/api/v1/auth/oauth/providers`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${PUB}`);
  });

  it('posts the provider id to a start Server Action', async () => {
    stubProviders([{ id: 'discord', name: 'Discord' }]);
    const { container } = render(wrap(<SignIn action={vi.fn()} oauthStartAction={vi.fn()} />));
    await screen.findByText('Continue with Discord');
    const hidden = container.querySelector('input[type="hidden"][name="provider"]') as HTMLInputElement;
    expect(hidden.value).toBe('discord');
  });

  it('lets the oauthProviders prop override the fetch entirely', async () => {
    const fetchMock = stubProviders([{ id: 'google', name: 'Google' }]);
    render(
      wrap(
        <SignIn
          action={vi.fn()}
          oauthStartUrl="/start/{provider}"
          oauthProviders={[{ provider: 'gitlab', startUrl: '/gl' }]}
        />,
      ),
    );
    expect(screen.getByText('Continue with Gitlab')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Continue with Google')).toBeNull();
  });

  it('does not fetch without a start target, so existing cards are unchanged', async () => {
    const fetchMock = stubProviders([{ id: 'google', name: 'Google' }]);
    render(wrap(<SignIn action={vi.fn()} />));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/continue with/i)).toBeNull();
  });

  it('renders the card without buttons when the request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    render(wrap(<SignIn action={vi.fn()} oauthStartUrl="/s/{provider}" />));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryByText(/continue with/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeNull();
  });

  it('renders no buttons and makes no request without a publishable key or a provider', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = stubProviders([{ id: 'google', name: 'Google' }]);
    render(wrap(<SignIn action={vi.fn()} oauthStartUrl="/s/{provider}" />, null));
    render(<SignIn action={vi.fn()} oauthStartUrl="/s/{provider}" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/continue with/i)).toBeNull();
    warn.mockRestore();
  });

  it('server-renders without fetching', () => {
    const fetchMock = stubProviders([{ id: 'google', name: 'Google' }]);
    const html = renderToString(wrap(<SignIn actionUrl="/sign-in" oauthStartUrl="/s/{provider}" />));
    expect(html).toContain('action="/sign-in"');
    expect(html).not.toContain('Continue with');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warns when oauthStartUrl has no {provider} placeholder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubProviders([{ id: 'google', name: 'Google' }]);
    render(wrap(<SignIn action={vi.fn()} oauthStartUrl="/oauth/start" />));
    await screen.findByText('Continue with Google');
    expect(warn.mock.calls.some(([m]) => String(m).includes('has no {provider}'))).toBe(true);

    warn.mockClear();
    render(wrap(<SignIn action={vi.fn()} oauthStartUrl="/oauth/{provider}/start" />));
    await new Promise((r) => setTimeout(r, 20));
    expect(warn.mock.calls.some(([m]) => String(m).includes('has no {provider}'))).toBe(false);
  });

  it('works the same on <SignUp>', async () => {
    stubProviders([{ id: 'google', name: 'Google' }]);
    render(wrap(<SignUp action={vi.fn()} oauthStartUrl="/up/{provider}" />));
    expect((await screen.findByText('Continue with Google')).getAttribute('href')).toBe('/up/google');
  });
});
