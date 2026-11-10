/**
 * Required profile questions: a signed-in customer who has not answered them
 * is sent to answer them before any account page, and answers are checked on
 * the server before saving. The inputs themselves are the profile page's,
 * covered in profile-page.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileField } from '@rekey.dev/shared-types';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'rekey_portal_access' ? { name, value: 'at' } : undefined) }),
  headers: async () => new Headers(),
}));
const config = { slug: 'acme', name: 'Acme', publishableKey: 'rp_pub_test', branding: {}, auth: {} };
vi.mock('@/lib/config', () => ({
  getPortalConfig: async () => config,
  PortalConfigUnavailableError: class extends Error {},
}));
vi.mock('@/lib/env', () => ({ portalBaseUrl: () => 'https://portal.example', rekeyApiUrl: () => 'https://api.example' }));
vi.mock('@/lib/client-ip', () => ({
  API_TIMEOUT_MS: 1000,
  forwardedClientHeaders: async () => ({}),
  publishableKeyCallHeaders: async () => ({}),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const { outstandingProfileFields, readProfileForm, profileInputName } = await import('@/lib/profile-form');
const { redirectWhileProfileOutstanding } = await import('@/lib/profile-completion');
const { customerCall } = await import('@/lib/customer-call');
const { saveProfileAction } = await import('@/lib/profile-completion-actions');

function field(over: Partial<ProfileField> & Pick<ProfileField, 'key' | 'type'>): ProfileField {
  return {
    label: over.key,
    requiredForOnboarding: false,
    writableBy: 'user',
    showInList: false,
    pii: false,
    ...over,
  } as ProfileField;
}

const FIELDS: ProfileField[] = [
  field({ key: 'company', type: 'text', label: 'Company', requiredForOnboarding: true }),
  field({ key: 'team_size', type: 'select', label: 'Team size', options: ['1', '2-10'], requiredForOnboarding: true }),
  field({ key: 'seats', type: 'number', label: 'Seats' }),
  field({ key: 'newsletter', type: 'boolean', label: 'Newsletter', requiredForOnboarding: true }),
  field({ key: 'site', type: 'url', label: 'Website' }),
  field({ key: 'birthday', type: 'date', label: 'Birthday' }),
];

const calls: Array<{ url: string; method: string; body: unknown }> = [];

function serve(routes: Record<string, () => Response>): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${new URL(url).pathname}`];
    return route ? route() : new Response('{}', { status: 404 });
  });
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const schema = (fields: ProfileField[]) => json(200, { success: true, data: { fields } });

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('which questions are still owed', () => {
  it('counts a required question with no answer, and any stored answer as answered, false included', () => {
    expect(outstandingProfileFields(FIELDS, { company: 'Acme', newsletter: false }).map((f) => f.key)).toEqual([
      'team_size',
    ]);
  });

  it('never counts a question only the server may answer', () => {
    const serverOnly = field({ key: 'tier', type: 'text', requiredForOnboarding: true, writableBy: 'server' });
    expect(outstandingProfileFields([serverOnly], {})).toEqual([]);
  });
});

describe('the guard on account pages', () => {
  it('sends a customer with an unanswered required question to the questions, carrying the page back', async () => {
    serve({ 'GET /api/v1/profile-schema': schema(FIELDS) });
    await expect(redirectWhileProfileOutstanding('acme', { profile: {} }, 'devices')).rejects.toThrow(
      'REDIRECT /acme/profile/complete?return=devices',
    );
  });

  it('lets a customer through when the questions cannot be read', async () => {
    serve({ 'GET /api/v1/profile-schema': json(503, {}) });
    await expect(redirectWhileProfileOutstanding('acme', { profile: {} }, null)).resolves.toBeUndefined();
  });

  it('sends a call refused with PROFILE_INCOMPLETE to the questions', async () => {
    serve({
      'POST /api/v1/users/me/onboarding/complete': json(409, { success: false, error: { code: 'PROFILE_INCOMPLETE' } }),
    });
    await expect(customerCall(config as never, 'at', 'POST', '/api/v1/users/me/onboarding/complete', {})).rejects.toThrow(
      'REDIRECT /acme/profile/complete',
    );
  });
});

describe('reading first-run answers', () => {
  function form(values: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(profileInputName(k), v);
    return f;
  }

  it('refuses a missing required answer and each malformed one, under its own field', () => {
    const read = readProfileForm(
      FIELDS,
      {},
      form({ company: '', team_size: 'huge', seats: 'many', newsletter: '', site: 'ftp://x', birthday: '2023-02-30' }),
      { requireOnboarding: true },
    );
    expect(Object.keys(read.errors).sort()).toEqual(['birthday', 'company', 'newsletter', 'seats', 'site', 'team_size']);
    expect(read.errors.company).toBe('Answer this question to continue.');
    expect(read.draft.seats).toBe('many');
  });

  it('lets the profile page leave a required answer empty', () => {
    expect(readProfileForm(FIELDS.slice(0, 1), { company: 'Acme' }, form({ company: '' })).patch).toEqual({ company: null });
  });
});

describe('saving answers', () => {
  const empty = { errors: {}, formError: null, values: {} };
  function submission(values: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(values)) f.set(profileInputName(k), v);
    return f;
  }

  it('returns refusals to the form without saving anything', async () => {
    serve({ 'GET /api/v1/profile-schema': schema(FIELDS) });
    const state = await saveProfileAction('acme', null, empty, submission({ company: '' }));
    expect(state.errors.company).toBe('Answer this question to continue.');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('saves the answers, records onboarding complete, and goes on to the page sign-in was headed for', async () => {
    serve({
      'GET /api/v1/profile-schema': schema(FIELDS.slice(0, 2)),
      'PATCH /api/v1/users/me/profile': json(200, { success: true, data: {} }),
      'POST /api/v1/users/me/onboarding/complete': json(200, { success: true, data: {} }),
    });
    await expect(
      saveProfileAction('acme', 'devices', empty, submission({ company: 'Acme', team_size: '1' })),
    ).rejects.toThrow('REDIRECT /acme/devices');
    expect(calls.slice(1).map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ['PATCH', '/api/v1/users/me/profile', { company: 'Acme', team_size: '1' }],
      ['POST', '/api/v1/users/me/onboarding/complete', {}],
    ]);
  });
});
