/**
 * Methods and OAuth clients both PATCH the same auth-config. Each form must
 * send only the fields it shows, or saving one page writes back a stale copy
 * of the other page's settings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { path: string; body: Record<string, unknown> }[] = [];

vi.mock('@/lib/api', () => ({
  api: vi.fn(async (req: { path: string; body: Record<string, unknown> }) => {
    calls.push({ path: req.path, body: req.body });
    return {};
  }),
  errorQuery: vi.fn(async () => 'error=X'),
  PanelApiError: class extends Error {},
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import { saveAuth } from '../src/app/(authed)/applications/[id]/auth/actions';
import { saveOidcProvider } from '../src/app/(authed)/applications/[id]/oauth-clients/actions';

const OIDC_FIELDS = ['oidcEnabled', 'hostedAuthorizeUrl'];

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe('auth-config saves stay on their own fields', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('Methods never sends the OpenID Connect provider fields, even if posted', async () => {
    await expect(
      saveAuth(
        'app_1',
        form({
          method_password: 'on',
          passwordMinLength: '12',
          oidcEnabled: 'on',
          hostedAuthorizeUrl: 'https://evil.example/authorize',
        }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT:/applications/app_1/auth?saved=1');
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    for (const f of OIDC_FIELDS) expect(body).not.toHaveProperty(f);
    expect(body).toMatchObject({ methods: ['password'], passwordMinLength: 12 });
  });

  it('the OAuth clients form sends exactly the two OpenID Connect fields', async () => {
    await expect(
      saveOidcProvider(
        'app_1',
        form({ oidcEnabled: 'on', hostedAuthorizeUrl: ' https://app.example/authorize ', passwordMinLength: '30' }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT:/applications/app_1/oauth-clients?e=oidc_saved');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/v1/tenant/applications/app_1/auth-config');
    expect(calls[0]!.body).toEqual({ oidcEnabled: true, hostedAuthorizeUrl: 'https://app.example/authorize' });
  });

  it('an unticked switch and an empty URL turn the provider off and clear the page', async () => {
    await expect(saveOidcProvider('app_1', form({ hostedAuthorizeUrl: '' }))).rejects.toThrow('NEXT_REDIRECT');
    expect(calls[0]!.body).toEqual({ oidcEnabled: false, hostedAuthorizeUrl: '' });
  });
});
