/**
 * <RekeyProvider> + hooks — the source of the auth state every control/auth
 * widget reads. We test the provider for real (no mocking of itself) so the
 * seams the components depend on are pinned:
 *   - initialUser seeds a signed-in, non-loading state synchronously (the SSR
 *     pattern) — no protected-UI flash;
 *   - a null access token resolves to signed-out, not loading;
 *   - useUser() throws a helpful error outside the provider.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { RekeyProvider } from '../src/context.js';
import { useUser } from '../src/hooks.js';
import type { EndUserDto } from '@rekey.dev/shared-types';

const user: EndUserDto = {
  id: 'eu_1',
  applicationId: 'app_1',
  email: 'seed@example.com',
  emailVerified: true,
  metadata: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function Probe(): React.JSX.Element {
  const { user, signedIn, loading } = useUser();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="signedIn">{String(signedIn)}</span>
      <span data-testid="email">{user?.email ?? '(none)'}</span>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe('<RekeyProvider> seed states', () => {
  it('seeds a signed-in, settled state from initialUser (SSR path)', () => {
    render(
      <RekeyProvider apiUrl="https://api.example.com" initialUser={user} accessToken="tok_abc">
        <Probe />
      </RekeyProvider>,
    );
    expect(screen.getByTestId('signedIn').textContent).toBe('true');
    expect(screen.getByTestId('email').textContent).toBe('seed@example.com');
  });

  it('resolves to signed-out (not loading) when there is no access token', async () => {
    render(
      <RekeyProvider apiUrl="https://api.example.com" accessToken={null}>
        <Probe />
      </RekeyProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('signedIn').textContent).toBe('false');
    expect(screen.getByTestId('email').textContent).toBe('(none)');
  });

  it('fetches the current user on mount when only an access token is given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: user }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(
      <RekeyProvider apiUrl="https://api.example.com" accessToken="tok_abc">
        <Probe />
      </RekeyProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('signedIn').textContent).toBe('true');
    });
    expect(screen.getByTestId('email').textContent).toBe('seed@example.com');
    // Hits the user-token-only endpoint with the JWT header, no secret key.
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/auth/me');
    expect((init?.headers as Record<string, string>)['X-Rekey-User-Token']).toBe('tok_abc');
  });

  it('treats a failed user fetch as signed-out (no throw to the UI)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { code: 'USER_TOKEN_INVALID', message: 'nope' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    render(
      <RekeyProvider apiUrl="https://api.example.com" accessToken="bad_tok">
        <Probe />
      </RekeyProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('signedIn').textContent).toBe('false');
  });
});

describe('hooks outside the provider', () => {
  it('useUser() throws a helpful error when used without <RekeyProvider>', () => {
    // Silence the expected React error boundary console noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/RekeyProvider/);
    spy.mockRestore();
  });
});
